/**
 * 冒烟测试（npm run desktop:smoke）：页面加载后在页面里调用 window.arkrecord，
 * 检查 ping、方法白名单、hg.request 的路由白名单、页面拿不到 Node、应用内登录窗口，结果写到终端，然后退出（退出码 0 表示通过）。
 * 不发出任何真实的网络请求：hg.request 只用白名单以外的路径，后端在发请求之前就会拒绝；登录窗口用本机的假登录页（fake-hg.mjs）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type BrowserWindow, type WebContents, app, desktopCapturer, session } from 'electron'
import { currentLoginWindow, lastLoginPartition, recentBlocked } from './hg-login.js'
import { TOKEN_FILE } from './token-store.js'

/** 截图目录（dev.mjs --smoke --shots <目录>）：看界面效果用，不设就不截图 */
const SHOTS_DIR = process.env.ARKRECORD_SMOKE_SHOTS

const TIMEOUT_MS = 180_000
/** 应用没挂载时等页面刷新的时间：开发服务器重新预构建依赖后会自动刷新页面（之前的请求返回 504） */
const RELOAD_WAIT_MS = 30_000

/** 在页面里执行（和页面自己的代码一样，只能用 window.arkrecord） */
const PROBE = `(async () => {
  const bridge = window.arkrecord
  const mounted = () => document.querySelector('#app') !== null && document.querySelector('#app .boot') === null
  for (let i = 0; i < 100 && !mounted(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  const out = {
    bridge: typeof bridge,
    platform: bridge && bridge.platform,
    nodeInPage: typeof require !== 'undefined' || typeof process !== 'undefined',
    appMounted: mounted(),
  }
  if (!out.appMounted) {
    out.failedRequests = performance.getEntriesByType('resource').filter((r) => r.responseStatus >= 400).map((r) => r.responseStatus + ' ' + r.name).slice(0, 5)
    return out
  }
  try { out.ping = await bridge.rpc('ping') } catch (error) { out.pingError = error }
  // 桌面版不弹 Cookie / 统计同意；冒烟测试不设上报地址，统计不可用
  out.consentBanner = document.body.innerText.includes('Cookie 与统计')
  try { out.stats = await bridge.rpc('stats.status') } catch (error) { out.stats = error }
  try { await bridge.rpc('fs.readFile', ['C:/secret']); out.blocked = null } catch (error) { out.blocked = error }
  try {
    const result = await bridge.rpc('hg.request', { upstream: 'ak', path: '/arkrecord-smoke-test/not-allowed', envelope: '{}' })
    out.hgRoute = result && result.headers ? result.headers['x-arkrecord-proxy'] : result
  } catch (error) { out.hgRoute = error }
  if (location.protocol === 'app:') {
    const status = async (path) => { try { return (await fetch(path)).status } catch { return 'error' } }
    const home = await fetch('/')
    out.files = {
      csp: (home.headers.get('content-security-policy') || '').includes("default-src 'self'"),
      spaFallback: (await fetch('/history')).headers.get('content-type'),
      missingAsset: await status('/assets/missing.js'),
      traversal: await status('/..%2f..%2f..%2fpackage.json'),
      traversalBackslash: await status('/..%5c..%5c..%5cpackage.json'),
    }
  }
  return out
})()`

interface ProbeResult {
  bridge: string
  platform?: string
  nodeInPage: boolean
  appMounted: boolean
  failedRequests?: string[]
  ping?: { pong?: boolean; protocol?: number }
  pingError?: unknown
  consentBanner?: boolean
  stats?: { available?: unknown; enabled?: unknown; code?: number }
  blocked?: { code?: number } | null
  hgRoute?: unknown
  /** 只有 app:// 协议（正式构建）才检查 */
  files?: { csp: boolean; spaFallback: string | null; missingAsset: number | string; traversal: number | string; traversalBackslash: number | string }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 每 100 毫秒检查一次，直到 get() 有值；超时抛错 */
async function waitFor<T>(what: string, get: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(100)) {
    const value = get()
    if (value !== undefined) return value
  }
  throw new Error(`等待${what}超时`)
}

async function shot(contents: WebContents, name: string): Promise<void> {
  if (!SHOTS_DIR) return
  // 等弹窗动画结束
  await sleep(800)
  const image = await contents.capturePage()
  await mkdir(SHOTS_DIR, { recursive: true })
  await writeFile(join(SHOTS_DIR, `${name}.png`), image.toPNG())
}

