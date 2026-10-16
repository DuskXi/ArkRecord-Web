import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from './index'

const SELF = 'https://ark-next.kaltsit.dev'

function sameOriginHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', ...extra }
}

function call(path: string, init: RequestInit = {}, env: Env = {}): Promise<Response> {
  return worker.fetch(new Request(`${SELF}${path}`, init) as never, env) as Promise<Response>
}

function mockUpstream(response: Response = new Response('{"code":0}', { headers: { 'content-type': 'application/json' } })) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('只服务本站', () => {
  it('拒绝 CORS 预检，且不返回任何 CORS 头', async () => {
    const res = await call('/api/hg/ak/user/api/inquiry/gacha/cate', { method: 'OPTIONS' })
    expect(res.status).toBe(405)
    expect([...res.headers.keys()].some((k) => k.startsWith('access-control-'))).toBe(false)
  })

  it('缺少客户端标记头时拒绝', async () => {
    const fetchMock = mockUpstream()
    const res = await call('/api/hg/ak/user/api/inquiry/gacha/cate', { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(res.status).toBe(403)
    expect(res.headers.get('x-arkrecord-proxy')).toBe('missing_client_header')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('拒绝跨站请求', async () => {
    const fetchMock = mockUpstream()
    const bySite = await call('/api/hg/ak/user/api/inquiry/gacha/cate', {
      headers: sameOriginHeaders({ 'sec-fetch-site': 'cross-site' }),
    })
    const byOrigin = await call('/api/hg/ak/user/api/inquiry/gacha/cate', {
      headers: { 'x-arkrecord-client': '1', origin: 'https://evil.example' },
    })
    const byReferer = await call('/api/hg/ak/user/api/inquiry/gacha/cate', {
      headers: { 'x-arkrecord-client': '1', referer: 'https://evil.example/page' },
    })
    expect([bySite.status, byOrigin.status, byReferer.status]).toEqual([403, 403, 403])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('旧浏览器没有 Sec-Fetch-Site 时，同源 Referer 可以通过', async () => {
    mockUpstream()
    const res = await call('/api/hg/ak/user/api/inquiry/gacha/cate', {
      headers: { 'x-arkrecord-client': '1', referer: `${SELF}/overview` },
    })
    expect(res.status).toBe(200)
  })

  it('成功响应也不带 CORS 头', async () => {
    mockUpstream()
    const res = await call('/api/hg/ef/api/content?pool_id=standard', { headers: sameOriginHeaders() })
    expect(res.status).toBe(200)
    expect([...res.headers.keys()].some((k) => k.startsWith('access-control-'))).toBe(false)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('白名单', () => {
  it('拒绝未列出的上游、路径和方法', async () => {
    const fetchMock = mockUpstream()
    const cases = [
      call('/api/hg/prts/w/干员一览', { headers: sameOriginHeaders() }),
      call('/api/hg/ak/user/api/inquiry/diamond', { headers: sameOriginHeaders() }),
      call('/api/hg/ak/user/api/inquiry/gacha/cate/../../role/info', { headers: sameOriginHeaders() }),
      call('/api/hg/as/user/oauth2/v2/grant', { headers: sameOriginHeaders() }), // 应为 POST
      call('/api/hg/__proto__/x', { headers: sameOriginHeaders() }),
      call('/api/hg/', { headers: sameOriginHeaders() }),
    ]
    const statuses = (await Promise.all(cases)).map((r) => r.status)
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('按白名单转发到正确的上游地址，保留查询参数', async () => {
    const fetchMock = mockUpstream()
    await call('/api/hg/ef/api/record/char?token=t&server_id=1&pool_type=E_CharacterGachaPoolType_Standard', {
      headers: sameOriginHeaders(),
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      'https://ef-webview.hypergryph.com/api/record/char?token=t&server_id=1&pool_type=E_CharacterGachaPoolType_Standard',
    )
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
  })

  it('POST 只接受小体积 JSON', async () => {
    const fetchMock = mockUpstream()
    const notJson = await call('/api/hg/as/user/oauth2/v2/grant', {
      method: 'POST',
      headers: sameOriginHeaders({ 'content-type': 'text/plain' }),
      body: 'x',
    })
    const tooLarge = await call('/api/hg/as/user/oauth2/v2/grant', {
      method: 'POST',
      headers: sameOriginHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ token: 'x'.repeat(5000) }),
    })
    expect([notJson.status, tooLarge.status]).toEqual([415, 413])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('请求头与 Cookie 转换', () => {
  it('只转发白名单请求头，并把 x-ak-user-center 转成 Cookie', async () => {
    const fetchMock = mockUpstream()
    await call('/api/hg/ak/user/api/inquiry/gacha/history?uid=1&category=normal&size=50', {
      headers: sameOriginHeaders({
        'x-role-token': 'role',
        'x-ak-user-center': 'abc%2Fdef',
        authorization: 'Bearer leak',
        cookie: 'session=leak',
        'cf-connecting-ip': '203.0.113.1',
      }),
    })
    const init = fetchMock.mock.calls[0]![1]
    const headers = new Headers(init.headers)
    expect(headers.get('x-role-token')).toBe('role')
    expect(headers.get('cookie')).toBe('ak-user-center=abc%2Fdef')
    expect(headers.get('referer')).toBe('https://ak.hypergryph.com/user/headhunting')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('cf-connecting-ip')).toBeNull()
    expect(headers.get('x-arkrecord-client')).toBeNull()
  })

  it('拒绝带有注入字符的 Cookie 值', async () => {
    const fetchMock = mockUpstream()
    await call('/api/hg/ak/user/api/inquiry/gacha/cate?uid=1', {
      headers: sameOriginHeaders({ 'x-ak-user-center': 'a; other=b' }),
    })
    const headers = new Headers(fetchMock.mock.calls[0]![1].headers)
    expect(headers.get('cookie')).toBeNull()
  })

  it('其他上游不会收到 Cookie', async () => {
    const fetchMock = mockUpstream()
    await call('/api/hg/ef/api/content?pool_id=standard', { headers: sameOriginHeaders({ 'x-ak-user-center': 'abc' }) })
    const headers = new Headers(fetchMock.mock.calls[0]![1].headers)
    expect(headers.get('cookie')).toBeNull()
  })

  it('把角色登录返回的 Set-Cookie 转成可读的响应头，并丢弃其他 Cookie', async () => {
    const upstreamHeaders = new Headers({ 'content-type': 'application/json' })
    upstreamHeaders.append('set-cookie', 'ak-user-center=xyz%3D; Path=/; HttpOnly; Secure')
    upstreamHeaders.append('set-cookie', 'tracker=1; Path=/')
    mockUpstream(new Response('{"code":0}', { headers: upstreamHeaders }))
    const res = await call('/api/hg/ak/user/api/role/login', {
      method: 'POST',
      headers: sameOriginHeaders({ 'content-type': 'application/json' }),
      body: '{"token":"u8"}',
    })
    expect(res.headers.get('x-ak-user-center')).toBe('xyz%3D')
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('限速与容错', () => {
  it('认证和数据接口分别使用各自的限速器，以客户端 IP 为键', async () => {
    mockUpstream()
    const auth = { limit: vi.fn(async () => ({ success: true })) }
    const data = { limit: vi.fn(async () => ({ success: false })) }
    const env = { RL_AUTH: auth, RL_DATA: data } as unknown as Env
    const ok = await call(
      '/api/hg/binding/account/binding/v1/binding_list?token=t&appCode=arknights',
      { headers: sameOriginHeaders({ 'cf-connecting-ip': '198.51.100.7' }) },
      env,
    )
    const limited = await call(
      '/api/hg/ef/api/content?pool_id=standard',
      { headers: sameOriginHeaders({ 'cf-connecting-ip': '198.51.100.7' }) },
      env,
    )
    expect(ok.status).toBe(200)
    expect(auth.limit).toHaveBeenCalledWith({ key: 'auth:198.51.100.7' })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })

  it('上游不可达时返回 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network')
      }),
    )
    const res = await call('/api/hg/ef/api/content?pool_id=standard', { headers: sameOriginHeaders() })
    expect(res.status).toBe(502)
    expect(res.headers.get('x-arkrecord-proxy')).toBe('upstream_unreachable')
  })

  it('原样返回上游的错误状态码，供前端判断 token 失效', async () => {
    mockUpstream(new Response('{"reason":"UN_LOGIN"}', { status: 401, headers: { 'content-type': 'application/json' } }))
    const res = await call('/api/hg/ak/user/api/inquiry/gacha/cate?uid=1', { headers: sameOriginHeaders() })
    expect(res.status).toBe(401)
    expect(res.headers.get('x-arkrecord-proxy')).toBeNull()
    expect(await res.json()).toEqual({ reason: 'UN_LOGIN' })
  })
})
