/**
 * 每个开通了云同步的账号在这台设备上的状态（docs/rewrite/cloud-sync.md 7.8、10）。
 *
 * 钥匙只存在本机：不导出、不进快照、不同步。
 *   - authKey 保存原始字节（每次请求都要发给服务器）；
 *   - DEK 是不可导出的 CryptoKey，页面脚本可以用它加解密，但读不出它的原始字节；
 *   - 选择“不在这台设备保存”时，两者只放在内存里，刷新网页后需要重新输入密码。
 */
import type { CloudGame, CloudMode } from '../../../shared/cloud-protocol'
import { db } from '../db'

export interface CloudState {
  accountId: string
  game: CloudGame
  uid: string
  locator: string
  /** password：密码模式；hg：无密码模式（不保存任何钥匙，每次云同步都用鹰角 token 向服务器取） */
  mode: CloudMode
  /** 是否把钥匙保存在这台设备上 */
  remember: boolean
  /** 只在 remember 时保存 */
  authKey?: Uint8Array
  /** 只在 remember 时保存；不可导出 */
  dek?: CryptoKey
  kid: number
  /** 是否开启了鹰角 token 双重验证 */
  requireHg: boolean
  /** 已经下载到的最大批次号 */
  lastSeq: number
  /** 云端已有的记录：记录标识 → 内容哈希（只存哈希，不存内容） */
  remote: Record<string, string>
  lastSyncAt?: number
  /** 上次云同步后本地数据的指纹（规范明文的 SHA-256） */
  fingerprint?: string
}

/** 不保存在设备上的钥匙：只在这个页面的内存里 */
const memoryKeys = new Map<string, { authKey: Uint8Array; dek: CryptoKey }>()

export async function loadState(accountId: string): Promise<CloudState | undefined> {
  return db.cloud.get(accountId)
}

export async function listStates(): Promise<CloudState[]> {
  return db.cloud.toArray()
}

export async function saveState(state: CloudState, keys?: { authKey: Uint8Array; dek: CryptoKey }): Promise<void> {
  if (keys) {
    if (state.remember) {
      memoryKeys.delete(state.accountId)
      state = { ...state, authKey: keys.authKey, dek: keys.dek }
    } else {
      memoryKeys.set(state.accountId, keys)
      state = { ...state, authKey: undefined, dek: undefined }
    }
  }
  await db.cloud.put(state)
}

/** 这个账号在这台设备上能不能直接云同步：无密码模式不需要钥匙（每次用鹰角 token），密码模式要有钥匙 */
export function isReady(state: CloudState): boolean {
  return state.mode === 'hg' || keysOf(state) !== null
}

/** 取出钥匙：保存在设备上的，或者这个页面内存里的；都没有时返回 null（需要重新输入密码） */
export function keysOf(state: CloudState): { authKey: Uint8Array; dek: CryptoKey } | null {
  if (state.authKey && state.dek) return { authKey: state.authKey, dek: state.dek }
  return memoryKeys.get(state.accountId) ?? null
}

/** 忘掉这台设备上的钥匙（密码在别处改了、云端被覆盖时），保留同步进度 */
export async function dropKeys(accountId: string): Promise<void> {
  memoryKeys.delete(accountId)
  const state = await db.cloud.get(accountId)
  if (state) await db.cloud.put({ ...state, authKey: undefined, dek: undefined })
}

/** 退出云同步：删除这台设备上的状态和钥匙，不动云端 */
export async function removeState(accountId: string): Promise<void> {
  memoryKeys.delete(accountId)
  await db.cloud.delete(accountId)
}
