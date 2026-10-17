/**
 * 在 Web Worker 里计算 Argon2id，不卡界面（docs/rewrite/cloud-sync.md 7.7）。
 * 只做计算：收到密码和盐，返回结果；不保存、不发送任何东西。
 */
import { argon2id, ARGON2_V1, type Argon2Impl } from './argon2'

export type KdfRequest = { password: Uint8Array; salt: Uint8Array }
export type KdfResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; hash: Uint8Array; impl: Argon2Impl }
  | { type: 'error'; message: string }

function post(message: KdfResponse) {
  // 这是 Worker 内部的 postMessage，没有 targetOrigin 参数
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(message)
}

self.addEventListener('message', async (event: MessageEvent<KdfRequest>) => {
  try {
    const { hash, impl } = await argon2id(event.data.password, event.data.salt, ARGON2_V1, (fraction) => post({ type: 'progress', fraction }))
    post({ type: 'done', hash, impl })
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
})
