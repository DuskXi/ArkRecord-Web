/**
 * 应用内鹰角登录窗口（docs/desktop/plan.md 的“应用内鹰角登录窗口”）。
 *
 * 每次登录用一个新的内存分区打开官方登录页，用户自己登录；主进程在这个会话里请求 account/info/hg 取 token，
 * 作为这次调用的返回值交给页面。结束时清掉会话的全部存储，再销毁窗口。
 * 不向登录页注入脚本，不读页面内容；token 不写日志、不进报错信息，交出去以后主进程不保存。
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, type Session, type WebContents, app, session } from 'electron'
import { openExternal } from './external.js'
import type { BlockedKind, HgLoginTarget } from './hg-login-rules.js'
import { blockedHost, tokenFromInfo } from './hg-login-rules.js'
import { APP_ERROR, RpcError } from './rpc.js'

/** 页面跳转后等多久再查登录状态 */
const CHECK_DEBOUNCE_MS = 1000
/** 每个窗口最多查几次（不做高频轮询，避免触发风控） */
const MAX_CHECKS = 20
const LOGIN_TIMEOUT_MS = 10 * 60_000
const TITLE = '鹰角网络通行证登录'

const loginSessions = new WeakSet<Session>()

/** 登录窗口用自己的跳转规则（见 guard），主进程的全局规则要跳过它 */
export function isLoginSession(ses: Session): boolean {
  return loginSessions.has(ses)
}

interface ActiveLogin {
  window: BrowserWindow
  promise: Promise<string>
  check(): void
}

let active: ActiveLogin | undefined
let lastPartition: string | undefined

/** 冒烟测试用：当前的登录窗口、最近一次登录用的分区 */
export const currentLoginWindow = (): BrowserWindow | undefined => active?.window
export const lastLoginPartition = (): string | undefined => lastPartition

const loginError = (kind: 'cancelled' | 'login_failed', message: string) => new RpcError(APP_ERROR, message, { kind })

const MAX_BLOCKED = 50
const blocked: string[] = []

/** 冒烟测试用：开发版里最近被拦下的跳转（只有类型和域名） */
export const recentBlocked = (): readonly string[] => blocked

/**
 * 开发版：被拦下的跳转只记类型和域名（不记端口、路径、参数和 fragment），真机测试时用来确认白名单够不够。
 * 安装包里不记
 */
function noteBlocked(kind: BlockedKind, value: string): void {
  if (app.isPackaged) return
  const entry = `${kind} ${blockedHost(value)}`
  blocked.push(entry)
  if (blocked.length > MAX_BLOCKED) blocked.shift()
  devLog(`拦下：${entry}`)
}

