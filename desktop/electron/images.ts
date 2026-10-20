/**
 * 页面里的图片地址 /api/img/<来源>/<路径>（src/lib/meta.ts）：桌面版由主进程交给后端的 img.fetch，本机直接拉取，不经过 Worker。
 * 约定见 desktop/README.md 的“图片（img.fetch）”。这里不依赖 Electron，便于测试；正式构建（app://）和开发模式（拦截开发服务器的 http）都用它。
 *
 * - 解析方式和 Worker 一样（worker/images.ts 的 resolveImage）：第一段是来源，其余原样是路径，不解码；白名单由后端按 shared/images.json 检查。
 * - 地址带查询参数、格式不对、不是 GET 的，不交给后端。
 * - 同一张图同时被要多次（比如记录页里同一把武器出现很多次）只交给后端一次，大家共用结果（维护者：“哪怕相同图片并发，
 *   也应该合并为一个对云请求”）。后端再按来源站限速、合并，见 desktop/README.md。
 * - 成功的图片让 Chromium 缓存一天，翻页、切换页面时不用再问后端。
 */

export const IMAGE_PREFIX = '/api/img/'

/** 调用后端的 img.fetch（main.ts 里是 backend.request） */
export type ImageFetcher = (source: string, target: string) => Promise<unknown>

let forwarded = 0
/** 冒烟测试用：交给后端的图片请求一共有几个（合并以后的次数） */
export const forwardedImageRequests = (): number => forwarded

/** 正在向后端要的图片，键是“来源/路径”；结果出来（成功或失败）就删掉，之后的请求由后端的缓存回答 */
const inflight = new Map<string, Promise<unknown>>()

function fetchOnce(source: string, target: string, fetchImage: ImageFetcher): Promise<unknown> {
  const key = `${source}/${target}`
  let pending = inflight.get(key)
  if (!pending) {
    forwarded++
    pending = Promise.resolve()
      .then(() => fetchImage(source, target))
      .finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

const empty = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

function isImageResult(value: unknown): value is { status: number; contentType?: unknown; body?: unknown } {
  return typeof value === 'object' && value !== null && Number.isInteger((value as { status?: unknown }).status)
}

export async function serveImage(request: Request, fetchImage: ImageFetcher): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return empty(405)
  const url = new URL(request.url)
  if (url.search) return empty(404)
  const rest = url.pathname.slice(IMAGE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (!url.pathname.startsWith(IMAGE_PREFIX) || slash <= 0 || slash === rest.length - 1) return empty(404)

  let result: unknown
  try {
    result = await fetchOnce(rest.slice(0, slash), rest.slice(slash + 1), fetchImage)
  } catch {
    return empty(502)
  }
  if (!isImageResult(result)) return empty(502)
  if (result.status === 404 || result.status === 502) return empty(result.status)
  const { contentType, body } = result
  if (result.status !== 200 || typeof contentType !== 'string' || !contentType.startsWith('image/') || typeof body !== 'string') return empty(502)
  return new Response(Buffer.from(body, 'base64'), {
    status: 200,
    headers: {
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, max-age=86400',
    },
  })
}
