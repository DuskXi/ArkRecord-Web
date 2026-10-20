/**
 * 桌面版的云同步密码和钥匙（维护者 2026-10-20：“密码不存前端存钥匙串”）。
 *
 * - 网页版不受影响：照旧存在 IndexedDB（profile.ts 的同步配置、state.ts 的钥匙），这里什么都不做。
 * - 桌面版：选择“在这台设备上记住”时，同步配置（含云同步密码）和每个账号的 authKey、DEK 交给主进程，
 *   用系统钥匙串加密保存（app.cloudSecrets.*，desktop/README.md 的“云同步”），不写进 IndexedDB。
 *   应用启动时读回内存；DEK 重新导入成不可导出的 CryptoKey，原始字节不留在页面里。
 * - 系统没有可用的钥匙串（如 Linux 上没有 Secret Service / KWallet）：不保存，只留在内存，
 *   关闭应用后要重新输入密码（和选择不记住一样）。
 */
import { fromBase64Url, toBase64Url } from '../../../shared/cloud-protocol'
import { type ArkrecordBridge, desktopBridge } from '../transport'

export interface KeyPair {
  authKey: Uint8Array
  dek: CryptoKey
}

/** 和 profile.ts 的 SyncProfile 一样（这里不引用它，免得互相依赖） */
export interface StoredSyncProfile {
  mode: 'password' | 'hg'
  password: string
  requireHg: boolean
  savedAt: number
}

const PROFILE_ID = 'profile'

interface Vault {
  bridge: ArkrecordBridge
  /** 系统钥匙串能不能用；不能用时不保存 */
  available: boolean
  keys: Map<string, KeyPair>
  profile: StoredSyncProfile | null
}

let vault: Vault | undefined
/** 已经存进钥匙串的 DEK（包括重新导入的副本）：再次保存同一把钥匙时不用再写 */
let saved = new WeakSet<CryptoKey>()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 桌面版：云同步的密码和钥匙由这里保存（不管钥匙串能不能用，都不写进 IndexedDB）。网页版返回 false */
export function usesDesktopSecrets(): boolean {
  return vault !== undefined
}

/** 桌面版是否能把云同步的密码和钥匙保存在系统钥匙串里 */
export function secretsInKeychain(): boolean {
  return vault?.available === true
}

/** 解开 DEK 时要不要可导出：只有桌面版要把它存进钥匙串时才要（存完后内存里留的是不可导出的副本） */
export function keepsRawKeys(remember: boolean): boolean {
  return remember && secretsInKeychain()
}

const importDek = (raw: Uint8Array) =>
  crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

async function parseKeys(text: string): Promise<KeyPair | null> {
  const [tag, auth, dek] = text.split('.')
  const authKey = fromBase64Url(auth, 32)
  const raw = fromBase64Url(dek, 32)
  if (tag !== 'k1' || !authKey || !raw) return null
  const key = await importDek(raw)
  raw.fill(0)
  saved.add(key)
  return { authKey, dek: key }
}

function parseProfile(text: string): StoredSyncProfile | null {
  const [tag, body] = text.split('.')
  const bytes = fromBase64Url(body)
  if (tag !== 'p1' || !bytes) return null
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<StoredSyncProfile>
    if ((value.mode !== 'password' && value.mode !== 'hg') || typeof value.password !== 'string') return null
    if (typeof value.requireHg !== 'boolean' || typeof value.savedAt !== 'number') return null
    return { mode: value.mode, password: value.password, requireHg: value.requireHg, savedAt: value.savedAt }
  } catch {
    return null
  }
}

function warn(what: string): void {
  console.warn(`[cloud-secrets] ${what}失败`)
}

/** 这个账号保存在钥匙串里的钥匙 */
export function storedKeys(accountId: string): KeyPair | undefined {
  return vault?.keys.get(accountId)
}

/**
 * 把钥匙存进钥匙串，返回留在内存里的副本（DEK 不可导出）；钥匙串不能用、或者 DEK 读不出原始字节时返回 null（只留在内存）。
 * 要保存的 DEK 必须是可导出的（engine.ts 在桌面版解开时用 extractable）；已经保存过的同一把钥匙直接返回。
 */
export async function storeKeys(accountId: string, keys: KeyPair): Promise<KeyPair | null> {
  if (!vault?.available) return null
  const current = vault.keys.get(accountId)
  if (saved.has(keys.dek) && current && toBase64Url(current.authKey) === toBase64Url(keys.authKey)) return current
  if (!keys.dek.extractable) return null
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.dek))
  const secret = `k1.${toBase64Url(keys.authKey)}.${toBase64Url(raw)}`
  const copy = { authKey: keys.authKey.slice(), dek: await importDek(raw) }
  raw.fill(0)
  try {
    await vault.bridge.rpc('app.cloudSecrets.save', { id: accountId, secret })
  } catch {
    warn('保存云同步钥匙到系统钥匙串')
    return null
  }
  saved.add(copy.dek)
  saved.add(keys.dek)
  vault.keys.set(accountId, copy)
  return copy
}

export async function deleteKeys(accountId: string): Promise<void> {
  if (!vault) return
  vault.keys.delete(accountId)
  await vault.bridge.rpc('app.cloudSecrets.delete', { id: accountId }).catch(() => warn('从系统钥匙串删除云同步钥匙'))
}

export function storedProfile(): StoredSyncProfile | null {
  return vault?.profile ?? null
}

/** 把同步配置（含密码）存进钥匙串；钥匙串不能用时返回 false */
export async function storeProfile(profile: StoredSyncProfile): Promise<boolean> {
  if (!vault?.available) return false
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(profile)))
  try {
    await vault.bridge.rpc('app.cloudSecrets.save', { id: PROFILE_ID, secret: `p1.${body}` })
  } catch {
    warn('保存同步配置到系统钥匙串')
    return false
  }
  vault.profile = { ...profile }
  return true
}

export async function deleteProfile(): Promise<void> {
  if (!vault) return
  vault.profile = null
  await vault.bridge.rpc('app.cloudSecrets.delete', { id: PROFILE_ID }).catch(() => warn('从系统钥匙串删除同步配置'))
}

/**
 * 应用启动时调用（挂载页面之前）。网页版直接返回；桌面版读出钥匙串里保存的同步配置和钥匙。
 * 读取失败时当作钥匙串不可用：不保存，只留在内存。
 */
export async function initCloudSecrets(bridge: ArkrecordBridge | undefined = desktopBridge()): Promise<void> {
  if (!bridge || vault) return
  const next: Vault = { bridge, available: false, keys: new Map(), profile: null }
  try {
    const status = await bridge.rpc('app.tokens.status')
    next.available = isRecord(status) && status.available === true
    if (next.available) {
      const loaded = await bridge.rpc('app.cloudSecrets.load')
      const secrets = isRecord(loaded) && isRecord(loaded.secrets) ? loaded.secrets : {}
      for (const [id, secret] of Object.entries(secrets)) {
        if (typeof secret !== 'string') continue
        if (id === PROFILE_ID) next.profile = parseProfile(secret)
        else {
          const keys = await parseKeys(secret)
          if (keys) next.keys.set(id, keys)
        }
      }
    }
  } catch {
    next.available = false
    console.warn('[cloud-secrets] 系统钥匙串不可用，云同步的密码和钥匙只留在内存里')
  }
  vault = next
}

/** 仅供测试 */
export function resetCloudSecretsForTests(): void {
  vault = undefined
  saved = new WeakSet()
}
