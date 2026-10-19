/**
 * Python 后端子进程：第一次请求时启动，退出后下一次请求再重新启动。
 * 后端的 stderr 是已经脱敏的日志（desktop/backend 的 redact.py），原样转到主进程的输出。
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { RpcClient, clientError } from './rpc.js'

export interface BackendCommand {
  command: string
  args: string[]
  cwd: string
  /** 额外的环境变量；值是 undefined 的会从继承来的环境里删掉 */
  env?: Record<string, string | undefined>
}

/** 停止时给后端多少时间自己退出（关闭 stdin 后），超时就强制结束 */
const STOP_TIMEOUT_MS = 3000

export class Backend {
  private child: ChildProcessWithoutNullStreams | undefined
  private client: RpcClient | undefined
  private readonly resolveCommand: () => BackendCommand

  constructor(resolveCommand: () => BackendCommand) {
    this.resolveCommand = resolveCommand
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    let client: RpcClient
    try {
      client = this.start()
    } catch (error) {
      return Promise.reject(clientError('backend_unavailable', `启动后端失败：${(error as Error).message}`))
    }
    return client.request(method, params, timeoutMs)
  }

  /** 关闭 stdin，后端读到 EOF 后自己退出 */
  stop(): void {
    const child = this.child
    if (!child) return
    this.client?.close('应用正在退出')
    child.stdin.end()
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }, STOP_TIMEOUT_MS).unref()
  }

  private start(): RpcClient {
    if (this.client && !this.client.closed) return this.client

    const { command, args, cwd, env: extraEnv = {} } = this.resolveCommand()
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    const client = new RpcClient(child.stdin, child.stdout, (message) => console.warn(`[backend] ${message}`))
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => console.log(`[backend] ${line}`))

    child.on('error', (error: NodeJS.ErrnoException) => {
      const reason = error.code === 'ENOENT' ? `找不到 ${command}（开发时需要安装 uv：https://docs.astral.sh/uv/）` : `启动后端失败：${error.message}`
      console.error(`[backend] ${reason}`)
      client.close(reason)
    })
    child.on('exit', (code, signal) => {
      client.close(`后端已退出（${signal ?? `退出码 ${code}`}）`)
      if (this.child === child) {
        this.child = undefined
        this.client = undefined
      }
    })

    this.child = child
    this.client = client
    return client
  }
}