/** 整个窗口的截图（经系统的窗口截图，包括 Electron 画的窗口按钮；页面截图里没有它们） */
async function shotWindow(win: BrowserWindow, name: string): Promise<void> {
  if (!SHOTS_DIR) return
  await sleep(800)
  const [width, height] = win.getSize()
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: width ?? 1280, height: height ?? 860 } })
  const source = sources.find((s) => s.id === win.getMediaSourceId())
  if (!source) throw new Error('没有找到主窗口的截图来源')
  await mkdir(SHOTS_DIR, { recursive: true })
  await writeFile(join(SHOTS_DIR, `${name}.png`), source.thumbnail.toPNG())
}

/** 截主窗口（浅色、深色）和桌面版的登录弹窗：点最后一个“添加账号”（第一次打开时是欢迎弹窗里的，它会关掉欢迎弹窗再打开登录弹窗） */
async function shotPages(win: BrowserWindow): Promise<void> {
  if (!SHOTS_DIR) return
  await shot(win.webContents, 'main')
  const dark = (await win.webContents.executeJavaScript(`document.documentElement.classList.contains('dark')`)) as boolean
  await shotWindow(win, dark ? 'window-dark' : 'window-light')
  await win.webContents.executeJavaScript(`void document.documentElement.classList.toggle('dark')`)
  await shotWindow(win, dark ? 'window-light' : 'window-dark')
  await win.webContents.executeJavaScript(`void document.documentElement.classList.toggle('dark')`)
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '添加账号').pop()?.click()`)
  await sleep(700)
  await shot(win.webContents, 'login-modal')
}

interface LoginCall {
  ok: boolean
  token?: unknown
  error?: { code?: number; data?: { kind?: string } }
}

/** 在页面里调用 app.hgLogin（和 LoginModal 一样），不等它结束 */
const callLogin = (win: BrowserWindow) =>
  win.webContents.executeJavaScript(
    `window.arkrecord.rpc('app.hgLogin').then((r) => ({ ok: true, token: r && r.token }), (e) => ({ ok: false, error: e }))`,
  ) as Promise<LoginCall>

/** 登录窗口的五项检查：用本机的假登录页，不连接鹰角 */
async function probeLogin(win: BrowserWindow, expectedToken: string): Promise<Record<string, boolean>> {
  // 1. 登录成功：先检查窗口里的隔离和跳转限制，再提交假登录页的表单
  const success = callLogin(win)
  const login = await waitFor('登录窗口', currentLoginWindow)
  const contents = login.webContents
  await waitFor('登录页加载', () => (contents.getURL() && !contents.isLoading() ? true : undefined))
  await shot(contents, 'login-window')
  const bridgeInLogin = (await contents.executeJavaScript('typeof window.arkrecord')) as string
  const loginUrl = contents.getURL()
  // 白名单以外的地址：用 http，被拦下后也不会交给系统浏览器
  await contents.executeJavaScript(`void (location.href = 'http://127.0.0.1:9/arkrecord-smoke-test')`)
  await sleep(1000)
  const stayed = contents.getURL() === loginUrl
  // 开发版的拦截日志：顶层页面和子框架分开标注，只有域名（假登录页里有一个白名单以外的子框架）
  const blockedLog = [...recentBlocked()]
  await contents.executeJavaScript(`void setTimeout(() => document.querySelector('form').submit(), 0)`)
  const first = await success
  const partition = lastLoginPartition()
  const cookiesLeft = partition ? (await session.fromPartition(partition).cookies.get({})).length : -1

  // 2. 用户关掉登录窗口
  const cancel = callLogin(win)
  const second = await waitFor('第二个登录窗口', () => {
    const current = currentLoginWindow()
    return current && current !== login ? current : undefined
  })
  second.close()
  const cancelled = await cancel

  console.log(
    `[smoke] 登录窗口：${JSON.stringify({ bridgeInLogin, stayed, blockedLog, first: { ok: first.ok, error: first.error }, cookiesLeft, cancelled })}`,
  )
  return {
    '登录窗口里拿不到 window.arkrecord': bridgeInLogin === 'undefined',
    '登录窗口跳到白名单以外的地址被拦下': stayed,
    '拦截日志分开标注顶层页面和子框架，只有域名':
      blockedLog.includes('顶层页面 127.0.0.1') &&
      blockedLog.includes('子框架 localhost') &&
      !blockedLog.some((entry) => /smoke-test|secret|:9|\//.test(entry)),
    '假登录页登录后拿到 token': first.ok && first.token === expectedToken,
    '登录结束后分区被清空': cookiesLeft === 0,
    '关闭登录窗口返回 cancelled': !cancelled.ok && cancelled.error?.code === -32000 && cancelled.error.data?.kind === 'cancelled',
  }
}

interface RpcCall {
  ok: boolean
  r?: Record<string, unknown>
  e?: { code?: number }
}

/** 在页面里调用 window.arkrecord.rpc（和页面自己的代码走同一条路） */
const pageRpc = (win: BrowserWindow, method: string, params?: unknown) =>
  win.webContents.executeJavaScript(
    `window.arkrecord.rpc(${JSON.stringify(method)}${params === undefined ? '' : `, ${JSON.stringify(params)}`}).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }))`,
  ) as Promise<RpcCall>

/** 冒烟测试用的假账号，不会和真实账号重名 */
const FAKE_ACCOUNT = 'arknights:arkrecord-smoke-test'
const tokensOf = (call: RpcCall) => (call.r?.tokens ?? {}) as Record<string, unknown>

/** token 保存：用假账号、假 token 走一遍 save → load → delete，结束后文件里没有残留。钥匙串不可用时只检查状态能查到 */
async function probeTokens(win: BrowserWindow): Promise<Record<string, boolean>> {
  const status = await pageRpc(win, 'app.tokens.status')
  const backend = String(status.r?.backend)
  if (!status.ok || status.r?.available !== true) {
    console.log(`[smoke] 系统钥匙串不可用（${backend}），跳过 token 保存检查`)
    return { '能查到系统钥匙串的状态': status.ok }
  }
  const token = `arkrecord-smoke-test-${randomUUID()}`
  const file = join(app.getPath('userData'), TOKEN_FILE)
  const readRaw = () => readFile(file, 'utf8').catch(() => '')

  const saved = await pageRpc(win, 'app.tokens.save', { accountId: FAKE_ACCOUNT, token })
  const raw = await readRaw()
  const loaded = await pageRpc(win, 'app.tokens.load')
  const deleted = await pageRpc(win, 'app.tokens.delete', { accountId: FAKE_ACCOUNT })
  const after = await pageRpc(win, 'app.tokens.load')
  const rawAfter = await readRaw()
  const badId = await pageRpc(win, 'app.tokens.save', { accountId: 'genshin:1', token })
  const badToken = await pageRpc(win, 'app.tokens.save', { accountId: FAKE_ACCOUNT, token: 'has space' })

  console.log(`[smoke] token 保存：钥匙串 ${backend}`)
  return {
    'token 保存后能读回同样的值': saved.ok && loaded.ok && tokensOf(loaded)[FAKE_ACCOUNT] === token,
    'hg-tokens.json 里只有密文': raw.includes(FAKE_ACCOUNT) && !raw.includes(token),
    'token 删除后读不到，文件里没有残留': deleted.ok && after.ok && !(FAKE_ACCOUNT in tokensOf(after)) && !rawAfter.includes(FAKE_ACCOUNT),
    '格式不对的 accountId 和 token 被拒绝（-32602）': badId.e?.code === -32602 && badToken.e?.code === -32602,
  }
}

interface VaultProbe {
  skipped?: boolean
  error?: string
  missingOk?: boolean
  roundTrip?: boolean
  deleted?: boolean
}

/**
 * 账号表和 token 钩子（src/lib/token-vault.ts）：在页面里像 LoginModal 那样新增一个假账号（先查是否已存在），读回、再删掉。
 * 只在开发服务器上跑（要用 import('/src/lib/db.ts') 拿到页面用的同一个数据库）
 */
async function probeAccountVault(win: BrowserWindow): Promise<Record<string, boolean>> {
  const token = `arkrecord-smoke-test-${randomUUID()}`
  const result = (await win.webContents.executeJavaScript(`(async () => {
    if (location.protocol === 'app:') return { skipped: true }
    try {
      const { db } = await import('/src/lib/db.ts')
      const id = ${JSON.stringify(FAKE_ACCOUNT)}
      const missing = await db.accounts.get('arknights:arkrecord-smoke-missing')
      const existing = await db.accounts.get(id)
      await db.accounts.put({ id, game: 'arknights', uid: 'arkrecord-smoke-test', nickName: 'smoke test', createdAt: existing ? existing.createdAt : Date.now(), accountToken: ${JSON.stringify(token)} })
      const read = await db.accounts.get(id)
      await db.accounts.delete(id)
      const after = await db.accounts.get(id)
      return { missingOk: missing === undefined, roundTrip: Boolean(read) && read.accountToken === ${JSON.stringify(token)}, deleted: after === undefined }
    } catch (error) {
      return { error: String(error && error.message || error) }
    }
  })()`)) as VaultProbe
  if (result.skipped) return {}
  // 钥匙串里的删除是页面发出去不等结果的，稍等一下再看文件
  await sleep(500)
  const raw = await readFile(join(app.getPath('userData'), TOKEN_FILE), 'utf8').catch(() => '')
  console.log(`[smoke] 账号表：${JSON.stringify(result)}`)
  return {
    '读不存在的账号不出错（LoginModal 新增账号前会先查）': result.error === undefined && result.missingOk === true,
    '新增账号带 token，读回来一致': result.roundTrip === true,
    '删除账号后读不到，钥匙串文件里没有残留': result.deleted === true && !raw.includes(FAKE_ACCOUNT),
  }
}

function report(result: ProbeResult, extra: Record<string, boolean>): boolean {
  const checks: Record<string, boolean> = {
    '页面有 window.arkrecord': result.bridge === 'object',
    'platform 正确': result.platform === process.platform,
    '页面里没有 require / process': !result.nodeInPage,
    '应用已挂载': result.appMounted,
  }
  if (result.appMounted) {
    checks['ping 成功、协议版本 1'] = result.ping?.pong === true && result.ping.protocol === 1
    checks['桌面版没有 Cookie / 统计同意弹窗'] = result.consentBanner === false
    checks['冒烟测试不上报统计（stats.status 的 available 为 false）'] = result.stats?.available === false
    checks['白名单以外的方法被拒绝（-32601）'] = result.blocked?.code === -32601
    checks['hg.request 拒绝白名单以外的路径（route_not_allowed）'] = result.hgRoute === 'route_not_allowed'
  }
  if (result.files) {
    checks['app:// 响应带 CSP'] = result.files.csp
    checks['app:// 页面地址回退到 index.html'] = result.files.spaFallback?.startsWith('text/html') === true
    checks['app:// 不存在的文件返回 404'] = result.files.missingAsset === 404
    checks['app:// 读不到产物目录以外的文件'] = result.files.traversal === 404 && result.files.traversalBackslash === 404
  }
  Object.assign(checks, extra)
  console.log(`[smoke] ${JSON.stringify(result)}`)
  for (const [name, ok] of Object.entries(checks)) console.log(`[smoke] ${ok ? '通过' : '失败'}：${name}`)
  return Object.values(checks).every(Boolean)
}

export function runSmokeTest(win: BrowserWindow, done: (ok: boolean) => void): void {
  let finished = false
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  const finish = (ok: boolean) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearTimeout(reloadTimer)
    done(ok)
  }
  const timer = setTimeout(() => {
    console.error('[smoke] 超时')
    finish(false)
  }, TIMEOUT_MS)

  // 页面里的报错也写到终端，检查失败时好找原因
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.log(`[smoke] 页面报错：${event.message}`)
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    // -3（ERR_ABORTED）是页面刷新时取消了上一次加载，不算失败
    if (code === -3) return
    console.error(`[smoke] 页面加载失败：${code} ${description}`)
    finish(false)
  })
  win.webContents.on('did-finish-load', async () => {
    clearTimeout(reloadTimer)
    let result: ProbeResult
    try {
      result = (await win.webContents.executeJavaScript(PROBE)) as ProbeResult
    } catch (error) {
      // 检查途中页面刷新了，等下一次加载完成
      console.log(`[smoke] 检查被打断（${(error as Error).message}），等页面重新加载`)
      return
    }
    if (finished) return
    if (!result.appMounted) {
      console.log(`[smoke] 应用还没挂载，等页面刷新：${JSON.stringify(result.failedRequests ?? [])}`)
      reloadTimer = setTimeout(() => finish(report(result, {})), RELOAD_WAIT_MS)
      return
    }
    await shotPages(win).catch((error: unknown) => console.error(`[smoke] 截图失败：${(error as Error).message}`))
    let tokens: Record<string, boolean>
    try {
      tokens = { ...(await probeTokens(win)), ...(await probeAccountVault(win)) }
    } catch (error) {
      console.error(`[smoke] token 保存检查出错：${(error as Error).message}`)
      tokens = { token保存检查没有跑完: false }
    }
    // 只有带着假登录页启动时（dev.mjs --smoke）才检查登录窗口
    const fakeToken = process.env.ARKRECORD_FAKE_HG_TOKEN
    let login: Record<string, boolean> = {}
    if (fakeToken) {
      try {
        login = await probeLogin(win, fakeToken)
      } catch (error) {
        console.error(`[smoke] 登录窗口检查出错：${(error as Error).message}`)
        login = { 登录窗口检查没有跑完: false }
      }
    }
    finish(report(result, { ...tokens, ...login }))
  })
}
