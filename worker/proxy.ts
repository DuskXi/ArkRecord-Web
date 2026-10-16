/**
 * 转发逻辑（由 index.ts 调用）。
 * Workers 要求入口模块的命名导出都是处理器，所以工具函数和常量放在这个文件里。
 */

import { FEEDBACK_PREFIX, hashToken, newFeedbackId, newFeedbackToken, parseFeedback } from './feedback'
import { handleImage, IMAGE_PREFIX } from './images'
import { checkSameOrigin, rateLimitClient } from './security'
import { parsePing, STATS_PREFIX } from './stats'
import { findRoute, type Limiter, type Upstream } from './upstreams'

export interface Env {
  ASSETS?: Fetcher
  RL_AUTH?: RateLimit
  RL_DATA?: RateLimit
  /** 匿名使用人数统计（见 stats.ts） */
  STATS?: DurableObjectNamespace
  /** 站内反馈（见 feedback.ts） */
  FEEDBACK?: DurableObjectNamespace
  RL_FEEDBACK?: RateLimit
}

export const API_PREFIX = '/api/hg/'
const MAX_BODY_BYTES = 4096
const MAX_QUERY_LENGTH = 2048
const UPSTREAM_TIMEOUT_MS = 20_000

/** 从浏览器请求中原样转发给上游的请求头，其余一律丢弃 */
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent', 'x-role-token']

/** 前端用这个请求头传递 ak-user-center 的值，Worker 把它转成 Cookie；响应中的 Set-Cookie 也以同名响应头返回 */
export const AK_COOKIE_HEADER = 'x-ak-user-center'
const AK_COOKIE_NAME = 'ak-user-center'
const COOKIE_VALUE_PATTERN = /^[\w%.~+/=-]{1,4096}$/


/** Worker 的请求入口 */
export async function handleRequest(request: Request, env: Env, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname.startsWith(API_PREFIX)) return handleProxy(request, env, url)
  if (url.pathname.startsWith(STATS_PREFIX)) return handleStats(request, env, url, ctx)
  if (url.pathname === FEEDBACK_PREFIX || url.pathname.startsWith(`${FEEDBACK_PREFIX}/`)) return handleFeedback(request, env, url)
  if (url.pathname.startsWith(IMAGE_PREFIX)) {
    return handleImage(request, url, {
      allowUpstream: () => withinRateLimit(env, 'data', request),
      waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined,
    })
  }
  if (url.pathname === '/api/health') return proxyError(200, 'ok')
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
  const match = findRoute(rest.slice(0, slash), request.method, rest.slice(slash))
  if (!match) return proxyError(404, 'route_not_allowed')
  if (url.search.length > MAX_QUERY_LENGTH) return proxyError(414, 'query_too_long')

  if (!(await withinRateLimit(env, match.route.limiter, request))) {
    return proxyError(429, 'rate_limited', { 'retry-after': '60' })
  }

  let body: string | undefined
  if (request.method === 'POST') {
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
      return proxyError(415, 'json_required')
    }
    const text = await readBodyLimited(request)
    if (text === null) return proxyError(413, 'body_too_large')
    body = text
  }

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(`https://${match.upstream.host}${match.route.path}${url.search}`, {
      method: request.method,
      headers: buildUpstreamHeaders(request, match.upstream),
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
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

export function buildUpstreamHeaders(request: Request, upstream: Upstream): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  for (const [name, value] of Object.entries(upstream.extraHeaders ?? {})) headers.set(name, value)
  if (upstream.relayAkCookie) {
    const value = request.headers.get(AK_COOKIE_HEADER)
    if (value !== null && COOKIE_VALUE_PATTERN.test(value)) headers.set('cookie', `${AK_COOKIE_NAME}=${value}`)
  }
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

