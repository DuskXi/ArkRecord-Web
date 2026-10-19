/**
 * 主进程和 Python 后端之间的 JSON-RPC 2.0 客户端：stdin / stdout 上一行一个消息（UTF-8，\n 分隔），约定见 desktop/README.md。
 * 只依赖 Node 的流，不依赖 Electron，便于测试。
 */
import type { Readable, Writable } from 'node:stream'

export const INVALID_PARAMS = -32602
export const METHOD_NOT_FOUND = -32601
/** 业务错误，error.data.kind 说明类型 */
export const APP_ERROR = -32000

/** 交给渲染进程的错误（普通对象，经 contextBridge 原样复制） */
export interface RpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }

  toJSON(): RpcErrorObject {
    return this.data === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data: this.data }
  }
}

/** 主进程自己产生的业务错误：后端没启动成功或已退出、请求超时 */
export function clientError(kind: 'backend_unavailable' | 'timeout', message: string): RpcError {
  return new RpcError(APP_ERROR, message, { kind })
}

/** 一行超过这个长度说明后端出了问题，断开连接 */
const MAX_LINE_LENGTH = 64 * 1024 * 1024

interface Pending {
  resolve(result: unknown): void
  reject(error: RpcError): void
  timer: ReturnType<typeof setTimeout>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function toRpcError(value: unknown): RpcError {
  if (isRecord(value) && Number.isInteger(value.code) && typeof value.message === 'string') {
    return new RpcError(value.code as number, value.message, value.data)
  }
  return new RpcError(-32603, '后端返回的错误格式不对')
}

export class RpcClient {
  private nextId = 1
  private buffer = ''
  private closedReason: string | undefined
  private readonly pending = new Map<number, Pending>()
  private readonly input: Writable
  /** 协议出错时的提示（不含消息内容，避免把后端输出的数据写进日志） */
  private readonly warn: (message: string) => void

  constructor(input: Writable, output: Readable, warn: (message: string) => void) {
    this.input = input
    this.warn = warn
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => this.receive(chunk))
    output.on('end', () => this.close('后端已退出'))
    // 后端退出后再写 stdin 会出错（EPIPE 等），不能让它变成未处理的异常
    input.on('error', (error) => this.close(`写入后端失败：${error.message}`))
  }

  get closed(): boolean {
    return this.closedReason !== undefined
  }

  /** params 只能是 undefined、对象或数组（JSON-RPC 的要求） */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(clientError('backend_unavailable', this.closedReason))
    if (params !== undefined && (typeof params !== 'object' || params === null)) {
      return Promise.reject(new RpcError(INVALID_PARAMS, '参数只能是对象或数组'))
    }

    const id = this.nextId++
    let line: string
    try {
      line = JSON.stringify(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    } catch {
      return Promise.reject(new RpcError(INVALID_PARAMS, '参数不能转成 JSON'))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(clientError('timeout', `后端在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.input.write(`${line}\n`)
    })
  }

  /** 断开：所有等待中的请求都以 backend_unavailable 失败 */
  close(reason: string): void {
    if (this.closedReason !== undefined) return
    this.closedReason = reason
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(clientError('backend_unavailable', reason))
    }
    this.pending.clear()
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    let end: number
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      this.handleLine(line)
    }
    if (this.buffer.length > MAX_LINE_LENGTH) {
      this.buffer = ''
      this.warn('后端输出的一行太长，已断开')
      this.close('后端输出的数据不对')
    }
  }

  private handleLine(raw: string): void {
    const line = raw.trim()
    if (!line) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.warn(`stdout 上有一行不是 JSON（${line.length} 个字符），已忽略`)
      return
    }
    const id = isRecord(message) ? message.id : undefined
    const pending = typeof id === 'number' ? this.pending.get(id) : undefined
    if (!isRecord(message) || !pending) {
      this.warn(`收到没有对应请求的响应（id: ${JSON.stringify(id ?? null)}），已忽略`)
      return
    }
    this.pending.delete(id as number)
    clearTimeout(pending.timer)
    if ('error' in message) pending.reject(toRpcError(message.error))
    else pending.resolve(message.result)
  }
}