/** 登录窗口里只允许 target 的地址；其他链接交给系统浏览器，新窗口、webview 一律拒绝 */
function guard(contents: WebContents, target: HgLoginTarget): void {
  const allowed = (value: string, isMainFrame: boolean) => {
    const url = URL.parse(value)
    return url !== null && (isMainFrame ? target.allowTop(url) : target.allowFrame(url))
  }
  contents.setWindowOpenHandler(({ url }) => {
    noteBlocked('新窗口', url)
    openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-frame-navigate', (event) => {
    if (allowed(event.url, event.isMainFrame)) return
    event.preventDefault()
    noteBlocked(event.isMainFrame ? '顶层页面' : '子框架', event.url)
    if (event.isMainFrame) openExternal(event.url)
  })
  contents.on('will-redirect', (event) => {
    if (allowed(event.url, event.isMainFrame)) return
    event.preventDefault()
    noteBlocked(event.isMainFrame ? '顶层页面' : '子框架', event.url)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

/** 清掉登录会话的 Cookie、各种存储、缓存和认证缓存。不调用鹰角的退出接口（可能让刚拿到的 token 失效） */
async function clearSession(ses: Session): Promise<void> {
  try {
    await ses.clearStorageData()
    await ses.clearCache()
    await ses.clearAuthCache()
  } catch (error) {
    console.error(`[hg-login] 清理登录会话失败：${(error as Error).message}`)
  }
}

/** 开发版的调试输出（只有域名、次数、状态码和结果，不带 token）；安装包里不输出 */
function devLog(message: string): void {
  if (!app.isPackaged) console.log(`[hg-login] ${message}`)
}

/** 在登录会话里请求 account/info/hg；没登录、网络错误、不是 JSON 时 token 是 undefined。status 只给开发版日志用 */
async function fetchToken(ses: Session, infoUrl: string): Promise<{ token: string | undefined; status: string }> {
  try {
    const response = await ses.fetch(infoUrl, { credentials: 'include', cache: 'no-store', redirect: 'error' })
    const token = response.ok ? tokenFromInfo(await response.json().catch(() => null)) : undefined
    return { token, status: `HTTP ${response.status}` }
  } catch {
    return { token: undefined, status: '网络错误' }
  }
}

function openLogin(parent: BrowserWindow, target: HgLoginTarget): ActiveLogin {
  const partition = `hg-login-${randomUUID()}`
  // 不带 persist: 前缀：内存分区，Cookie 和缓存不写磁盘
  const ses = session.fromPartition(partition)
  loginSessions.add(ses)
  lastPartition = partition
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())

  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 520,
    height: 760,
    show: false,
    title: TITLE,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  })
  win.removeMenu()
  guard(win.webContents, target)

  let settled = false
  let checks = 0
  let debounce: ReturnType<typeof setTimeout> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const { promise, resolve: resolveLogin, reject: rejectLogin } = Promise.withResolvers<string>()

  // 先清会话、关窗口，再把结果交出去
  const finish = (outcome: { token: string } | { error: RpcError }) => {
    if (settled) return
    settled = true
    clearTimeout(debounce)
    clearTimeout(timeout)
    if (active?.window === win) active = undefined
    devLog(`结束：${'token' in outcome ? '拿到 token' : String((outcome.error.data as { kind?: string }).kind)}`)
    void clearSession(ses).then(() => {
      if (!win.isDestroyed()) win.destroy()
      if ('token' in outcome) resolveLogin(outcome.token)
      else rejectLogin(outcome.error)
    })
  }

  const check = async () => {
    if (settled || checks >= MAX_CHECKS) return
    checks++
    const { token, status } = await fetchToken(ses, target.infoUrl)
    devLog(`查登录状态（第 ${checks} 次）：${status}，${token ? '已登录' : '还没登录'}`)
    if (token) finish({ token })
    else if (checks >= MAX_CHECKS) finish({ error: loginError('login_failed', '多次没有读到登录状态，请关闭窗口后重试，或者改用粘贴 token') })
  }
  const scheduleCheck = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => void check(), CHECK_DEBOUNCE_MS)
  }

  // 标题显示当前域名，让用户看得到自己在哪个网站上；不用页面自己的标题
  const showHost = (value: string) => {
    if (win.isDestroyed()) return
    win.setTitle(`${TITLE} - ${URL.parse(value)?.host ?? ''}`)
    devLog(`当前页面：${blockedHost(value)}`)
  }
  win.on('page-title-updated', (event) => event.preventDefault())
  win.webContents.on('did-navigate', (_event, url) => {
    showHost(url)
    scheduleCheck()
  })
  win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return
    showHost(url)
    scheduleCheck()
  })
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    // -3（ERR_ABORTED）是被拦下或被新的跳转取消，不算失败
    if (isMainFrame && code !== -3) finish({ error: loginError('login_failed', `打不开登录页（错误 ${code}），请检查网络后重试`) })
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => finish({ error: loginError('cancelled', '已取消登录') }))
  timeout = setTimeout(() => finish({ error: loginError('login_failed', '登录超时，请重试') }), LOGIN_TIMEOUT_MS)

  void win.loadURL(target.loginUrl)
  return { window: win, promise, check: () => void check() }
}

/** 打开登录窗口，返回 token。同一时间只有一个登录窗口：再次调用时把它切到前面，拿到同一个结果 */
export function hgLogin(parent: BrowserWindow, target: HgLoginTarget): Promise<string> {
  if (active) {
    active.window.focus()
    return active.promise
  }
  const login = openLogin(parent, target)
  active = login
  return login.promise
}

/** 用户在登录弹窗里点“我已登录”：马上查一次。没有打开的登录窗口时返回 false */
export function checkHgLogin(): boolean {
  if (!active) return false
  active.check()
  return true
}
