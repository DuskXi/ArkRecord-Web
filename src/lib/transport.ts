/**
 * 请求层：鹰角接口的请求从这里发出。
 *
 * - 网页版：发给本站 Worker 的 /api/hg/*，由 Worker 按白名单转发（见 worker/proxy.ts）。
 * - 桌面版（开发中，见 docs/desktop/plan.md）：Electron 的 preload 暴露 window.arkrecord，
 *   请求交给本机的 Python 后端执行，不经过 Worker。M1 接入，目前桌面版也走网页版的路径。
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
 * 发送一个鹰角请求信封（格式见 worker/proxy.ts 的 ProxyEnvelope），返回上游响应。
 * 网络错误时抛出 fetch 的 TypeError，由调用方处理。
 */
export function postHg(upstream: string, path: string, envelope: string): Promise<Response> {
  return fetch(`/api/hg/${upstream}${path}`, {
    method: 'POST',
    headers: { 'x-arkrecord-client': '1', accept: 'application/json', 'content-type': 'application/json' },
    body: envelope,
    credentials: 'same-origin',
  })
}
