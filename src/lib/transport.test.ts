import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopBridge, isDesktop, postHg } from './transport'

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
