/**
 * 同步配置：开通或解锁一个账号时可以保存下来，之后其他账号一键开通、一键启用，不用再设置一遍。
 *
 * 内容：模式（密码 / 无密码）、云同步密码（无密码模式没有）、新开通的账号是否开启双重验证、是否把钥匙记在这台设备上。
 *   - 选择“在这台设备上记住”时，密码用一把不可导出的 AES-GCM 钥匙加密后存在本机 IndexedDB：
 *     页面脚本能用这把钥匙解密，但读不出钥匙本身；直接翻浏览器的数据文件、导出备份都看不到密码明文。
 *     （和“记住钥匙”一样，能在这台设备上打开本站的人可以使用它，所以公用电脑不要保存。）
 *   - 选择不记住时，只放在这个页面的内存里，刷新后就没有了。
 *   - 桌面版不存进 IndexedDB：记住时用系统钥匙串加密保存（secrets.ts），钥匙串不能用时只放在内存里。
 * 不导出、不进备份、不上传。
 */
import type { CloudMode } from '../../../shared/cloud-protocol'
import { db } from '../db'
import { deleteProfile, storedProfile, storeProfile, usesDesktopSecrets } from './secrets'

export interface SyncProfile {
  /** 新开通的账号用哪种模式；hg（无密码模式）没有密码 */
  mode: CloudMode
  /** 无密码模式为空字符串 */
  password: string
  /** 新开通的账号是否开启鹰角 token 双重验证 */
  requireHg: boolean
  /** 是否把钥匙（以及这份配置）记在这台设备上 */
  remember: boolean
  savedAt: number
}

/** 界面显示用：不含密码 */
export type SyncProfileInfo = Omit<SyncProfile, 'password'>

const KV_KEY = 'cloudProfile'
const AAD = new TextEncoder().encode('arkrecord/cloud-profile/v1')

interface StoredProfile {
  version: 1
  /** 没有这个字段的是密码模式（之前的版本保存的） */
  mode?: CloudMode
  requireHg: boolean
  remember: true
  savedAt: number
  /** 不可导出 */
  key: CryptoKey
  iv: Uint8Array
  ciphertext: Uint8Array
}

let memoryProfile: SyncProfile | null = null

const modeOf = (value: StoredProfile): CloudMode => (value.mode === 'hg' ? 'hg' : 'password')

function isStored(value: unknown): value is StoredProfile {
  const v = value as StoredProfile | undefined
  return (
    v?.version === 1 &&
    typeof v.requireHg === 'boolean' &&
    typeof v.savedAt === 'number' &&
    v.key instanceof CryptoKey &&
    v.iv instanceof Uint8Array &&
    v.ciphertext instanceof Uint8Array
  )
}

export async function saveProfile(profile: Omit<SyncProfile, 'savedAt'>): Promise<void> {
  const savedAt = Date.now()
  if (!profile.remember) {
    memoryProfile = { ...profile, savedAt }
    await db.kv.delete(KV_KEY)
    await deleteProfile()
    return
  }
  if (usesDesktopSecrets()) {
    await db.kv.delete(KV_KEY)
    const { mode, password, requireHg } = profile
    // 钥匙串不能用：只留在内存里（界面上显示成没记住）
    memoryProfile = (await storeProfile({ mode, password, requireHg, savedAt })) ? null : { ...profile, remember: false, savedAt }
    return
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(profile.password)),
  )
  const stored: StoredProfile = { version: 1, mode: profile.mode, requireHg: profile.requireHg, remember: true, savedAt, key, iv, ciphertext }
  await db.kv.put({ key: KV_KEY, value: stored })
  memoryProfile = null
}

/** 取出同步配置（含密码）；没有或者解不开时返回 null */
export async function loadProfile(): Promise<SyncProfile | null> {
  if (memoryProfile) return memoryProfile
  const stored = storedProfile()
  if (stored) return { ...stored, remember: true }
  const value = (await db.kv.get(KV_KEY))?.value
  if (!isStored(value)) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.iv as Uint8Array<ArrayBuffer>, additionalData: AAD }, value.key, value.ciphertext as Uint8Array<ArrayBuffer>)
    return { mode: modeOf(value), password: new TextDecoder().decode(plain), requireHg: value.requireHg, remember: true, savedAt: value.savedAt }
  } catch {
    return null
  }
}

/** 界面显示用：不解密密码 */
export async function profileInfo(): Promise<SyncProfileInfo | null> {
  if (memoryProfile) return { mode: memoryProfile.mode, requireHg: memoryProfile.requireHg, remember: false, savedAt: memoryProfile.savedAt }
  const stored = storedProfile()
  if (stored) return { mode: stored.mode, requireHg: stored.requireHg, remember: true, savedAt: stored.savedAt }
  const value = (await db.kv.get(KV_KEY))?.value
  return isStored(value) ? { mode: modeOf(value), requireHg: value.requireHg, remember: true, savedAt: value.savedAt } : null
}

export async function clearProfile(): Promise<void> {
  memoryProfile = null
  await db.kv.delete(KV_KEY)
  await deleteProfile()
}
