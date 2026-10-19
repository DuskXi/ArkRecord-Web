/**
 * 转发逻辑（由 index.ts 调用）。
 * Workers 要求入口模块的命名导出都是处理器，所以工具函数和常量放在这个文件里。
 */

import { CLOUD_PREFIX } from '../shared/cloud-protocol'
import { type CloudEnv, handleCloud } from './cloud'
import { FEEDBACK_PREFIX, hashToken, newFeedbackId, newFeedbackToken, parseFeedback } from './feedback'
import { handleImage, IMAGE_PREFIX } from './images'
import { handlePage, PAGES } from './pages'
import { kindsFor, parseDesktopPing, saltedKey } from './desktop-stats'
import { checkDesktopClient, checkSameOrigin, rateLimitClient } from './security'
import { parsePing, STATS_PREFIX } from './stats'
import { findRoute, type Limiter, type Route, type Upstream } from './upstreams'

export interface Env extends CloudEnv {
  ASSETS?: Fetcher
  RL_AUTH?: RateLimit
  RL_DATA?: RateLimit
  /** 匿名使用人数统计（见 stats.ts） */
  STATS?: DurableObjectNamespace
  /** 桌面版统计的服务器密钥（desktop-stats.ts）：UID、设备的哈希再做 HMAC 后才保存。在 Cloudflare 后台设置，不进仓库 */
  STATS_UID_SALT?: string
  /** 站内反馈（见 feedback.ts） */
  FEEDBACK?: DurableObjectNamespace
  RL_FEEDBACK?: RateLimit
}

export const API_PREFIX = '/api/hg/'
const MAX_BODY_BYTES = 8192
const UPSTREAM_TIMEOUT_MS = 20_000
const MAX_QUERY_PARAMS = 16
const MAX_QUERY_VALUE = 2048

/** 从浏览器请求中转发给上游的请求头（都不含 token），其余一律丢弃 */
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'user-agent']

/** 角色登录返回的 ak-user-center Cookie 以这个响应头返回给前端（浏览器 JS 读不到 Set-Cookie） */
export const AK_COOKIE_HEADER = 'x-ak-user-center'
const AK_COOKIE_NAME = 'ak-user-center'
const COOKIE_VALUE_PATTERN = /^[\w%.~+/=-]{1,4096}$/
/** 角色 token：可见 ASCII，不含空格 */
const ROLE_TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/
const QUERY_KEY_PATTERN = /^[\w-]{1,64}$/

/**
 * 浏览器发给 /api/hg/* 的请求一律是 POST，所有参数都在请求体里：
 *   { query?: 上游的查询参数, body?: 上游的 JSON 请求体, roleToken?: 角色 token, akCookie?: ak-user-center Cookie }
 * 这样 token 不会出现在发给 Worker 的网址或请求头里（Cloudflare 的统计、安全事件可能记录网址，
 * 实时日志会显示请求头，但都不包含请求体）。上游实际用的方法见 upstreams.ts 中每条路由的 method。
 */
export interface ProxyEnvelope {
  query: Record<string, string>
  body?: Record<string, unknown>
  roleToken?: string
  akCookie?: string
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 校验请求体；不合法时返回 null */
export function parseEnvelope(text: string, route: Route): ProxyEnvelope | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(value)) return null
  if (Object.keys(value).some((key) => !['query', 'body', 'roleToken', 'akCookie'].includes(key))) return null
  const { query = {}, body, roleToken, akCookie } = value
  if (!isPlainObject(query)) return null
  const entries = Object.entries(query)
  if (entries.length > MAX_QUERY_PARAMS) return null
  if (!entries.every(([k, v]) => QUERY_KEY_PATTERN.test(k) && typeof v === 'string' && v.length <= MAX_QUERY_VALUE)) return null
  // GET 路由不能带请求体，POST 路由必须带 JSON 对象
  if (route.method === 'GET' ? body !== undefined : !isPlainObject(body)) return null
  if (roleToken !== undefined && (typeof roleToken !== 'string' || !ROLE_TOKEN_PATTERN.test(roleToken))) return null
  if (akCookie !== undefined && (typeof akCookie !== 'string' || !COOKIE_VALUE_PATTERN.test(akCookie))) return null
  return {
    query: query as Record<string, string>,
    ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
    ...(roleToken === undefined ? {} : { roleToken }),
    ...(akCookie === undefined ? {} : { akCookie }),
  }
}

