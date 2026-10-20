/**
 * 鹰角 token 的保存（app.tokens.*，约定见 desktop/README.md 的“鹰角 token 的保存”）。
 * 维护者的要求：要记住，但只能用系统钥匙串加密；系统没有钥匙串（如 Linux 上没有 Secret Service / KWallet）就不记住。
 * 加密用 Electron 的 safeStorage（Windows 是 DPAPI，macOS 是钥匙串，Linux 是 libsecret / KWallet）；文件格式和校验在 token-store.ts。
 */
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { APP_ERROR, INVALID_PARAMS, RpcError } from './rpc.js'
import { CLOUD_SECRETS_FILE, CLOUD_SECRET_RULES, TOKEN_FILE, TokenStore, cloudSecretPairs, isAccountId, isToken } from './token-store.js'

export interface KeychainStatus {
  available: boolean
  /** Linux 上是 safeStorage 选中的后端；Windows 是 dpapi，macOS 是 keychain */
  backend: string
}

/** Linux 上这两个后端不是真正的钥匙串：basic_text 用的是写死的密码，unknown 是还没准备好 */
const NOT_A_KEYCHAIN = new Set(['basic_text', 'unknown'])

export function keychainStatus(): KeychainStatus {
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'darwin' ? 'keychain' : 'dpapi'
  return { available: safeStorage.isEncryptionAvailable() && !NOT_A_KEYCHAIN.has(backend), backend }
}

const cipher = {
  encrypt: (text: string) => safeStorage.encryptString(text),
  decrypt: (data: Buffer) => safeStorage.decryptString(data),
}

let store: TokenStore | undefined

/** 第一次用到时再创建：应用数据目录要等 main.ts 设置好 */
function tokenStore(): TokenStore {
  store ??= new TokenStore(join(app.getPath('userData'), TOKEN_FILE), cipher)
  return store
}

/** 云同步的密码和钥匙（app.cloudSecrets.*，格式见 token-store.ts 的 CLOUD_SECRET_RULES） */
let secretStore: TokenStore | undefined

function cloudSecretStore(): TokenStore {
  secretStore ??= new TokenStore(join(app.getPath('userData'), CLOUD_SECRETS_FILE), cipher, CLOUD_SECRET_RULES)
  return secretStore
}

const params = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})

function requireKeychain(): void {
  if (!keychainStatus().available) {
    throw new RpcError(APP_ERROR, '这台电脑没有可用的系统钥匙串，不能记住登录', { kind: 'keychain_unavailable' })
  }
}

/** 文件读写出错时日志里只记错误码，不带 token、密码、钥匙、密文和文件内容 */
async function run<T>(what: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (error) {
    if (error instanceof RpcError) throw error
    console.error(`[keychain] ${what}失败（${(error as NodeJS.ErrnoException).code ?? 'error'}）`)
    throw new RpcError(-32603, `${what}失败`)
  }
}

export async function loadTokens(): Promise<{ tokens: Record<string, string> }> {
  if (!keychainStatus().available) return { tokens: {} }
  return { tokens: await run('读取保存的 token', () => tokenStore().load()) }
}

export async function saveToken(value: unknown): Promise<{ ok: true }> {
  const { accountId, token } = params(value)
  if (!isAccountId(accountId)) throw new RpcError(INVALID_PARAMS, 'accountId 格式不对')
  if (!isToken(token)) throw new RpcError(INVALID_PARAMS, 'token 格式不对')
  requireKeychain()
  await run('保存 token', () => tokenStore().save(accountId, token))
  return { ok: true }
}

/** 删除不需要钥匙串：钥匙串不可用时也能把文件里的条目删掉 */
export async function deleteToken(value: unknown): Promise<{ ok: true }> {
  const { accountId } = params(value)
  if (!isAccountId(accountId)) throw new RpcError(INVALID_PARAMS, 'accountId 格式不对')
  await run('删除 token', () => tokenStore().delete(accountId))
  return { ok: true }
}

export async function loadCloudSecrets(): Promise<{ secrets: Record<string, string> }> {
  if (!keychainStatus().available) return { secrets: {} }
  const all = await run('读取保存的云同步密码和钥匙', () => cloudSecretStore().load())
  return { secrets: Object.fromEntries(Object.entries(all).filter(([id, value]) => cloudSecretPairs(id, value))) }
}

export async function saveCloudSecret(value: unknown): Promise<{ ok: true }> {
  const { id, secret } = params(value)
  if (!CLOUD_SECRET_RULES.isKey(id)) throw new RpcError(INVALID_PARAMS, 'id 格式不对')
  if (!CLOUD_SECRET_RULES.isValue(secret) || !cloudSecretPairs(id, secret)) throw new RpcError(INVALID_PARAMS, '内容格式不对')
  requireKeychain()
  await run('保存云同步密码和钥匙', () => cloudSecretStore().save(id, secret))
  return { ok: true }
}

export async function deleteCloudSecret(value: unknown): Promise<{ ok: true }> {
  const { id } = params(value)
  if (!CLOUD_SECRET_RULES.isKey(id)) throw new RpcError(INVALID_PARAMS, 'id 格式不对')
  await run('删除云同步密码和钥匙', () => cloudSecretStore().delete(id))
  return { ok: true }
}
