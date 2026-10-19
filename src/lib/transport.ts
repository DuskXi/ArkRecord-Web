/**
 * 请求层：鹰角接口的请求从这里发出。
 *
 * - 网页版：发给本站 Worker 的 /api/hg/*，由 Worker 按白名单转发（见 worker/proxy.ts）。
 * - 桌面版（见 docs/desktop/plan.md）：经 Electron preload 暴露的 window.arkrecord 调用 hg.request，
 *   由本机的 Python 后端按同一份白名单执行，不经过 Worker；返回的内容和 Worker 一致，还原成 Response 交给调用方。
 */

/**
 * rpc() 失败时 reject 的值：普通对象，不是 Error（这样 code 和 data 经过 contextBridge 后还在）。
 * code 按 JSON-RPC：-32601 方法不允许、-32602 参数不对、-32603 内部错误、-32000 业务错误（看 data.kind）。
 * 主进程自己产生的 data.kind：backend_unavailable（后端没启动成功或已退出）、timeout（超时）。
 */
export interface RpcErrorObject {
  code: number
  message: string
  data?: { kind?: string } & Record<string, unknown>
}

export function isRpcErrorObject(value: unknown): value is RpcErrorObject {
  if (typeof value !== 'object' || value === null) return false
  const { code, message } = value as Record<string, unknown>
  return Number.isInteger(code) && typeof message === 'string'
}

/** 桌面版 preload 暴露给页面的接口（协议见 desktop/README.md） */
export interface ArkrecordBridge {
  /** 调用 Python 后端的方法（JSON-RPC），主进程只放行白名单里的方法。失败时 reject RpcErrorObject */
  rpc(method: string, params?: unknown): Promise<unknown>
  readonly platform: 'win32' | 'darwin' | 'linux'
}

declare global {
  interface Window {
    /** 只在桌面版里存在 */
    arkrecord?: ArkrecordBridge
  }
}

/** 桌面版返回接口对象，网页版返回 undefined */
export function desktopBridge(): ArkrecordBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.arkrecord
}

export function isDesktop(): boolean {
  return desktopBridge() !== undefined
}

/**
 * 桌面版的请求没有拿到响应：后端不可用、超时、返回的格式不对等。
 * 继承 TypeError，和网页版 fetch 的网络错误一样，由调用方（client.ts）当作网络错误处理。
 */
export class TransportError extends TypeError {
  readonly rpc: RpcErrorObject | undefined

  constructor(message: string, rpc?: RpcErrorObject) {
    super(message)
    this.name = 'TransportError'
    this.rpc = rpc
  }
}

/** hg.request 的结果（desktop/README.md）：和 Worker 返回给页面的响应一致，body 是字符串 */
interface HgRpcResult {
  status: number
  headers: Record<string, unknown>
  body: string
}

/** 只把这几个响应头交给页面，和 Worker 一致 */
const HG_RESPONSE_HEADERS = new Set(['content-type', 'x-ak-user-center', 'x-arkrecord-proxy'])
/** 这些状态码的 Response 不能带正文 */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

function isHgRpcResult(value: unknown): value is HgRpcResult {
  if (typeof value !== 'object' || value === null) return false
  const { status, headers, body } = value as Record<string, unknown>
  return (
    Number.isInteger(status) &&
    (status as number) >= 200 &&
    (status as number) <= 599 &&
    typeof headers === 'object' &&
    headers !== null &&
    !Array.isArray(headers) &&
    typeof body === 'string'
  )
}

async function postHgDesktop(bridge: ArkrecordBridge, upstream: string, path: string, envelope: string): Promise<Response> {
  let result: unknown
  try {
    result = await bridge.rpc('hg.request', { upstream, path, envelope })
  } catch (error) {
    throw isRpcErrorObject(error) ? new TransportError(error.message, error) : new TransportError('桌面版后端请求失败')
  }
  if (!isHgRpcResult(result)) throw new TransportError('桌面版后端返回的数据格式不对')

  const headers = new Headers()
  try {
    for (const [name, value] of Object.entries(result.headers)) {
      if (HG_RESPONSE_HEADERS.has(name.toLowerCase()) && typeof value === 'string') headers.set(name, value)
    }
  } catch {
    throw new TransportError('桌面版后端返回的响应头不对')
  }
  return new Response(NULL_BODY_STATUSES.has(result.status) ? null : result.body, { status: result.status, headers })
}

/**
 * 发送一个鹰角请求信封（格式见 worker/proxy.ts 的 ProxyEnvelope），返回上游响应。
 * 没有拿到响应时抛出错误（网页版是 fetch 的 TypeError，桌面版是 TransportError），由调用方处理。
 */
export function postHg(upstream: string, path: string, envelope: string): Promise<Response> {
  const bridge = desktopBridge()
  if (bridge) return postHgDesktop(bridge, upstream, path, envelope)
  return fetch(`/api/hg/${upstream}${path}`, {
    method: 'POST',
    headers: { 'x-arkrecord-client': '1', accept: 'application/json', 'content-type': 'application/json' },
    body: envelope,
    credentials: 'same-origin',
  })
}
