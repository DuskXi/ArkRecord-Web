/**
 * 防止转发接口被其他网站或脚本滥用。
 *
 * 前端页面与 /api/* 同源，因此这里完全不需要 CORS：
 *   - 不返回任何 Access-Control-* 头，OPTIONS 预检一律拒绝；
 *   - 每个请求都必须带上自定义请求头 CLIENT_HEADER。其他网站在浏览器里带自定义头发跨站请求，
 *     会先触发 CORS 预检，而预检被拒绝，所以它们根本发不出这样的请求；
 *   - 再检查 Sec-Fetch-Site / Origin / Referer，确认请求来自本站页面。
 *
 * 请求头可以被非浏览器脚本伪造，所以这些检查只能挡住“其他网站借用”。
 * 脚本层面的滥用由限速（wrangler.jsonc 中的 ratelimits）和路径白名单兜底。
 */

export const CLIENT_HEADER = 'x-arkrecord-client'

export type OriginRejection = 'missing_client_header' | 'cross_origin'

export function checkSameOrigin(request: Request): OriginRejection | null {
  if (request.headers.get(CLIENT_HEADER) !== '1') return 'missing_client_header'

  const selfOrigin = new URL(request.url).origin
  const site = request.headers.get('sec-fetch-site')
  const origin = request.headers.get('origin')

  if (site !== null && site !== 'same-origin') return 'cross_origin'
  if (origin !== null && origin !== selfOrigin) return 'cross_origin'

  // 较旧的浏览器可能既不带 Sec-Fetch-Site，同源 GET 也不带 Origin，这时退回到检查 Referer。
  if (site === null && origin === null) {
    const referer = request.headers.get('referer')
    if (referer === null || originOf(referer) !== selfOrigin) return 'cross_origin'
  }
  return null
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}
