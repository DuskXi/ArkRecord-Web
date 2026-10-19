/**
 * 页面里的图片地址 /api/img/<来源>/<路径>（src/lib/meta.ts）：桌面版由主进程交给后端的 img.fetch，本机直接拉取，不经过 Worker。
 * 约定见 desktop/README.md 的“图片（img.fetch）”。这里不依赖 Electron，便于测试；正式构建（app://）和开发模式（拦截开发服务器的 http）都用它。
 *
 * - 解析方式和 Worker 一样（worker/images.ts 的 resolveImage）：第一段是来源，其余原样是路径，不解码；白名单由后端按 shared/images.json 检查。
 * - 地址带查询参数、格式不对、不是 GET 的，不交给后端。
 */

export const IMAGE_PREFIX = '/api/img/'

/** 调用后端的 img.fetch（main.ts 里是 backend.request） */
export type ImageFetcher = (source: string, target: string) => Promise<unknown>

let forwarded = 0
/** 冒烟测试用：交给后端的图片请求一共有几个 */
export const forwardedImageRequests = (): number => forwarded

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

  forwarded++
  let result: unknown
  try {
    result = await fetchImage(rest.slice(0, slash), rest.slice(slash + 1))
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
    },
  })
}
