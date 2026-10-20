/**
 * 本机的假云同步接口：只给冒烟测试用（dev.mjs --smoke），不编译进 dist、不进安装包。
 * 冒烟测试用它核对主进程的转发（cloud.ts）真正发出去的请求：能不能通过 Worker 的同源检查
 * （和 worker/security.ts 的 checkSameOrigin 一样的规则）、带没带 Cookie。不连接网站。
 *
 * - GET  /api/cloud/v1/info    {protocol: 1, available: false, seen}
 * - POST /api/cloud/v1/status  403，x-arkrecord-cloud: hg_required，{seen, bytes}
 * seen：这次请求的检查结果和一共收到了几个请求；请求体只记长度。
 */
import { createServer } from 'node:http'

const originOf = (value) => {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export async function startFakeCloud() {
  let count = 0
  let self = ''

  const server = createServer(async (req, res) => {
    count += 1
    let bytes = 0
    for await (const chunk of req) bytes += chunk.length
    const site = req.headers['sec-fetch-site'] ?? null
    const origin = req.headers.origin ?? null
    const referer = req.headers.referer ?? null
    let sameOrigin = req.headers['x-arkrecord-client'] === '1' && (site === null || site === 'same-origin') && (origin === null || origin === self)
    if (site === null && origin === null) sameOrigin &&= referer !== null && originOf(referer) === self
    const seen = { count, sameOrigin, cookie: 'cookie' in req.headers, origin: origin !== null, secFetchSite: site }
    const send = (status, body, headers = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body))

    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && path === '/api/cloud/v1/info') return send(200, { protocol: 1, commit: 'fake', available: false, seen })
    if (req.method === 'POST' && path === '/api/cloud/v1/status') return send(403, { seen, bytes }, { 'x-arkrecord-cloud': 'hg_required' })
    return send(404, { seen })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  self = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return {
    origin: self,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}
