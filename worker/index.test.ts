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
    expect(Object.keys(entry).toSorted()).toEqual(['CloudVault', 'FeedbackStore', 'UsageStats', 'default'])
    expect(typeof entry.UsageStats).toBe('function')
    expect(typeof entry.FeedbackStore).toBe('function')
  })
})

/** 按现在的方式调用转发：POST，参数都在 JSON 请求体里 */
function hgCall(path: string, envelope: Record<string, unknown> = {}, headers: Record<string, string> = sameOriginHeaders(), env: Env = {}) {
  return call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(envelope) }, env)
}

describe('只服务本站', () => {
  it('拒绝 CORS 预检，且不返回任何 CORS 头', async () => {
    const res = await call('/api/hg/ak/user/api/inquiry/gacha/cate', { method: 'OPTIONS' })
    expect(res.status).toBe(405)
    expect([...res.headers.keys()].some((k) => k.startsWith('access-control-'))).toBe(false)
  })

  it('缺少客户端标记头时拒绝', async () => {
    const fetchMock = mockUpstream()
    const res = await hgCall('/api/hg/ak/user/api/inquiry/gacha/cate', {}, { 'sec-fetch-site': 'same-origin' })
    expect(res.status).toBe(403)
    expect(res.headers.get('x-arkrecord-proxy')).toBe('missing_client_header')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('拒绝跨站请求', async () => {
    const fetchMock = mockUpstream()
    const path = '/api/hg/ak/user/api/inquiry/gacha/cate'
    const bySite = await hgCall(path, {}, sameOriginHeaders({ 'sec-fetch-site': 'cross-site' }))
    const byOrigin = await hgCall(path, {}, { 'x-arkrecord-client': '1', origin: 'https://evil.example' })
    const byReferer = await hgCall(path, {}, { 'x-arkrecord-client': '1', referer: 'https://evil.example/page' })
    expect([bySite.status, byOrigin.status, byReferer.status]).toEqual([403, 403, 403])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('旧浏览器没有 Sec-Fetch-Site 时，同源 Referer 可以通过', async () => {
    mockUpstream()
    const res = await hgCall('/api/hg/ak/user/api/inquiry/gacha/cate', {}, { 'x-arkrecord-client': '1', referer: `${SELF}/overview` })
    expect(res.status).toBe(200)
  })

  it('成功响应也不带 CORS 头', async () => {
    mockUpstream()
    const res = await hgCall('/api/hg/ef/api/content', { query: { pool_id: 'standard' } })
    expect(res.status).toBe(200)
    expect([...res.headers.keys()].some((k) => k.startsWith('access-control-'))).toBe(false)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('白名单', () => {
  it('拒绝未列出的上游和路径', async () => {
    const fetchMock = mockUpstream()
    const cases = [
      hgCall('/api/hg/prts/w/干员一览'),
      hgCall('/api/hg/ak/user/api/inquiry/recharge'),
      hgCall('/api/hg/u8/u8/user/info/v1/basic', { body: {} }),
      hgCall('/api/hg/ak/user/api/inquiry/gacha/cate/../../role/info'),
      hgCall('/api/hg/__proto__/x'),
      hgCall('/api/hg/'),
    ]
    const statuses = (await Promise.all(cases)).map((r) => r.status)
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('按白名单转发到正确的上游地址和方法，查询参数来自请求体', async () => {
    const fetchMock = mockUpstream()
    await hgCall('/api/hg/ef/api/record/char', { query: { token: 't', server_id: '1', pool_type: 'E_CharacterGachaPoolType_Standard' } })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://ef-webview.hypergryph.com/api/record/char?token=t&server_id=1&pool_type=E_CharacterGachaPoolType_Standard')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.redirect).toBe('manual')
  })

  it('源石记录与充值记录', async () => {
    const fetchMock = mockUpstream()
    await hgCall('/api/hg/ak/user/api/inquiry/diamond', { query: { uid: '1', size: '10' }, roleToken: 'role' })
    await hgCall('/api/hg/u8/u8/pay/v1/recent', { body: { token: 'dTg=' }, akCookie: 'abc' })
    const [diamondUrl, diamondInit] = fetchMock.mock.calls[0]!
    const [rechargeUrl, rechargeInit] = fetchMock.mock.calls[1]!
    expect(diamondUrl).toBe('https://ak.hypergryph.com/user/api/inquiry/diamond?uid=1&size=10')
    expect(new Headers(diamondInit.headers).get('x-role-token')).toBe('role')
    expect(rechargeUrl).toBe('https://u8.hypergryph.com/u8/pay/v1/recent')
    expect(rechargeInit.method).toBe('POST')
    expect(rechargeInit.body).toBe('{"token":"dTg="}')
    expect(new Headers(rechargeInit.headers).get('content-type')).toBe('application/json')
    // 充值接口不需要、也不会收到明日方舟用户中心的 Cookie
    expect(new Headers(rechargeInit.headers).get('cookie')).toBeNull()
  })

  it('token 不能放在网址里；旧版页面的 GET 请求提示刷新', async () => {
    const fetchMock = mockUpstream()
    const inUrl = await hgCall('/api/hg/binding/account/binding/v1/binding_list?token=t&appCode=arknights')
    const legacy = await call('/api/hg/binding/account/binding/v1/binding_list?token=t&appCode=arknights', { headers: sameOriginHeaders() })
    expect([inUrl.status, inUrl.headers.get('x-arkrecord-proxy')]).toEqual([400, 'query_in_url'])
    expect([legacy.status, legacy.headers.get('x-arkrecord-proxy')]).toEqual([405, 'client_outdated'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('请求体只接受规定的字段和格式', async () => {
    const fetchMock = mockUpstream()
    const cases = [
      // 不是 JSON、体积太大
      call('/api/hg/as/user/oauth2/v2/grant', { method: 'POST', headers: sameOriginHeaders({ 'content-type': 'text/plain' }), body: 'x' }),
      hgCall('/api/hg/as/user/oauth2/v2/grant', { body: { token: 'x'.repeat(9000) } }),
      call('/api/hg/as/user/oauth2/v2/grant', { method: 'POST', headers: sameOriginHeaders({ 'content-type': 'application/json' }), body: '{' }),
      // 多余的字段、查询参数不是字符串、GET 接口带了请求体、POST 接口没有请求体
      hgCall('/api/hg/ef/api/content', { query: { pool_id: 'x' }, url: 'https://evil.example' }),
      hgCall('/api/hg/ef/api/content', { query: { pool_id: 1 } }),
      hgCall('/api/hg/ef/api/content', { body: { a: 1 } }),
      hgCall('/api/hg/as/user/oauth2/v2/grant', {}),
      hgCall('/api/hg/as/user/oauth2/v2/grant', { body: [1] }),
      // 带有注入字符的 Cookie 值和角色 token
      hgCall('/api/hg/ak/user/api/inquiry/gacha/cate', { query: { uid: '1' }, akCookie: 'a; other=b' }),
      hgCall('/api/hg/ak/user/api/inquiry/gacha/cate', { query: { uid: '1' }, roleToken: 'a\nb' }),
    ]
    expect((await Promise.all(cases)).map((r) => r.status)).toEqual([415, 413, 400, 400, 400, 400, 400, 400, 400, 400])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('请求头与 Cookie 转换', () => {
  it('只转发白名单请求头；角色 token 和 Cookie 来自请求体', async () => {
    const fetchMock = mockUpstream()
    await hgCall(
      '/api/hg/ak/user/api/inquiry/gacha/history',
      { query: { uid: '1', category: 'normal', size: '50' }, roleToken: 'role', akCookie: 'abc%2Fdef' },
      sameOriginHeaders({
        'x-role-token': 'header-leak',
        'x-ak-user-center': 'header-leak',
        authorization: 'Bearer leak',
        cookie: 'session=leak',
        'cf-connecting-ip': '203.0.113.1',
        'user-agent': 'Mozilla/5.0 Test',
      }),
    )
    const init = fetchMock.mock.calls[0]![1]
    const headers = new Headers(init.headers)
    expect(headers.get('x-role-token')).toBe('role')
    expect(headers.get('cookie')).toBe('ak-user-center=abc%2Fdef')
    expect(headers.get('referer')).toBe('https://ak.hypergryph.com/user/headhunting')
    expect(headers.get('user-agent')).toBe('Mozilla/5.0 Test')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('cf-connecting-ip')).toBeNull()
    expect(headers.get('x-arkrecord-client')).toBeNull()
    expect(headers.get('x-ak-user-center')).toBeNull()
    expect(headers.get('content-type')).toBeNull()
  })

  it('其他上游不会收到 Cookie', async () => {
    const fetchMock = mockUpstream()
    await hgCall('/api/hg/ef/api/content', { query: { pool_id: 'standard' }, akCookie: 'abc' })
    const headers = new Headers(fetchMock.mock.calls[0]![1].headers)
    expect(headers.get('cookie')).toBeNull()
  })

  it('把角色登录返回的 Set-Cookie 转成可读的响应头，并丢弃其他 Cookie', async () => {
    const upstreamHeaders = new Headers({ 'content-type': 'application/json' })
    upstreamHeaders.append('set-cookie', 'ak-user-center=xyz%3D; Path=/; HttpOnly; Secure')
    upstreamHeaders.append('set-cookie', 'tracker=1; Path=/')
    mockUpstream(new Response('{"code":0}', { headers: upstreamHeaders }))
    const res = await hgCall('/api/hg/ak/user/api/role/login', { body: { token: 'u8' } })
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
    const ip = sameOriginHeaders({ 'cf-connecting-ip': '198.51.100.7' })
    const ok = await hgCall('/api/hg/binding/account/binding/v1/binding_list', { query: { token: 't', appCode: 'arknights' } }, ip, env)
    const limited = await hgCall('/api/hg/ef/api/content', { query: { pool_id: 'standard' } }, ip, env)
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
      await hgCall('/api/hg/ef/api/content', { query: { pool_id: 'standard' } }, sameOriginHeaders({ 'cf-connecting-ip': ip }), env)
    }
    expect(data.limit.mock.calls.map(([arg]) => arg)).toEqual([{ key: 'data:2001:db8:1:2::/64' }, { key: 'data:2001:db8:1:2::/64' }])
  })

  it('上游不可达时返回 502，不带出错误细节', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        throw new TypeError(`Fetch API cannot load: ${url}`)
      }),
    )
    const res = await hgCall('/api/hg/ef/api/record/char', { query: { token: 'secret-token-value' } })
    expect(res.status).toBe(502)
    expect(res.headers.get('x-arkrecord-proxy')).toBe('upstream_unreachable')
    expect(await res.text()).not.toContain('secret-token-value')
  })

  it('未预料的异常变成不带细节的 500，异常信息不交给平台', async () => {
    const env = {
      get RL_AUTH(): never {
        throw new Error('boom secret-token-value')
      },
    } as unknown as Env
    const res = await hgCall('/api/hg/binding/account/binding/v1/binding_list', { query: { token: 'secret-token-value' } }, sameOriginHeaders(), env)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('{"error":"internal_error"}')
  })

  it('原样返回上游的错误状态码，供前端判断 token 失效', async () => {
    mockUpstream(new Response('{"reason":"UN_LOGIN"}', { status: 401, headers: { 'content-type': 'application/json' } }))
    const res = await hgCall('/api/hg/ak/user/api/inquiry/gacha/cate', { query: { uid: '1' } })
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

function fakeFeedback(statuses: number[] = [201]) {
  const bodies: Record<string, unknown>[] = []
  const stub = {
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(null, { status: statuses.shift() ?? 201 })
    }),
  }
  const env = { FEEDBACK: { idFromName: () => 'id', get: () => stub } } as unknown as Env
  return { env, bodies }
}

function postFeedback(body: unknown, env: Env, headers = sameOriginHeaders({ 'content-type': 'application/json' })) {
  return call('/api/feedback', { method: 'POST', headers, body: JSON.stringify(body) }, env)
}

describe('站内反馈', () => {
  const feedback = { category: 'bug', message: '同步时提示请求太频繁', contact: 'QQ 12345', appVersion: '1.0.0', game: 'arknights' }
  const post = postFeedback

  it('只接受本站页面提交的 JSON', async () => {
    const { env, bodies } = fakeFeedback()
    const crossSite = await post(feedback, env, sameOriginHeaders({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }))
    const notJson = await post(feedback, env, sameOriginHeaders({ 'content-type': 'text/plain' }))
    const get = await call('/api/feedback', { headers: sameOriginHeaders() }, env)
    const other = await call('/api/feedback/FB-00000-00000', { headers: sameOriginHeaders() }, env)
    expect([crossSite.status, notJson.status, get.status, other.status]).toEqual([403, 415, 405, 404])
    expect(bodies).toHaveLength(0)
  })

  it('拒绝不合规的内容', async () => {
    const { env, bodies } = fakeFeedback()
    const statuses = await Promise.all([
      post({ ...feedback, category: 'spam' }, env),
      post({ ...feedback, message: '  ' }, env),
      post({ ...feedback, message: 'x'.repeat(2001) }, env),
      post({ ...feedback, contact: 'x'.repeat(201) }, env),
    ])
    expect(statuses.map((r) => r.status)).toEqual([400, 400, 400, 400])
    expect(bodies).toHaveLength(0)
  })

  it('返回编号和凭证；服务端只收到凭证的哈希和白名单内的字段', async () => {
    const { env, bodies } = fakeFeedback()
    const res = await post({ ...feedback, uid: '123', token: 'leak' }, env)
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const { id, token } = (await res.json()) as { id: string; token: string }
    expect(id).toMatch(/^FB-[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    expect(token).toMatch(/^[\w-]{43}$/)
    const stored = bodies[0]!
    expect(Object.keys(stored).toSorted()).toEqual(['appVersion', 'category', 'contact', 'game', 'id', 'message', 'tokenHash'])
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(token)
  })

  it('编号重复时换一个重试', async () => {
    const { env, bodies } = fakeFeedback([409, 201])
    const res = await post(feedback, env)
    expect(res.status).toBe(201)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.id).not.toBe(bodies[1]!.id)
  })

  it('受单独的限速保护', async () => {
    const { env } = fakeFeedback()
    const limited = { ...env, RL_FEEDBACK: { limit: async () => ({ success: false }) } } as unknown as Env
    expect((await post(feedback, limited)).status).toBe(429)
  })
})
