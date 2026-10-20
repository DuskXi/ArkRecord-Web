/**
 * 冒烟测试（npm run desktop:smoke）：页面加载后在页面里调用 window.arkrecord，
 * 检查 ping、方法白名单、hg.request 的路由白名单、页面拿不到 Node、应用内登录窗口，结果写到终端，然后退出（退出码 0 表示通过）。
 * 不发出任何真实的网络请求：hg.request 只用白名单以外的路径，后端在发请求之前就会拒绝；登录窗口用本机的假登录页（fake-hg.mjs）。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type BrowserWindow, type WebContents, app, desktopCapturer, session } from 'electron'
import { currentLoginWindow, lastLoginPartition, recentBlocked } from './hg-login.js'
import { forwardedImageRequests } from './images.js'
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
  // 米哈游：只调 mhy.locate（只找目录，不读缓存、不发请求）；返回的路径里有用户名，只记格式对不对
  try {
    const located = await bridge.rpc('mhy.locate', { game: 'genshin' })
    out.mhyLocate = Boolean(located) && ['logs', 'searched', 'dataDirs'].every((key) => Array.isArray(located[key]))
  } catch (error) { out.mhyLocate = error }
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
  mhyLocate?: unknown
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
  // 关掉登录弹窗，后面的截图不被它挡住
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await sleep(500)
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

/**
 * 图片（/api/img/，交给后端的 img.fetch）：页面自己 fetch，开发模式走拦截的 http，正式构建走 app://。
 * 只用白名单以外的来源名：就算代码有问题也不会真的去拉图片。真的向来源站发过请求的话，image-cache 里会有缓存
 */
async function probeImages(win: BrowserWindow): Promise<Record<string, boolean>> {
  const status = (path: string) => win.webContents.executeJavaScript(`fetch(${JSON.stringify(path)}).then((r) => r.status, () => 'error')`) as Promise<number | string>
  const before = forwardedImageRequests()
  const notAllowed = await status('/api/img/arkrecord-smoke-test/not-allowed.png')
  const afterNotAllowed = forwardedImageRequests()
  const withQuery = await status('/api/img/arkrecord-smoke-test/not-allowed.png?v=1')
  const afterQuery = forwardedImageRequests()
  const cached = await readdir(join(app.getPath('userData'), 'image-cache')).then((files) => files.length, () => 0)
  console.log(`[smoke] 图片：${JSON.stringify({ notAllowed, withQuery, forwarded: afterQuery - before, cached })}`)
  return {
    '白名单以外的图片返回 404，没有发出请求': notAllowed === 404 && afterNotAllowed - before === 1 && cached === 0,
    '图片地址带查询参数时返回 404，不交给后端': withQuery === 404 && afterQuery === afterNotAllowed,
  }
}

/** 页面是不是在开发服务器上（只有开发服务器上能 import('/src/…')） */
const devPage = (win: BrowserWindow) => win.webContents.getURL().startsWith('http:')

/** 截图用的假原神记录：写进冒烟测试临时目录里的 arkrecord-mhy 库，截完图删掉。名字都是“测试…”，UID 是假的 */
const FAKE_MHY = `
  const accountId = 'genshin:100000000'
  const pools = [['301', '301'], ['400', '301'], ['302', '302'], ['200', '200']]
  const start = Date.parse('2026-08-01T00:00:00+08:00')
  const pulls = Array.from({ length: 160 }, (_, i) => {
    const [gachaType, pool] = pools[i % 4]
    const rank = i % 53 === 52 ? 5 : i % 10 === 9 ? 4 : 3
    const ts = start + i * 3600_000
    const time = new Date(ts + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    const name = rank === 5 ? '测试五星' + i : rank === 4 ? '测试四星' + (i % 7) : '测试三星' + (i % 5)
    return { accountId, id: String(1000000000000000000n + BigInt(i)), gachaType, pool, itemId: '', name, itemType: rank === 3 ? '武器' : '角色', rank, count: 1, time, ts, lang: 'zh-cn', source: 'api' }
  })
`

/** 在页面里点某个分段切换（厂商或游戏）里的一项，等页面切过去 */
const clickSegment = (group: '切换厂商' | '切换游戏', name: string) => `
  ;[...document.querySelectorAll('[aria-label="${group}"] [role="radio"]')].find((b) => b.textContent.trim() === ${JSON.stringify(name)})?.click();
  await new Promise((resolve) => setTimeout(resolve, 800));
`

