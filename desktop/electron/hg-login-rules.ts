/**
 * 应用内鹰角登录窗口的规则：允许打开哪些地址、怎么从 account/info/hg 的响应里取 token。
 * 不依赖 Electron，便于测试。设计见 docs/desktop/plan.md 的“应用内鹰角登录窗口”。
 */

export interface HgLoginTarget {
  /** 登录窗口打开的地址 */
  loginUrl: string
  /** 主进程在登录会话里请求它取 token */
  infoUrl: string
  /** 顶层页面允许的地址 */
  allowTop(url: URL): boolean
  /** 子框架允许的地址（多了极验） */
  allowFrame(url: URL): boolean
}

/** token 的长度上限：超过说明响应不对 */
const MAX_TOKEN_LENGTH = 4096

const isUnder = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** 鹰角官方登录页。顶层只允许 https://*.hypergryph.com；子框架另外放行极验（具体域名在真机测试时确认） */
export const OFFICIAL_LOGIN: HgLoginTarget = {
  loginUrl: 'https://user.hypergryph.com/',
  infoUrl: 'https://web-api.hypergryph.com/account/info/hg',
  allowTop: (url) => url.protocol === 'https:' && isUnder(url.hostname, 'hypergryph.com'),
  allowFrame: (url) => url.protocol === 'https:' && (isUnder(url.hostname, 'hypergryph.com') || isUnder(url.hostname, 'geetest.com')),
}

/** 开发和冒烟测试用的本机假登录页（desktop/electron/fake-hg.mjs），只接受本机的 http 地址 */
export function fakeLoginTarget(origin: string): HgLoginTarget {
  const base = new URL(origin)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)) {
    throw new Error(`假登录页只能是本机地址：${origin}`)
  }
  const sameOrigin = (url: URL) => url.origin === base.origin
  return {
    loginUrl: new URL('/login', base).href,
    infoUrl: new URL('/account/info/hg', base).href,
    allowTop: sameOrigin,
    allowFrame: sameOrigin,
  }
}

/** 被拦下的是什么：顶层页面的跳转、子框架的跳转，还是新窗口 */
export type BlockedKind = '顶层页面' | '子框架' | '新窗口'

/**
 * 被拦下的地址只留域名（开发版的日志用，真机测试时确认白名单）：不记端口、路径、参数和 fragment；
 * 不是 http(s) 的地址只记协议（如 data:、about:）
 */
export function blockedHost(value: string): string {
  const url = URL.parse(value)
  if (!url) return '（无法解析的地址）'
  return url.hostname || url.protocol
}

/** account/info/hg 的响应：code === 0 且 data.content 是非空字符串才算登录成功 */
export function tokenFromInfo(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const { code, data } = json as { code?: unknown; data?: { content?: unknown } | null }
  const content = data?.content
  if (code !== 0 || typeof content !== 'string') return undefined
  return content.length > 0 && content.length <= MAX_TOKEN_LENGTH ? content : undefined
}
