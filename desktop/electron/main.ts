/**
 * Electron 主进程：窗口、加载页面（开发时是 Vite 开发服务器，正式构建是 app:// 协议）、把页面的 RPC 请求转给 Python 后端。
 * 安全基线见 desktop/README.md：渲染进程开沙盒和上下文隔离、不开 Node；不开新窗口，不跳转到应用以外的地址。
 */
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent, app, ipcMain, nativeTheme, net, protocol, session } from 'electron'
import { Backend } from './backend.js'
import { openExternal } from './external.js'
import { checkHgLogin, hgLogin, isLoginSession } from './hg-login.js'
import { OFFICIAL_LOGIN, fakeLoginTarget } from './hg-login-rules.js'
import { IMAGE_PREFIX, serveImage } from './images.js'
import { deleteToken, keychainStatus, loadTokens, saveToken } from './keychain.js'
import { INVALID_PARAMS, METHOD_NOT_FOUND, RpcError, type RpcErrorObject } from './rpc.js'
import { runSmokeTest } from './smoke.js'

/** 正式构建用的协议：注册成 standard + secure，页面来源固定是 app://arkrecord，升级后 IndexedDB 里的数据还在 */
const APP_SCHEME = 'app'
const APP_HOST = 'arkrecord'

/**
 * 页面能调用的后端方法和各自的超时（desktop/README.md）。
 * hg.request 由后端按 shared/upstreams/hg.json 的白名单执行；后端对上游 20 秒超时，这里多留一些余量。
 */
const ALLOWED_METHODS = new Map([
  ['ping', 30_000],
  ['hg.request', 45_000],
  // 使用人数统计：后端马上返回，真正的上报在后台排队
  ['stats.status', 30_000],
  ['stats.setEnabled', 30_000],
  ['stats.report', 30_000],
])
/** 和后端约定的协议版本（desktop/README.md） */
const PROTOCOL_VERSION = 1
/** 第一次启动时 uv 可能要先创建虚拟环境，多给一些时间 */
const STARTUP_TIMEOUT_MS = 120_000

/** 页面用到的权限：复制文字和图片、申请持久存储（src/lib/db.ts）。其余一律拒绝 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'persistent-storage'])

/** 和网页版的 CSP（public/_headers）一致，去掉了 Cloudflare 统计脚本 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

/** 开发时由 desktop/electron/dev.mjs 传入，只接受本机地址；安装包里不读这个变量 */
function parseDevServerUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`开发服务器只能是本机地址：${value}`)
  }
  return url
}

const devServer = app.isPackaged ? undefined : parseDevServerUrl(process.env.ARKRECORD_DEV_SERVER_URL)
const smoke = !app.isPackaged && process.env.ARKRECORD_SMOKE === '1'
const rendererDir = join(import.meta.dirname, 'renderer')
/** 鹰角登录页。开发和冒烟测试可以换成本机的假登录页（dev.mjs 的 --fake-hg）；安装包里只用官方登录页 */
const fakeHgOrigin = app.isPackaged ? undefined : process.env.ARKRECORD_FAKE_HG_ORIGIN
const hgLoginTarget = fakeHgOrigin ? fakeLoginTarget(fakeHgOrigin) : OFFICIAL_LOGIN

/** 是不是应用自己的页面 */
function isAppUrl(value: string): boolean {
  const url = URL.parse(value)
  if (!url) return false
  if (devServer) return url.origin === devServer.origin
  return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST
}

const isFile = (file: string) => stat(file).then((s) => s.isFile(), () => false)

/** app://arkrecord/ 下的文件来自 vite build --mode desktop 的产物；/api/img/ 下的图片交给后端（和页面同源，分享图导出时 canvas 不会出错） */
async function serveAppFile(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.host !== APP_HOST) return new Response(null, { status: 404 })
  if (url.pathname.startsWith(IMAGE_PREFIX)) return serveImage(request, fetchImage)
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  let file = resolve(rendererDir, `.${path}`)
  if (file !== rendererDir && !file.startsWith(rendererDir + sep)) return new Response(null, { status: 404 })
  if (!(await isFile(file))) {
    // 页面地址（/history 等，没有扩展名）都返回 index.html，由前端路由处理
    if (extname(path)) return new Response(null, { status: 404 })
    file = join(rendererDir, 'index.html')
  }
  const response = await net.fetch(pathToFileURL(file).href)
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', CSP)
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(response.body, { status: response.status, headers })
}