/** 侧边栏现在的样子：两层切换的选项和选中项、有没有米哈游 / 鹰角的导航、页面路径和内容 */
const SIDEBAR_STATE = `
  const segment = (group) => {
    const buttons = [...document.querySelectorAll('[aria-label="' + group + '"] [role="radio"]')]
    return { items: buttons.map((b) => b.textContent.trim()), active: buttons.find((b) => b.getAttribute('aria-checked') === 'true')?.textContent.trim() }
  }
  const navText = (selector) => document.querySelector(selector)?.innerText ?? ''
  return {
    path: location.pathname,
    vendor: segment('切换厂商'),
    game: segment('切换游戏'),
    mhyNav: navText('[aria-label="米哈游导航"]'),
    hgNav: navText('[aria-label="鹰角导航"]').includes('寻访记录'),
    read: document.body.innerText.includes('从游戏缓存读取'),
    // 有记录时读取面板收进页面右上角的“读取”按钮（MhyReadButton）
    readButton: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '读取'),
    empty: document.body.innerText.includes('还没有原神的抽卡记录'),
    warp: document.body.innerText.includes('跃迁记录'),
    // 四款游戏的总览页（厂商切换最前面的“总览”）
    dashboard: document.body.innerText.includes('四款游戏') && !!document.querySelector('[aria-label="总览导航"]'),
    // 侧边栏顶部的名称：鹰角是 ARKRECORD，米哈游是 GAMERECORD
    brand: document.body.innerText.includes('GAMERECORD') ? 'GAMERECORD' : document.body.innerText.includes('ARKRECORD') ? 'ARKRECORD' : '',
  }
`

interface SidebarState {
  path: string
  vendor: { items: string[]; active?: string }
  game: { items: string[]; active?: string }
  mhyNav: string
  hgNav: boolean
  read: boolean
  readButton: boolean
  empty: boolean
  warp: boolean
  dashboard: boolean
  brand: string
}

/**
 * 侧边栏的两层切换（厂商 → 游戏，src/platform/active.ts）：先在鹰角选终末地，切到米哈游看到原神和米哈游自己的侧边栏，
 * 点“记录”进记录页，再切到星铁；切回鹰角还是终末地，再切到米哈游回到上次看的星铁，最后选回明日方舟。
 * 不点任何读取按钮，不发请求。
 * 网页版没有米哈游，由网页构建的检查保证（vite.config.ts 的 webWithoutDesktopCode）
 */