/** Worker 的请求入口 */
export async function handleRequest(request: Request, env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname.startsWith(API_PREFIX)) return handleProxy(request, env, url)
  if (url.pathname.startsWith(STATS_PREFIX)) return handleStats(request, env, url, ctx)
  if (url.pathname === FEEDBACK_PREFIX || url.pathname.startsWith(`${FEEDBACK_PREFIX}/`)) return handleFeedback(request, env, url)
  if (url.pathname.startsWith(CLOUD_PREFIX)) return handleCloud(request, env, url)
  if (url.pathname.startsWith(IMAGE_PREFIX)) {
    return handleImage(request, url, {
      allowUpstream: () => withinRateLimit(env, 'data', request),
      waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
    })
  }
  if (url.pathname === '/api/health') return proxyError(200, 'ok')
  // 页面地址：AI agent 要 Markdown 时返回 Markdown 说明（见 pages.ts）
  if (env.ASSETS && Object.hasOwn(PAGES, url.pathname)) return handlePage(request, env.ASSETS, url)
  if (env.ASSETS) return env.ASSETS.fetch(request)
  return proxyError(404, 'not_found')
}

export async function handleProxy(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return proxyError(405, 'preflight_not_allowed')

  const rejection = checkSameOrigin(request)
  if (rejection) return proxyError(403, rejection)

  const rest = url.pathname.slice(API_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return proxyError(404, 'route_not_allowed')
  const match = findRoute(rest.slice(0, slash), rest.slice(slash))
  if (!match) return proxyError(404, 'route_not_allowed')
  // 旧版页面用 GET 并把参数放在网址里；现在一律 POST，参数放在请求体里
  if (request.method !== 'POST') return proxyError(405, 'client_outdated')
  if (url.search) return proxyError(400, 'query_in_url')

  if (!(await withinRateLimit(env, match.route.limiter, request))) {
    return proxyError(429, 'rate_limited', { 'retry-after': '60' })
  }

  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    return proxyError(415, 'json_required')
  }
  const text = await readBodyLimited(request)
  if (text === null) return proxyError(413, 'body_too_large')
  const envelope = parseEnvelope(text, match.route)
  if (!envelope) return proxyError(400, 'bad_request')

  const query = new URLSearchParams(envelope.query)
  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(`https://${match.upstream.host}${match.route.path}${query.size ? `?${query}` : ''}`, {
      method: match.route.method,
      headers: buildUpstreamHeaders(request, match.upstream, envelope, match.route.method === 'POST'),
      body: envelope.body === undefined ? undefined : JSON.stringify(envelope.body),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    // 不把错误信息带出去：其中可能有带 token 的上游地址
    return proxyError(502, 'upstream_unreachable')
  }
  return buildClientResponse(upstreamResponse, match.upstream)
}

const SUMMARY_CACHE_SECONDS = 300
const MAX_PING_BYTES = 512

/**
 * 匿名使用人数统计：
 *   POST /api/stats/ping    只接受本站页面的请求（与转发相同的同源检查），受限速保护；
 *   GET  /api/stats/summary 汇总结果在 Cloudflare 边缘缓存 5 分钟，绝大多数读取不会到达 Durable Object。
 */
export async function handleStats(request: Request, env: Env, url: URL, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const path = url.pathname.slice(STATS_PREFIX.length)
  if ((path === 'desktop/device' || path === 'desktop/uid') && request.method === 'POST') {
    return handleDesktopStats(request, env, path.slice('desktop/'.length))
  }
  if (path === 'ping' && request.method === 'POST') {
    const rejection = checkSameOrigin(request)
    if (rejection) return proxyError(403, rejection)
    if (!(await withinRateLimit(env, 'data', request))) return proxyError(429, 'rate_limited', { 'retry-after': '60' })
    const text = await readBodyLimited(request, MAX_PING_BYTES)
    let ping = null
    try {
      ping = text === null ? null : parsePing(JSON.parse(text))
    } catch {
      ping = null
    }
    if (!ping) return proxyError(400, 'invalid_ping')
    if (!env.STATS) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    const stub = env.STATS.get(env.STATS.idFromName('global'))
    const res = await stub.fetch('https://stats/ping', { method: 'POST', body: JSON.stringify(ping) })
    return new Response(null, { status: res.ok ? 204 : 502, headers: { 'cache-control': 'no-store' } })
  }
  if (path === 'summary' && request.method === 'GET') {
    if (!env.STATS) return proxyError(503, 'stats_unavailable')
    const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default
    const cacheKey = new Request(`${url.origin}${STATS_PREFIX}summary`)
    const cached = await cache?.match(cacheKey)
    if (cached) return cached
    const stub = env.STATS.get(env.STATS.idFromName('global'))
    const res = await stub.fetch('https://stats/summary')
    if (!res.ok) return proxyError(502, 'stats_unavailable')
    const response = new Response(await res.text(), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${SUMMARY_CACHE_SECONDS}`,
        'x-content-type-options': 'nosniff',
      },
    })
    if (cache) {
      const put = cache.put(cacheKey, response.clone())
      if (ctx) ctx.waitUntil(put)
      else await put
    }
    return response
  }
  return proxyError(request.method === 'OPTIONS' ? 405 : 404, 'stats_route_not_allowed')
}

/**
 * 桌面版的统计上报（见 desktop-stats.ts）：POST /api/stats/desktop/device、/api/stats/desktop/uid。
 * 由桌面版的 Python 后端发出，不是浏览器，所以不做同源检查，改为检查 x-arkrecord-client: desktop，并拒绝其他网站的页面。
 * 上报的哈希先用服务器密钥 STATS_UID_SALT 做 HMAC，再交给计数器；没有配置密钥时拒绝（503），不保存没加盐的值。
 */
async function handleDesktopStats(request: Request, env: Env, kind: string): Promise<Response> {
  const rejection = checkDesktopClient(request)
  if (rejection) return proxyError(403, rejection)
  if (!(await withinRateLimit(env, 'data', request))) return proxyError(429, 'rate_limited', { 'retry-after': '60' })
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return proxyError(415, 'json_required')
  const text = await readBodyLimited(request, MAX_PING_BYTES)
  let ping = null
  try {
    ping = text === null ? null : parseDesktopPing(kind, JSON.parse(text))
  } catch {
    ping = null
  }
  if (!ping) return proxyError(400, 'invalid_ping')
  if (!env.STATS_UID_SALT || env.STATS_UID_SALT.length < 32) return proxyError(503, 'stats_unavailable')
  if (!env.STATS) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  const key = await saltedKey(env.STATS_UID_SALT, ping)
  const stub = env.STATS.get(env.STATS.idFromName('global'))
  const res = await stub.fetch('https://stats/desktop', { method: 'POST', body: JSON.stringify({ kinds: kindsFor(ping), key }) })
  return new Response(null, { status: res.ok ? 204 : 502, headers: { 'cache-control': 'no-store' } })
}

const MAX_FEEDBACK_BYTES = 8192

/**
 * 站内反馈（见 feedback.ts）：
 *   POST /api/feedback   只接受本站页面的请求，受单独的限速保护；返回反馈编号和凭证，凭证只交给提交者，服务端只存它的哈希。
 * 用户查看回复（GET /api/feedback/{id}）和作者端还没有实现，见 feedback.ts 开头的说明。
 */
export async function handleFeedback(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname !== FEEDBACK_PREFIX) return proxyError(404, 'not_found')
  if (request.method !== 'POST') return proxyError(405, 'method_not_allowed')
  const rejection = checkSameOrigin(request)
  if (rejection) return proxyError(403, rejection)
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return proxyError(415, 'json_required')
  if (!(await withinRateLimit(env, 'feedback', request))) return proxyError(429, 'rate_limited', { 'retry-after': '60' })
  const text = await readBodyLimited(request, MAX_FEEDBACK_BYTES)
  if (text === null) return proxyError(413, 'body_too_large')
  let input = null
  try {
    input = parseFeedback(JSON.parse(text))
  } catch {
    input = null
  }
  if (!input) return proxyError(400, 'invalid_feedback')
  if (!env.FEEDBACK) return proxyError(503, 'feedback_unavailable')

  const stub = env.FEEDBACK.get(env.FEEDBACK.idFromName('global'))
  const token = newFeedbackToken()
  const tokenHash = await hashToken(token)
  // 编号有 50 位随机数，几乎不会重复；万一重复就换一个
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newFeedbackId()
    const res = await stub.fetch('https://feedback/submit', { method: 'POST', body: JSON.stringify({ ...input, id, tokenHash }) })
    if (res.status === 201) return Response.json({ id, token }, { status: 201, headers: { 'cache-control': 'no-store' } })
    if (res.status !== 409) return proxyError(502, 'feedback_unavailable')
  }
  return proxyError(502, 'feedback_unavailable')
}

async function withinRateLimit(env: Env, limiter: Limiter | 'feedback', request: Request): Promise<boolean> {
  const binding = limiter === 'auth' ? env.RL_AUTH : limiter === 'feedback' ? env.RL_FEEDBACK : env.RL_DATA
  if (!binding) return true
  const client = rateLimitClient(request.headers.get('cf-connecting-ip'))
  const { success } = await binding.limit({ key: `${limiter}:${client}` })
  return success
}

async function readBodyLimited(request: Request, limit = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > limit) return null
  const text = await request.text()
  return new TextEncoder().encode(text).byteLength > limit ? null : text
}

export function buildUpstreamHeaders(request: Request, upstream: Upstream, envelope: ProxyEnvelope, json: boolean): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  if (json) headers.set('content-type', 'application/json')
  if (envelope.roleToken !== undefined) headers.set('x-role-token', envelope.roleToken)
  for (const [name, value] of Object.entries(upstream.extraHeaders ?? {})) headers.set(name, value)
  if (upstream.relayAkCookie && envelope.akCookie !== undefined) headers.set('cookie', `${AK_COOKIE_NAME}=${envelope.akCookie}`)
  return headers
}

export function buildClientResponse(upstream: Response, config: Upstream): Response {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  const contentType = upstream.headers.get('content-type')
  if (contentType !== null) headers.set('content-type', contentType)
  if (config.relayAkCookie) {
    const value = extractAkCookie(upstream.headers)
    if (value !== null) headers.set(AK_COOKIE_HEADER, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}

function extractAkCookie(headers: Headers): string | null {
  for (const cookie of headers.getSetCookie()) {
    const [pair = ''] = cookie.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(0, eq).trim() === AK_COOKIE_NAME) {
      const value = pair.slice(eq + 1).trim()
      return COOKIE_VALUE_PATTERN.test(value) ? value : null
    }
  }
  return null
}

/** Worker 自身产生的错误统一带上 x-arkrecord-proxy 头，前端据此区分“转发层拒绝”和“上游返回的错误” */
function proxyError(status: number, code: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ proxy: code }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-arkrecord-proxy': code,
      ...extra,
    },
  })
}

