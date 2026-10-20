/**
 * 云同步的请求转发（desktop/README.md 的“云同步”）。页面照旧 fetch('/api/cloud/v1/<op>')，和网页版是同一份代码
 * （src/lib/cloud/api.ts）；主进程在 app:// 协议（开发时是拦截的 http）里接住，原样转发到网站的云同步接口。
 * 维护者 2026-10-20：“打包版本要拉的是正式站点的数据，不拉测试站”，地址由 main.ts 决定。
 *
 * - 只转发云同步的操作（POST）和 info（GET），其余返回 404，不发请求；
 * - 请求体和响应体不解析、不记日志（里面有 authKey、鹰角 token 和密文），只限制大小；
 * - 不带 Cookie，不跟随跳转；
 * - Worker 的同源检查（worker/security.ts 的 checkSameOrigin）：带 x-arkrecord-client: 1，Referer 是网站首页。
 *   主进程用 Node 的 fetch 发请求（main.ts），没有 Origin 和 Sec-Fetch-Site，Worker 这时看 Referer。
 */

export const CLOUD_PREFIX = '/api/cloud/v1/'
/** 和 shared/cloud-protocol.ts 的 CLOUD_OPS 一致（cloud.test.ts 核对） */
export const CLOUD_OPS: ReadonlySet<string> = new Set(['status', 'claim', 'pull', 'push', 'rekey', 'twofactor', 'delete'])
/** 请求体上限：和 Worker 一样（2 字节长度 + 1 KB 头部 + 1 MB 信封） */
export const MAX_REQUEST_BYTES = 2 + 1024 + 1024 * 1024
/** 响应体上限：一次下载最多 4 MB 密文，加上头部和分隔 */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
/** 上传一批 1 MB 的密文、下载 4 MB 都要时间，网络慢时多给一些 */
const TIMEOUT_MS = 90_000
/** Worker 返回的错误码和限速等待时间：页面靠它们显示原因（api.ts 的 messageOf） */
const PASS_HEADERS = ['content-type', 'x-arkrecord-cloud', 'retry-after']
/** 这些状态码的响应不能带响应体 */
const NULL_BODY = new Set([204, 205, 304])

export type CloudFetcher = (url: string, init: RequestInit) => Promise<Response>

const reply = (status: number, code: string) =>
  new Response(null, { status, headers: { 'x-arkrecord-cloud': code, 'cache-control': 'no-store' } })

/** 读出请求体，超过上限时返回 null */
async function readLimited(body: Request | Response, limit: number): Promise<ArrayBuffer | null> {
  if (Number(body.headers.get('content-length') ?? '0') > limit) return null
  const buffer = await body.arrayBuffer()
  return buffer.byteLength > limit ? null : buffer
}

/**
 * 转发一个 /api/cloud/v1/ 请求。site 是网站地址（https://ark.kaltsit.dev 这样，不带路径）；没有时返回 503。
 * 网络出错返回 502（x-arkrecord-cloud: network），页面显示“网络连接失败”。
 */
export async function forwardCloud(request: Request, site: string | undefined, fetcher: CloudFetcher): Promise<Response> {
  const url = new URL(request.url)
  const op = url.pathname.slice(CLOUD_PREFIX.length)
  if (!url.pathname.startsWith(CLOUD_PREFIX) || url.search || !(op === 'info' || CLOUD_OPS.has(op))) return reply(404, 'not_found')
  const method = op === 'info' ? 'GET' : 'POST'
  if (request.method !== method) return reply(405, 'method_not_allowed')
  if (!site) return reply(503, 'cloud_unavailable')

  const headers: Record<string, string> = { 'x-arkrecord-client': '1', referer: `${site}/` }
  let body: ArrayBuffer | undefined
  if (method === 'POST') {
    const read = await readLimited(request, MAX_REQUEST_BYTES)
    if (!read) return reply(413, 'body_too_large')
    body = read
    headers['content-type'] = request.headers.get('content-type') ?? 'application/octet-stream'
  }

  let res: Response
  let data: ArrayBuffer | null
  try {
    res = await fetcher(`${site}${CLOUD_PREFIX}${op}`, {
      method,
      headers,
      body,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    data = await readLimited(res, MAX_RESPONSE_BYTES)
  } catch {
    return reply(502, 'network')
  }
  if (!data) return reply(502, 'bad_response')
  const out = new Headers({ 'cache-control': 'no-store' })
  for (const name of PASS_HEADERS) {
    const value = res.headers.get(name)
    if (value) out.set(name, value)
  }
  return new Response(NULL_BODY.has(res.status) ? null : data, { status: res.status, headers: out })
}
