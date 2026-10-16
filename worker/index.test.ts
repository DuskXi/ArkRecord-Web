import { afterEach, describe, expect, it, vi } from 'vitest'
import * as entry from './index'
import worker from './index'
import type { Env } from './proxy'
import { rateLimitClient } from './security'

const SELF = 'https://ark-next.kaltsit.dev'

function sameOriginHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', ...extra }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never

function call(path: string, init: RequestInit = {}, env: Env = {}): Promise<Response> {
  return worker.fetch(new Request(`${SELF}${path}`, init) as never, env, ctx) as Promise<Response>
}

function mockUpstream(response: Response = new Response('{"code":0}', { headers: { 'content-type': 'application/json' } })) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('入口模块', () => {
  it('只导出处理器和 Durable Object 类（Workers 要求入口模块的命名导出都是处理器或类，否则部署后无法启动）', () => {
    expect(Object.keys(entry).toSorted()).toEqual(['UsageStats', 'default'])
    expect(typeof entry.UsageStats).toBe('function')
  })
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
      call('/api/hg/ak/user/api/inquiry/recharge', { headers: sameOriginHeaders() }),
      call('/api/hg/u8/u8/pay/v1/recent', { headers: sameOriginHeaders() }), // 应为 POST
      call('/api/hg/u8/u8/user/info/v1/basic', {
        method: 'POST',
        headers: sameOriginHeaders({ 'content-type': 'application/json' }),
        body: '{}',
      }),
      call('/api/hg/ak/user/api/inquiry/gacha/cate/../../role/info', { headers: sameOriginHeaders() }),
      call('/api/hg/as/user/oauth2/v2/grant', { headers: sameOriginHeaders() }), // 应为 POST
      call('/api/hg/__proto__/x', { headers: sameOriginHeaders() }),
      call('/api/hg/', { headers: sameOriginHeaders() }),
    ]
    const statuses = (await Promise.all(cases)).map((r) => r.status)
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404, 404])
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

  it('源石记录与充值记录', async () => {
    const fetchMock = mockUpstream()
    await call('/api/hg/ak/user/api/inquiry/diamond?uid=1&size=10', { headers: sameOriginHeaders({ 'x-role-token': 'role' }) })
    await call('/api/hg/u8/u8/pay/v1/recent', {
      method: 'POST',
      headers: sameOriginHeaders({ 'content-type': 'application/json', 'x-ak-user-center': 'abc' }),
      body: '{"token":"dTg="}',
    })
    const [diamondUrl] = fetchMock.mock.calls[0]!
    const [rechargeUrl, rechargeInit] = fetchMock.mock.calls[1]!
    expect(diamondUrl).toBe('https://ak.hypergryph.com/user/api/inquiry/diamond?uid=1&size=10')
    expect(rechargeUrl).toBe('https://u8.hypergryph.com/u8/pay/v1/recent')
    expect(rechargeInit.method).toBe('POST')
    expect(rechargeInit.body).toBe('{"token":"dTg="}')
    // 充值接口不需要、也不会收到明日方舟用户中心的 Cookie
    expect(new Headers(rechargeInit.headers).get('cookie')).toBeNull()
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

  it('IPv4 按单个地址限速，IPv6 按 /64 前缀限速', () => {
    expect(rateLimitClient('198.51.100.7')).toBe('198.51.100.7')
    expect(rateLimitClient('2001:db8:0:12:aaaa::1')).toBe('2001:db8:0:12::/64')
    expect(rateLimitClient('2001:DB8:0000:0012:ffff:1:2:3')).toBe('2001:db8:0:12::/64')
    expect(rateLimitClient('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rateLimitClient('::1')).toBe('0:0:0:0::/64')
    expect(rateLimitClient(null)).toBe('unknown')
  })

  it('同一 /64 内换地址仍计入同一个限速键', async () => {
    mockUpstream()
    const data = { limit: vi.fn(async (_options: RateLimitOptions) => ({ success: true })) }
    const env = { RL_DATA: data } as unknown as Env
    for (const ip of ['2001:db8:1:2::a', '2001:db8:1:2:ffff::b']) {
      await call('/api/hg/ef/api/content?pool_id=standard', { headers: sameOriginHeaders({ 'cf-connecting-ip': ip }) }, env)
    }
    expect(data.limit.mock.calls.map(([arg]) => arg)).toEqual([
      { key: 'data:2001:db8:1:2::/64' },
      { key: 'data:2001:db8:1:2::/64' },
    ])
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

/** 每次调用都返回新的响应（响应体只能读一次） */
function image(body = 'png', type = 'image/png', status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(status === 200 ? body : null, { status, headers: { 'content-type': type } }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('图片缓存转发', () => {
  it('只允许白名单内的来源和路径，不转发查询参数', async () => {
    const fetchMock = image()
    const cases = [
      call('/api/img/prts-avatar/../../w/index.php'),
      call('/api/img/prts-avatar/char_002_amiya.png'),
      call('/api/img/prts/char_002_amiya'),
      call('/api/img/hycdn/upload/image/20260109/not-a-hash.png'),
      call('/api/img/prts-avatar/char_002_amiya?x=1'),
      call('/api/img/__proto__/x'),
    ]
    expect((await Promise.all(cases)).map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('拒绝其他网站引用（盗链），允许本站页面与直接打开', async () => {
    const fetchMock = image()
    const crossSite = await call('/api/img/prts-avatar/char_002_amiya', { headers: { 'sec-fetch-site': 'cross-site' } })
    const otherReferer = await call('/api/img/prts-avatar/char_002_amiya', { headers: { referer: 'https://evil.example/' } })
    expect([crossSite.status, otherReferer.status]).toEqual([403, 403])
    expect(fetchMock).not.toHaveBeenCalled()
    const sameOrigin = await call('/api/img/prts-avatar/char_002_amiya', { headers: { 'sec-fetch-site': 'same-origin', referer: `${SELF}/history` } })
    const direct = await call('/api/img/prts-avatar/char_002_amiya', { headers: { 'sec-fetch-site': 'none' } })
    expect([sameOrigin.status, direct.status]).toEqual([200, 200])
  })

  it('按来源映射地址，返回可长期缓存的同源图片', async () => {
    const fetchMock = image()
    const avatar = await call('/api/img/prts-avatar/char_002_amiya', { headers: { 'sec-fetch-site': 'same-origin' } })
    const banner = await call('/api/img/hycdn/upload/image/20260109/63d80a250a50a5ce2affa145c7c6dca5.png', { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://torappu.prts.wiki/assets/char_avatar/char_002_amiya.png',
      'https://web.hycdn.cn/upload/image/20260109/63d80a250a50a5ce2affa145c7c6dca5.png',
    ])
    expect(avatar.headers.get('cache-control')).toBe('public, max-age=2592000, immutable')
    expect(avatar.headers.get('content-type')).toBe('image/png')
    expect(banner.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(fetchMock.mock.calls[0]![1].redirect).toBe('manual')
  })

  it('不是图片的响应不转发；来源站 404 时短时间缓存', async () => {
    image('<html>', 'text/html')
    const html = await call('/api/img/prts-avatar/char_002_amiya')
    expect(html.status).toBe(502)
    expect(html.headers.get('x-arkrecord-proxy')).toBe('upstream_not_image')
    image('', 'text/html', 404)
    const missing = await call('/api/img/prts-avatar/char_9999_none')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBe('public, max-age=3600')
  })

  it('回源受限速保护', async () => {
    const fetchMock = image()
    const env = { RL_DATA: { limit: vi.fn(async () => ({ success: false })) } } as unknown as Env
    const res = await call('/api/img/prts-avatar/char_002_amiya', {}, env)
    expect(res.status).toBe(429)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/** 模拟统计用的 Durable Object，记录收到的请求 */
function fakeStats() {
  const calls: { url: string; init?: RequestInit }[] = []
  const stub = {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return url.endsWith('/summary')
        ? Response.json({ users: 3, games: { arknights: 2, endfield: 1 }, today: 1, todayNew: 1, month: 2, day: '2026-10-16' })
        : new Response(null, { status: 204 })
    }),
  }
  const env = { STATS: { idFromName: () => 'id', get: () => stub } } as unknown as Env
  return { env, calls }
}

describe('使用人数统计', () => {
  const ping = { first: true, newMonth: true, games: ['arknights'], newGames: ['arknights'] }

  it('只接受本站页面的上报', async () => {
    const { env, calls } = fakeStats()
    const noHeader = await call('/api/stats/ping', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(ping) }, env)
    const crossSite = await call(
      '/api/stats/ping',
      { method: 'POST', headers: sameOriginHeaders({ 'sec-fetch-site': 'cross-site' }), body: JSON.stringify(ping) },
      env,
    )
    expect([noHeader.status, crossSite.status]).toEqual([403, 403])
    expect(calls).toHaveLength(0)
  })

  it('校验上报内容，只把校验后的字段交给计数器', async () => {
    const { env, calls } = fakeStats()
    const bad = await call('/api/stats/ping', { method: 'POST', headers: sameOriginHeaders(), body: '{"first":1}' }, env)
    const notJson = await call('/api/stats/ping', { method: 'POST', headers: sameOriginHeaders(), body: 'nope' }, env)
    const tooLarge = await call('/api/stats/ping', { method: 'POST', headers: sameOriginHeaders(), body: 'x'.repeat(600) }, env)
    expect([bad.status, notJson.status, tooLarge.status]).toEqual([400, 400, 400])
    const ok = await call('/api/stats/ping', { method: 'POST', headers: sameOriginHeaders(), body: JSON.stringify({ ...ping, uid: '123' }) }, env)
    expect(ok.status).toBe(204)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(ping)
  })

  it('上报受限速保护', async () => {
    const { env, calls } = fakeStats()
    const limited = { ...env, RL_DATA: { limit: vi.fn(async () => ({ success: false })) } } as unknown as Env
    const res = await call('/api/stats/ping', { method: 'POST', headers: sameOriginHeaders(), body: JSON.stringify(ping) }, limited)
    expect(res.status).toBe(429)
    expect(calls).toHaveLength(0)
  })

  it('汇总结果可以在边缘缓存，不带 CORS 头', async () => {
    const { env } = fakeStats()
    const res = await call('/api/stats/summary', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    expect([...res.headers.keys()].some((k) => k.startsWith('access-control-'))).toBe(false)
    expect(await res.json()).toMatchObject({ users: 3, today: 1 })
  })

  it('未绑定统计时：上报静默成功，汇总返回 503', async () => {
    const ok = await call('/api/stats/ping', { method: 'POST', headers: sameOriginHeaders(), body: JSON.stringify(ping) })
    const summary = await call('/api/stats/summary')
    expect([ok.status, summary.status]).toEqual([204, 503])
  })
})