async function probeVendors(win: BrowserWindow): Promise<Record<string, boolean>> {
  const run = (code: string) => win.webContents.executeJavaScript(`(async () => { ${code} })()`) as Promise<unknown>
  const state = (before = '') => run(`${before}${SIDEBAR_STATE}`) as Promise<SidebarState>

  const hgStart = await state(clickSegment('切换游戏', '终末地'))
  const dash = await state(clickSegment('切换厂商', '总览'))
  if (SHOTS_DIR) {
    // 总览页是异步加载的组件，等它画出来再截图
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await shot(win.webContents, 'dashboard')
  }
  const mhy = await state(clickSegment('切换厂商', '米哈游'))
  if (SHOTS_DIR) {
    await shot(win.webContents, 'genshin-empty')
    // 只在开发服务器上能 import 页面用的模块
    if (devPage(win)) {
      await run(`${FAKE_MHY}
        const { mhyDb } = await import('/src/lib/mhy/db.ts')
        await mhyDb.accounts.put({ id: accountId, game: 'genshin', uid: '100000000', region: 'cn_gf01', gameBiz: 'hk4e_cn', utcOffset: 8, createdAt: Date.now(), lastSyncAt: Date.now() })
        await mhyDb.pulls.bulkPut(pulls)`)
      await shot(win.webContents, 'genshin-data')
    }
  }
  const records = await state(`[...document.querySelectorAll('[aria-label="米哈游导航"] a')].find((a) => a.textContent.trim() === '祈愿记录')?.click()
    await new Promise((resolve) => setTimeout(resolve, 800))`)
  if (SHOTS_DIR && devPage(win)) {
    await shot(win.webContents, 'genshin-list')
    await run(`${FAKE_MHY}
      const { mhyDb } = await import('/src/lib/mhy/db.ts')
      await mhyDb.pulls.where('accountId').equals(accountId).delete()
      await mhyDb.accounts.delete(accountId)`)
  }
  const starrail = await state(clickSegment('切换游戏', '星铁'))
  const hgBack = await state(clickSegment('切换厂商', '鹰角'))
  const mhyAgain = await state(clickSegment('切换厂商', '米哈游'))
  await run(`${clickSegment('切换厂商', '鹰角')}${clickSegment('切换游戏', '明日方舟')}`)
  console.log(`[smoke] 侧边栏：${JSON.stringify({ hgStart, dash, mhy, records, starrail, hgBack, mhyAgain })}`)

  return {
    '厂商切换依次是总览、鹰角、米哈游': mhy.vendor.items.join('/') === '总览/鹰角/米哈游',
    '总览：/home，四款游戏的卡片和总览导航，没有游戏切换，顶部是 GAMERECORD':
      dash.path === '/home' && dash.vendor.active === '总览' && dash.dashboard && dash.game.items.length === 0 && dash.brand === 'GAMERECORD',
    '切到米哈游：游戏切换里是原神和星铁，先进原神，侧边栏是米哈游的（总览 / 祈愿记录 / 高级统计等，没有鹰角的导航）':
      mhy.path === '/genshin' &&
      mhy.vendor.active === '米哈游' &&
      mhy.game.items.join('/') === '原神/星铁' &&
      mhy.game.active === '原神' &&
      mhy.mhyNav.includes('总览') &&
      mhy.mhyNav.includes('祈愿记录') &&
      mhy.mhyNav.includes('高级统计') &&
      !mhy.hgNav &&
      mhy.read,
    '米哈游的“记录”页（没有记录时是读取面板，有记录时右上角有“读取”）': records.path === '/genshin/records' && (records.read || records.readButton),
    '星铁：/starrail，界面说的是“跃迁记录”，侧边栏是米哈游的':
      starrail.path === '/starrail' && starrail.game.active === '星铁' && starrail.warp && starrail.read && starrail.mhyNav.includes('跃迁记录'),
    '再切到米哈游，回到上次看的星铁': mhyAgain.path === '/starrail' && mhyAgain.game.active === '星铁',
    '侧边栏顶部：鹰角是 ARKRECORD，米哈游是 GAMERECORD':
      hgStart.brand === 'ARKRECORD' && mhy.brand === 'GAMERECORD' && starrail.brand === 'GAMERECORD' && hgBack.brand === 'ARKRECORD',
    '切回鹰角：回到总览，还是之前选的终末地，侧边栏是鹰角的':
      hgStart.game.active === '终末地' &&
      hgBack.path === '/' &&
      hgBack.vendor.active === '鹰角' &&
      hgBack.game.items.join('/') === '明日方舟/终末地' &&
      hgBack.game.active === '终末地' &&
      hgBack.hgNav &&
      !hgBack.mhyNav,
  }
}

/** 页面发来的 stats.report：只记账号个数和有没有带同步识别码，不记内容 */
const statsReports: { accounts: number; hasUser: boolean }[] = []

/** main.ts 在冒烟测试时调用 */
export function noteStatsReport(params: unknown): void {
  const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
  statsReports.push({ accounts: Array.isArray(value.accounts) ? value.accounts.length : -1, hasUser: 'user' in value })
}

/** 冒烟测试是全新的数据目录，没开通过云同步：页面的 stats.report 不应该带同步识别码（src/stores/app.ts 在账号列表读出 3 秒后上报） */
async function probeStatsReports(): Promise<Record<string, boolean>> {
  await waitFor('页面的统计上报', () => (statsReports.length ? true : undefined)).catch(() => undefined)
  console.log(`[smoke] stats.report：${JSON.stringify(statsReports)}`)
  return { '没开通云同步时 stats.report 不带同步识别码': statsReports.length > 0 && statsReports.every((r) => !r.hasUser) }
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
    checks['mhy.locate 能调通（只找目录，不发请求）'] = result.mhyLocate === true
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
    let images: Record<string, boolean>
    try {
      images = { ...(await probeImages(win)), ...(await probeStatsReports()), ...(await probeVendors(win)) }
    } catch (error) {
      console.error(`[smoke] 图片检查出错：${(error as Error).message}`)
      images = { 图片检查没有跑完: false }
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
    finish(report(result, { ...tokens, ...images, ...login }))
  })
}