/**
 * 使用人数统计的上报地址（desktop/README.md 的“使用人数统计”）：安装版报到正式站，开发版报到测试站。
 * 冒烟测试不设，测试数据不算进统计
 */
const STATS_URL = smoke ? undefined : app.isPackaged ? 'https://ark.kaltsit.dev' : 'https://ark-next.kaltsit.dev'

const backend = new Backend(() => {
  if (app.isPackaged) throw new Error('安装包里还没有带上后端（M4）')
  // 开发时在仓库根目录用 uv 启动，见 desktop/README.md
  return {
    command: 'uv',
    args: ['run', '--project', 'desktop/backend', 'python', '-m', 'arkrecord_backend'],
    cwd: app.getAppPath(),
    // 后端在数据目录里存 stats.json；没有上报地址时不上报（继承来的环境变量里有也删掉）
    env: { ARKRECORD_DATA_DIR: app.getPath('userData'), ARKRECORD_STATS_URL: STATS_URL },
  }
})

/** 后端拉一张图片的超时（后端对来源站有自己的超时，这里多留余量） */
const IMAGE_TIMEOUT_MS = 30_000

/** 图片只由主进程调用 img.fetch（页面不能直接调用，不在 ALLOWED_METHODS 里） */
const fetchImage = (source: string, target: string) => backend.request('img.fetch', { source, target }, IMAGE_TIMEOUT_MS)

/**
 * 开发模式：页面在 Vite 开发服务器上，只把开发服务器的 /api/img/ 交给后端，其余请求原样交给 Vite。
 * 只拦截应用自己的默认会话（登录窗口用的是单独的会话，不受影响）
 */
function interceptDevImages(server: URL): void {
  protocol.handle('http', (request) => {
    const url = URL.parse(request.url)
    if (url?.origin === server.origin && url.pathname.startsWith(IMAGE_PREFIX)) return serveImage(request, fetchImage)
    return net.fetch(request, { bypassCustomProtocolHandlers: true })
  })
}

let mainWindow: BrowserWindow | undefined

type RpcReply = { ok: true; result: unknown } | { ok: false; error: RpcErrorObject }

/** 只接受主窗口顶层页面、且是应用自己地址的请求 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  return mainWindow !== undefined && event.sender === mainWindow.webContents && frame !== null && frame.parent === null && isAppUrl(frame.url)
}

/**
 * 窗口按钮区的高度：自定义标题栏高 40px（src/components/shell/DesktopTitleBar.vue），
 * 最下面 1px 是分隔线，按钮区不盖住它
 */
const TITLE_BAR_HEIGHT = 39
const HEX_COLOR = /^#[0-9a-f]{6}$/i

/**
 * 不用系统标题栏，页面顶部是自己的标题栏（DesktopTitleBar）。
 * Windows / Linux：最小化、最大化、关闭按钮由 Electron 画在右上角，颜色由页面按深浅色设置（app.setTitleBar）；
 * macOS：红绿灯留在左上角。
 */
function titleBarOptions(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
  const dark = nativeTheme.shouldUseDarkColors
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: dark ? '#18181b' : '#ffffff', symbolColor: dark ? '#a1a1aa' : '#71717a', height: TITLE_BAR_HEIGHT } }
}

/** 页面切换深浅色时设置窗口按钮的颜色（只有 Windows、Linux 有这些按钮） */
async function setTitleBar(parent: BrowserWindow, params: unknown): Promise<object> {
  const { color, symbolColor } = (params ?? {}) as Record<string, unknown>
  if (typeof color !== 'string' || typeof symbolColor !== 'string' || !HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) {
    throw new RpcError(INVALID_PARAMS, '颜色只能是 #rrggbb')
  }
  if (process.platform !== 'darwin') parent.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT })
  return {}
}

/**
 * app. 开头的方法由主进程自己处理，不转给后端（desktop/README.md）。
 * app.hgLogin 的 token 只作为这次调用的返回值交给页面，主进程不保存。
 */
const APP_METHODS = new Map<string, (parent: BrowserWindow, params: unknown) => Promise<unknown>>([
  ['app.hgLogin', async (parent) => ({ token: await hgLogin(parent, hgLoginTarget) })],
  ['app.hgLoginCheck', async () => ({ checking: checkHgLogin() })],
  ['app.setTitleBar', setTitleBar],
  // 鹰角 token 只用系统钥匙串加密保存（keychain.ts）
  ['app.tokens.status', async () => keychainStatus()],
  ['app.tokens.load', loadTokens],
  ['app.tokens.save', async (_parent, params) => saveToken(params)],
  ['app.tokens.delete', async (_parent, params) => deleteToken(params)],
])

