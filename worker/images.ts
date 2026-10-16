/**
 * 图片缓存转发：只为本站页面服务，结果缓存在 Cloudflare，尽量少向来源站发请求。
 *
 * 大部分头像在构建时已经镜像为本站的静态文件（见 scripts/sync-gamedata.mjs），线上不会访问来源站。
 * 这里只处理构建时还拿不到的图片：
 *   - 明日方舟新干员在下一次构建之前的头像（PRTS）；
 *   - 终末地卡池图（鹰角官方 CDN，随卡池变化）。
 *
 * 同一张图片在每个 Cloudflare 机房只回源一次，之后 30 天都由缓存返回；来源站返回 404 时也缓存 1 小时。
 * 图片同源返回，分享图导出（canvas）时不会因为跨域图片而失败。
 */

export const IMAGE_PREFIX = '/api/img/'

export interface ImageSource {
  host: string
  /** 用途（同时显示在网站的“关于”页面） */
  purpose: string
  /** 允许的路径（不含开头的 /），必须完整匹配 */
  pattern: RegExp
  /** 把允许的路径映射为来源站上的路径 */
  toPath: (target: string) => string
}

export const IMAGE_SOURCES = {
  'prts-avatar': {
    host: 'torappu.prts.wiki',
    purpose: '明日方舟干员头像（只用于本站镜像里还没有的新干员）',
    pattern: /^char_\w{1,60}$/,
    toPath: (id: string) => `/assets/char_avatar/${id}.png`,
  },
  hycdn: {
    host: 'web.hycdn.cn',
    purpose: '终末地卡池图（鹰角官方 CDN）',
    pattern: /^upload\/image\/\d{8}\/[0-9a-f]{32}\.(?:png|jpe?g|webp)$/,
    toPath: (path: string) => `/${path}`,
  },
} satisfies Record<string, ImageSource>

export type ImageSourceName = keyof typeof IMAGE_SOURCES

const CACHE_SECONDS = 30 * 24 * 3600
const MISSING_SECONDS = 3600
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 15_000

/** 把允许的路径解析为来源站地址；不在白名单内时返回 null */
export function resolveImage(pathname: string): string | null {
  const rest = pathname.slice(IMAGE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const name = rest.slice(0, slash)
  if (!Object.hasOwn(IMAGE_SOURCES, name)) return null
  const source: ImageSource = IMAGE_SOURCES[name as ImageSourceName]
  const target = rest.slice(slash + 1)
  return source.pattern.test(target) ? `https://${source.host}${source.toPath(target)}` : null
}

/**
 * 图片由 <img> 加载，不能带自定义请求头，所以这里只拦截浏览器里的跨站引用（盗链）：
 * Sec-Fetch-Site 为 same-origin 或 none（直接打开）时放行；Origin、Referer 存在时必须是本站。
 */
export function checkImageOrigin(request: Request): 'cross_origin' | null {
  const selfOrigin = new URL(request.url).origin
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return 'cross_origin'
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== selfOrigin) return 'cross_origin'
  const referer = request.headers.get('referer')
  if (referer !== null && originOf(referer) !== selfOrigin) return 'cross_origin'
  return null
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export interface ImageContext {
  /** 未命中缓存、需要回源时调用；返回 false 表示超出限速 */
  allowUpstream: () => Promise<boolean>
  waitUntil?: (promise: Promise<unknown>) => void
}

export async function handleImage(request: Request, url: URL, ctx: ImageContext): Promise<Response> {
  if (request.method !== 'GET') return imageError(405, 'method_not_allowed')
  const rejection = checkImageOrigin(request)
  if (rejection) return imageError(403, rejection)
  const upstreamUrl = resolveImage(url.pathname)
  if (!upstreamUrl || url.search) return imageError(404, 'image_not_allowed')

  // 缓存键只由来源地址决定，与用户的请求头无关
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default
  const cacheKey = new Request(upstreamUrl)
  const cached = await cache?.match(cacheKey)
  if (cached) return cached

  if (!(await ctx.allowUpstream())) return imageError(429, 'rate_limited', { 'retry-after': '60' })

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { accept: 'image/avif,image/webp,image/png,image/*;q=0.8', 'user-agent': 'ArkRecord image cache (+https://github.com/DuskXi/ArkRecord-Web)' },
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
    } as RequestInit)
  } catch {
    return imageError(502, 'upstream_unreachable')
  }

  let response: Response
  if (upstream.status === 404) {
    response = new Response(null, {
      status: 404,
      headers: { 'cache-control': `public, max-age=${MISSING_SECONDS}`, 'x-arkrecord-proxy': 'image_missing' },
    })
  } else {
    const contentType = upstream.headers.get('content-type') ?? ''
    if (upstream.status !== 200 || !contentType.startsWith('image/')) return imageError(502, 'upstream_not_image')
    if (Number(upstream.headers.get('content-length') ?? '0') > MAX_IMAGE_BYTES) return imageError(502, 'image_too_large')
    const body = await upstream.arrayBuffer()
    if (body.byteLength > MAX_IMAGE_BYTES) return imageError(502, 'image_too_large')
    response = new Response(body, {
      headers: {
        'content-type': contentType,
        'cache-control': `public, max-age=${CACHE_SECONDS}, immutable`,
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
    })
  }
  if (cache) {
    const put = cache.put(cacheKey, response.clone())
    if (ctx.waitUntil) ctx.waitUntil(put)
    else await put
  }
  return response
}

function imageError(status: number, code: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', 'x-arkrecord-proxy': code, ...extra } })
}
