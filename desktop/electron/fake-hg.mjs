/**
 * 本机的假鹰角登录页：只给 `npm run desktop:dev -- --fake-hg` 和冒烟测试用，不编译进 dist、不进安装包。
 * 让应用内登录窗口的整套流程（跳转限制、取 token、清会话）不碰 hypergryph.com 就能跑通。
 *
 * - GET  /login             登录表单
 * - POST /login             设置一个 HttpOnly Cookie，跳到 /home
 * - GET  /home              “已登录”页面
 * - GET  /account/info/hg   有 Cookie 时返回假 token，格式和官方一样；没有时返回未登录
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const COOKIE = 'fake_hg_session'

const page = (title, body) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font: 15px/1.6 system-ui, sans-serif; margin: 3rem auto; max-width: 22rem">${body}</body></html>`

const LOGIN_PAGE = page(
  '假的鹰角登录页',
  '<h1>假的鹰角登录页</h1><p>只用于开发和冒烟测试，不会连接鹰角的服务器。</p>' +
    '<form method="post" action="/login"><button type="submit">登录</button></form>',
)
const HOME_PAGE = page('已登录（假）', '<h1>已登录</h1><p>应用会自动读取登录状态并关闭这个窗口。</p>')

/** 启动假登录页，返回地址、这次的假 token 和关闭函数 */
export async function startFakeHg() {
  const token = `fake-hg-token-${randomBytes(12).toString('hex')}`
  const sessionId = randomBytes(16).toString('hex')

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const loggedIn = (req.headers.cookie ?? '').split(/;\s*/).includes(`${COOKIE}=${sessionId}`)
    const send = (status, type, body) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body)

    if (req.method === 'GET' && path === '/login') return send(200, 'text/html; charset=utf-8', LOGIN_PAGE)
    if (req.method === 'POST' && path === '/login') {
      return res.writeHead(302, { 'set-cookie': `${COOKIE}=${sessionId}; HttpOnly; Path=/; SameSite=Lax`, location: '/home' }).end()
    }
    if (req.method === 'GET' && path === '/home') return send(200, 'text/html; charset=utf-8', HOME_PAGE)
    if (req.method === 'GET' && path === '/account/info/hg') {
      const body = loggedIn ? { code: 0, data: { content: token }, msg: 'OK' } : { code: 3, data: null, msg: '未登录' }
      return send(200, 'application/json', JSON.stringify(body))
    }
    return send(404, 'text/plain; charset=utf-8', 'not found')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}