async function handleRpc(event: IpcMainInvokeEvent, method: unknown, params: unknown): Promise<RpcReply> {
  if (!isTrustedSender(event) || !mainWindow) throw new Error('只接受应用自己页面的请求')
  const appMethod = typeof method === 'string' ? APP_METHODS.get(method) : undefined
  const timeoutMs = typeof method === 'string' ? ALLOWED_METHODS.get(method) : undefined
  if (typeof method !== 'string' || (!appMethod && timeoutMs === undefined)) {
    return { ok: false, error: new RpcError(METHOD_NOT_FOUND, '不允许调用这个方法').toJSON() }
  }
  try {
    const result = appMethod ? await appMethod(mainWindow, params) : await backend.request(method, params, timeoutMs as number)
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: (error instanceof RpcError ? error : new RpcError(-32603, '主进程内部错误')).toJSON() }
  }
}

/** 启动时 ping 一次后端，结果写到终端 */
async function checkBackend(): Promise<void> {
  try {
    const result = (await backend.request('ping', undefined, STARTUP_TIMEOUT_MS)) as Record<string, unknown> | null
    if (result?.protocol !== PROTOCOL_VERSION) {
      console.error(`[backend] 协议版本不一致：主进程是 ${PROTOCOL_VERSION}，后端是 ${String(result?.protocol)}`)
      return
    }
    console.log(`[backend] ping 成功：backend ${String(result.backend)}，Python ${String(result.python)}`)
  } catch (error) {
    console.error(`[backend] ping 失败：${(error as Error).message}`)
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'ArkRecord',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#ffffff',
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'public/icons/record-128.png'),
    ...titleBarOptions(),
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
  // Windows / Linux 不要菜单栏（按 Alt 也不出来）；macOS 保留系统菜单（复制粘贴、退出等快捷键靠它）
  if (process.platform !== 'darwin') win.removeMenu()
  // 没有菜单以后，开发时用 F12 打开开发者工具
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F12') return
      event.preventDefault()
      win.webContents.toggleDevTools()
    })
  }
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })
  if (smoke) runSmokeTest(win, (ok) => app.exit(ok ? 0 : 1))
  void win.loadURL(devServer ? devServer.href : `${APP_SCHEME}://${APP_HOST}/`)
  return win
}

function showMainWindow(): void {
  if (!mainWindow) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

app.setName('ArkRecord')
// 开发和安装版的数据分开放（IndexedDB、单实例锁都在这个目录里）。
// 冒烟测试用 dev.mjs 每次新建的临时目录：不碰开发版的数据，也不和开着的开发版抢单实例锁
const smokeDataDir = smoke ? process.env.ARKRECORD_SMOKE_DATA_DIR : undefined
app.setPath('userData', smokeDataDir ?? join(app.getPath('appData'), app.isPackaged ? 'ArkRecord' : 'ArkRecord Dev'))
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])
app.enableSandbox()

app.on('web-contents-created', (_event, contents) => {
  // 鹰角登录窗口有自己的规则（hg-login.ts 的 guard）
  if (isLoginSession(contents.session)) return
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event) => {
    if (isAppUrl(event.url)) return
    event.preventDefault()
    openExternal(event.url)
  })
  contents.on('will-redirect', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

if (!app.requestSingleInstanceLock()) {
  // 已经有一个在运行：把它切到前面（second-instance），自己退出。冒烟测试这时什么都没测，不能算通过
  if (smoke) {
    console.error('[smoke] 已经有一个开发版在运行（同一个数据目录只能开一个），请先关掉它再跑冒烟测试')
    app.exit(1)
  } else {
    app.quit()
  }
} else {
  app.on('second-instance', showMainWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', showMainWindow)
  app.on('before-quit', () => backend.stop())

  void app.whenReady().then(async () => {
    const ses = session.defaultSession
    // Vite 开发服务器给依赖的地址带版本号，并让浏览器长期缓存；上次运行留下的缓存会让依赖版本对不上（504，页面空白）。
    // 开发时每次启动先清掉 HTTP 缓存（不影响 IndexedDB 里的数据）
    if (devServer) await ses.clearCache()
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl))
    })
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin))
    if (devServer) interceptDevImages(devServer)
    else protocol.handle(APP_SCHEME, serveAppFile)
    ipcMain.handle('arkrecord:rpc', handleRpc)

    showMainWindow()
    void checkBackend()
  })
}
