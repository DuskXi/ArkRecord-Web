import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopBridge, isDesktop, isRpcErrorObject, postHg } from './transport'

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
