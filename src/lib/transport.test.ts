import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransportError, desktopBridge, isDesktop, isRpcErrorObject, postHg } from './transport'

describe('isRpcErrorObject', () => {
  it('accepts the plain error objects rpc() rejects with', () => {
    expect(isRpcErrorObject({ code: -32601, message: '不允许调用这个方法' })).toBe(true)
    expect(isRpcErrorObject({ code: -32000, message: '超时', data: { kind: 'timeout' } })).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isRpcErrorObject(new Error('x'))).toBe(false)
    expect(isRpcErrorObject({ code: '1', message: 'x' })).toBe(false)
    expect(isRpcErrorObject({ code: 1.5, message: 'x' })).toBe(false)
    expect(isRpcErrorObject(null)).toBe(false)
    expect(isRpcErrorObject('x')).toBe(false)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('postHg', () => {
  it('posts the envelope to the same-origin Worker route', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await postHg('ak', '/user/api/inquiry/gacha/history', '{"query":{"page":"1"}}')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/hg/ak/user/api/inquiry/gacha/history')
    expect(init).toMatchObject({ method: 'POST', body: '{"query":{"page":"1"}}', credentials: 'same-origin' })
    expect(init.headers).toMatchObject({ 'x-arkrecord-client': '1', 'content-type': 'application/json' })
  })
})

/** 模拟桌面版：页面上有 window.arkrecord，fetch 不应该被调用 */
function desktop(rpc: (method: string, params?: unknown) => Promise<unknown>) {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const bridge = { rpc: vi.fn(rpc), platform: 'win32' as const }
  vi.stubGlobal('window', { arkrecord: bridge })
  return { bridge, fetchMock }
}

describe('postHg in the desktop app', () => {
  it('sends the same envelope to hg.request instead of the Worker', async () => {
    const { bridge, fetchMock } = desktop(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"code":0}' }))
    await postHg('ak', '/user/api/inquiry/gacha/history', '{"query":{"page":"1"}}')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(bridge.rpc).toHaveBeenCalledWith('hg.request', { upstream: 'ak', path: '/user/api/inquiry/gacha/history', envelope: '{"query":{"page":"1"}}' })
  })

  it('rebuilds the response the way the Worker returns it, keeping only the Worker headers', async () => {
    desktop(async () => ({
      status: 200,
      headers: { 'Content-Type': 'application/json', 'x-ak-user-center': 'cookie-value', 'set-cookie': 'leak=1', server: 'x' },
      body: '{"code":0,"data":{"list":[]}}',
    }))
    const response = await postHg('u8', '/u8/user/auth/v2/token_by_channel_token', '{}')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-ak-user-center')).toBe('cookie-value')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('server')).toBeNull()
    expect(await response.json()).toEqual({ code: 0, data: { list: [] } })
  })

  it('passes proxy rejections through as a response with x-arkrecord-proxy', async () => {
    desktop(async () => ({ status: 429, headers: { 'x-arkrecord-proxy': 'rate_limited', 'content-type': 'application/json' }, body: '{"error":"rate_limited"}' }))
    const response = await postHg('ak', '/x', '{}')
    expect(response.status).toBe(429)
    expect(response.headers.get('x-arkrecord-proxy')).toBe('rate_limited')
  })

  it('allows statuses without a body', async () => {
    desktop(async () => ({ status: 204, headers: {}, body: '' }))
    expect((await postHg('ak', '/x', '{}')).status).toBe(204)
  })

  it('throws TransportError with the rpc error when the backend call fails', async () => {
    const rpcError = { code: -32000, message: '后端已退出', data: { kind: 'backend_unavailable' } }
    desktop(() => Promise.reject(rpcError))
    const error = await postHg('ak', '/x', '{}').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(TransportError)
    // 和 fetch 的网络错误一样是 TypeError，client.ts 现有的 catch 会当成网络错误
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TransportError).message).toBe('后端已退出')
    expect((error as TransportError).rpc).toEqual(rpcError)
  })

  it('throws TransportError on results that are not a response', async () => {
    for (const result of [null, 'text', { status: 200, headers: {}, body: 1 }, { status: 99, headers: {}, body: '' }, { status: 200, headers: [], body: '' }, { status: 200, headers: { 'content-type': 'a\nb' }, body: '' }]) {
      desktop(async () => result)
      await expect(postHg('ak', '/x', '{}')).rejects.toBeInstanceOf(TransportError)
    }
  })
})

describe('desktopBridge', () => {
  it('is absent outside the desktop app', () => {
    expect(desktopBridge()).toBeUndefined()
    expect(isDesktop()).toBe(false)
    vi.stubGlobal('window', {})
    expect(isDesktop()).toBe(false)
  })

  it('returns the preload bridge in the desktop app', () => {
    const bridge = { rpc: vi.fn(), platform: 'win32' as const }
    vi.stubGlobal('window', { arkrecord: bridge })
    expect(desktopBridge()).toBe(bridge)
    expect(isDesktop()).toBe(true)
  })
})
