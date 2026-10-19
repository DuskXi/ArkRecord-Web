/**
 * preload：给页面暴露最小的接口 window.arkrecord（类型 ArkrecordBridge 见 src/lib/transport.ts，约定见 desktop/README.md）。
 * 在沙盒里运行，只能用 Electron 提供的少数模块：所以是 CommonJS，也不引用项目里的其他文件。
 */
import electron = require('electron')

type RpcReply = { ok: true; result: unknown } | { ok: false; error: { code: number; message: string; data?: unknown } }

electron.contextBridge.exposeInMainWorld('arkrecord', {
  /** 失败时 reject 普通对象 { code, message, data? }，经过 contextBridge 后 code 和 data 都还在 */
  async rpc(method: string, params?: unknown): Promise<unknown> {
    const reply = (await electron.ipcRenderer.invoke('arkrecord:rpc', method, params)) as RpcReply
    if (reply.ok) return reply.result
    throw reply.error
  },
  platform: process.platform,
})
