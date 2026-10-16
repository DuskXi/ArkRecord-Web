/**
 * ArkRecord 的 Cloudflare Worker。
 *
 * 只做一件事：把本站页面发出的请求原样转发给白名单内的鹰角接口（原因见 upstreams.ts）。
 * 不解析、不记录、不存储任何请求或响应内容；不访问 PRTS 或其他第三方。
 * 静态页面由 Cloudflare 直接返回，不经过这里的代码（见 wrangler.jsonc 的 run_worker_first）。
 */

import { checkSameOrigin, CLIENT_HEADER } from './security'
import { findRoute, type Limiter, type Upstream } from './upstreams'

export interface Env {
  ASSETS?: Fetcher
  RL_AUTH?: RateLimit
  RL_DATA?: RateLimit
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith(API_PREFIX)) return handleProxy(request, env, url)
    if (url.pathname === '/api/health') return proxyError(200, 'ok')
    if (env.ASSETS) return env.ASSETS.fetch(request)
    return proxyError(404, 'not_found')
  },
} satisfies ExportedHandler<Env>

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

async function withinRateLimit(env: Env, limiter: Limiter, request: Request): Promise<boolean> {
  const binding = limiter === 'auth' ? env.RL_AUTH : env.RL_DATA
  if (!binding) return true
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const { success } = await binding.limit({ key: `${limiter}:${ip}` })
  return success
}

async function readBodyLimited(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return null
  const text = await request.text()
  return new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES ? null : text
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

export { CLIENT_HEADER }
