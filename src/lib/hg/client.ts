/**
 * 通过本站 Worker 调用鹰角接口。
 *
 * 浏览器不能直接请求鹰角接口（不允许 CORS，且依赖浏览器无法设置的 Cookie），所以经由同源的
 * /api/hg/* 转发。Worker 只做转发，所有解析都在这里、在用户浏览器里完成。
 */

export type Upstream = 'as' | 'binding' | 'ak' | 'u8' | 'ef'

export type HgErrorKind =
  /** 转发层拒绝（限速、白名单等），见 Worker 的 x-arkrecord-proxy 响应头 */
  | 'proxy'
  /** 登录态失效，需要重新登录 */
  | 'auth'
  /** 上游返回了业务错误 */
  | 'upstream'
  /** 网络错误或无法解析的响应 */
  | 'network'

export class HgError extends Error {
  constructor(
    readonly kind: HgErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'HgError'
  }
}

export interface HgRequest {
  method?: 'GET' | 'POST'
  query?: Record<string, string | number | undefined>
  body?: unknown
  roleToken?: string
  akCookie?: string
}

export interface HgResponse<T> {
  data: T
  /** 角色登录时上游下发的 ak-user-center Cookie */
  akCookie?: string
}

/** 前端节流：两次请求之间至少间隔这么久，远低于 Worker 的限速阈值 */
const MIN_INTERVAL_MS = 600
let lastRequestAt = 0

async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastRequestAt = Date.now()
}

const AUTH_REASONS = new Set(['UN_LOGIN', 'MissingCookie', 'DETECTED_ROLE_CHANGED'])

/** 鹰角各域名的响应格式不同：as./binding/u8 为 {status,msg,data}，ak./ef 为 {code,msg,data} */
interface Envelope {
  status?: number
  code?: number
  msg?: string
  message?: string
  reason?: string
  data?: unknown
}

export async function hg<T>(upstream: Upstream, path: string, request: HgRequest = {}): Promise<HgResponse<T>> {
  const method = request.method ?? 'GET'
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) query.set(key, String(value))
  }
  const url = `/api/hg/${upstream}${path}${query.size ? `?${query}` : ''}`
  const headers: Record<string, string> = { 'x-arkrecord-client': '1', accept: 'application/json' }
  if (request.body !== undefined) headers['content-type'] = 'application/json'
  if (request.roleToken) headers['x-role-token'] = request.roleToken
  if (request.akCookie) headers['x-ak-user-center'] = request.akCookie

  for (let attempt = 0; ; attempt++) {
    await pace()
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        credentials: 'same-origin',
      })
    } catch {
      throw new HgError('network', '网络连接失败，请检查网络后重试')
    }

    const proxyCode = response.headers.get('x-arkrecord-proxy')
    if (proxyCode === 'rate_limited' && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10_000 * (attempt + 1)))
      continue
    }
    if (proxyCode) {
      throw new HgError('proxy', proxyMessage(proxyCode), response.status, proxyCode)
    }

    let envelope: Envelope
    try {
      envelope = (await response.json()) as Envelope
    } catch {
      throw new HgError('network', `无法解析接口响应（HTTP ${response.status}）`, response.status)
    }

    if (response.status === 401 || (envelope.reason && AUTH_REASONS.has(envelope.reason))) {
      throw new HgError('auth', '登录状态已失效，请重新登录', response.status, envelope.reason)
    }
    const code = envelope.status ?? envelope.code
    if (code === undefined) {
      throw new HgError('upstream', envelope.message || `接口返回了未知格式（HTTP ${response.status}）`, response.status)
    }
    // 终末地接口用 40100 表示 token 失效
    if (code === 40100) {
      throw new HgError('auth', '登录状态已失效，请重新登录', response.status, String(code))
    }
    if (code !== 0) {
      throw new HgError('upstream', envelope.msg || envelope.message || `接口返回错误 ${code}`, response.status, String(code))
    }
    return {
      data: envelope.data as T,
      akCookie: response.headers.get('x-ak-user-center') ?? undefined,
    }
  }
}

function proxyMessage(code: string): string {
  switch (code) {
    case 'rate_limited':
      return '请求太频繁，请稍后再试'
    case 'upstream_unreachable':
      return '暂时无法连接鹰角服务器，请稍后再试'
    default:
      return `请求被拒绝（${code}）`
  }
}
