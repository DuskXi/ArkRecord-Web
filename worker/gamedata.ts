/**
 * 明日方舟卡池表（PRTS）的缓存转发：网站构建时带了一份卡池数据（UP 名单等），之后才开放的新卡池要等下次部署。
 * 页面在记录里遇到构建数据里还没有 UP 名单的卡池时，经这里取 PRTS 的服务器侧卡池表，在浏览器里解析
 * （shared/ak-pools.js，和构建脚本是同一份代码；维护者 2026-11-03 决定“经 Worker 转发并缓存”）。
 *
 * - 只转发这一个固定地址，原样返回，不解析、不改内容；
 * - 结果缓存在 Cloudflare：每个机房 3 小时内最多向 PRTS 请求一次，PRTS 也看不到用户的 IP；
 * - 只接受本站页面的请求（和转发鹰角接口相同的同源检查），回源受限速保护；
 * - 不涉及任何账号信息：请求里没有 token、Cookie，PRTS 的卡池表是公开数据。
 */
import { checkSameOrigin } from './security'

export const GAMEDATA_PREFIX = '/api/gamedata/'
/** 页面请求的地址（src/lib/runtime-pools.ts） */
export const PRTS_GACHA_PATH = '/api/gamedata/prts-gacha'
const UPSTREAM = 'https://weedy.prts.wiki/gacha_table.json'
export const GAMEDATA_CACHE_SECONDS = 3 * 3600
/** 卡池表现在约 2.3 MB，留足余量 */
const MAX_BYTES = 16 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 20_000

export interface GamedataContext {
  /** 未命中缓存、需要回源时调用；返回 false 表示超出限速 */
  allowUpstream: () => Promise<boolean>
  waitUntil?: (promise: Promise<unknown>) => void
}

function gamedataError(status: number, code: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ proxy: code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-arkrecord-proxy': code, ...extra },
  })
}

export async function handleGamedata(request: Request, url: URL, ctx: GamedataContext): Promise<Response> {
  if (url.pathname !== PRTS_GACHA_PATH || url.search) return gamedataError(404, 'not_found')
  if (request.method !== 'GET') return gamedataError(405, 'method_not_allowed')
  const rejection = checkSameOrigin(request)
  if (rejection) return gamedataError(403, rejection)

  // 缓存键只由来源地址决定，与用户的请求头无关
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default
  const cacheKey = new Request(UPSTREAM)
  const cached = await cache?.match(cacheKey)
  if (cached) return cached

  if (!(await ctx.allowUpstream())) return gamedataError(429, 'rate_limited', { 'retry-after': '60' })

  let upstream: Response
  try {
    upstream = await fetch(UPSTREAM, {
      headers: { accept: 'application/json', 'user-agent': 'ArkRecord gamedata cache (+https://github.com/DuskXi/ArkRecord-Web)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheEverything: true, cacheTtl: GAMEDATA_CACHE_SECONDS },
    } as RequestInit)
  } catch {
    return gamedataError(502, 'upstream_unreachable')
  }
  if (upstream.status !== 200 || !(upstream.headers.get('content-type') ?? '').startsWith('application/json')) {
    return gamedataError(502, 'upstream_not_json')
  }
  if (Number(upstream.headers.get('content-length') ?? '0') > MAX_BYTES) return gamedataError(502, 'upstream_too_large')
  const body = await upstream.arrayBuffer()
  if (body.byteLength > MAX_BYTES) return gamedataError(502, 'upstream_too_large')

  const response = new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${GAMEDATA_CACHE_SECONDS}`,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    },
  })
  if (cache) {
    const put = cache.put(cacheKey, response.clone())
    if (ctx.waitUntil) ctx.waitUntil(put)
    else await put
  }
  return response
}
