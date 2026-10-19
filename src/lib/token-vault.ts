/**
 * 桌面版的鹰角 token 保存（维护者 2026-10-19：要保留，但只能用系统钥匙串加密；系统没有钥匙串就不保留）。
 *
 * - 网页版不受影响：token 照旧存在账号记录里（IndexedDB），这里什么都不做。
 * - 桌面版：账号表上装钩子，token 永远不写进 IndexedDB。
 *   - 写入：账号记录里带 token 时，交给主进程用系统钥匙串加密保存（app.tokens.save，Electron safeStorage），
 *     并从要写进 IndexedDB 的数据里删掉；
 *   - 读取：从内存里把 token 补回账号对象，其余代码照旧读 account.accountToken；
 *   - 删除账号：同时删掉保存的 token。
 * - 系统没有可用的钥匙串（如 Linux 上没有 Secret Service / KWallet）：token 只留在内存里，关闭应用就没了。
 *
 * 主进程接口见 desktop/README.md 的“鹰角 token 的保存”。
 */
import type { EntityTable } from 'dexie'
import type { Account } from './types'
import { desktopBridge, type ArkrecordBridge } from './transport'

interface VaultState {
  bridge: ArkrecordBridge
  /** 系统钥匙串能不能用；不能用时不保存，只留在内存 */
  available: boolean
  tokens: Map<string, string>
}

let state: VaultState | undefined

/** 能不能“记住登录”：网页版可以（存在浏览器里）；桌面版要看系统钥匙串 */
export function canRememberTokens(): boolean {
  return state ? state.available : true
}

/** 桌面版是否在用系统钥匙串保存 token（界面上的说明文字用） */
export function tokensInKeychain(): boolean {
  return state?.available === true
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function save(vault: VaultState, accountId: string, token: string): void {
  vault.tokens.set(accountId, token)
  if (!vault.available) return
  vault.bridge.rpc('app.tokens.save', { accountId, token }).catch(() => console.warn('[token-vault] 保存到系统钥匙串失败'))
}

function remove(vault: VaultState, accountId: string): void {
  vault.tokens.delete(accountId)
  if (!vault.available) return
  vault.bridge.rpc('app.tokens.delete', { accountId }).catch(() => console.warn('[token-vault] 从系统钥匙串删除失败'))
}

/** 不再记住这个账号的 token（用户登录时关掉了“记住登录”）。网页版由账号记录本身处理，这里不用管 */
export function forgetToken(accountId: string): void {
  if (state) remove(state, accountId)
}

/** 给账号表装钩子（只在桌面版调用） */
export function installAccountHooks(accounts: EntityTable<Account, 'id'>, vault: VaultState): void {
  accounts.hook('creating', (_key, obj) => {
    if (obj.accountToken) save(vault, obj.id, obj.accountToken)
    delete obj.accountToken
  })
  accounts.hook('updating', (modifications, key) => {
    // 旧记录也经过下面的 reading 钩子（带着 token），所以 token 没变时 modifications 里没有它，
    // 但 put 仍会把整条新记录（带 token）写进去：不管有没有变化，都把这个字段删掉
    if (Object.hasOwn(modifications, 'accountToken')) {
      const token = (modifications as Partial<Account>).accountToken
      if (token) save(vault, String(key), token)
      else remove(vault, String(key))
    }
    // 返回 undefined 的字段会被删掉：token 不写进 IndexedDB
    return { accountToken: undefined }
  })
  accounts.hook('reading', (obj?: Account) => {
    // get / bulkGet 读不存在的账号时，钩子收到的是 undefined（新账号登录时 LoginModal 会先查一下）
    if (!obj) return obj
    const token = vault.tokens.get(obj.id)
    return token ? { ...obj, accountToken: token } : obj
  })
  accounts.hook('deleting', (key) => {
    remove(vault, String(key))
  })
}

/**
 * 应用启动时调用（挂载页面之前）。网页版直接返回；桌面版读出已保存的 token 并装钩子。
 * 读取失败时当作钥匙串不可用：不保存，只留在内存。
 */
export async function initTokenVault(accounts: EntityTable<Account, 'id'>): Promise<void> {
  const bridge = desktopBridge()
  if (!bridge || state) return
  const vault: VaultState = { bridge, available: false, tokens: new Map() }
  try {
    const status = await bridge.rpc('app.tokens.status')
    vault.available = isRecord(status) && status.available === true
    if (vault.available) {
      const loaded = await bridge.rpc('app.tokens.load')
      const tokens = isRecord(loaded) && isRecord(loaded.tokens) ? loaded.tokens : {}
      for (const [id, token] of Object.entries(tokens)) if (typeof token === 'string' && token) vault.tokens.set(id, token)
    }
  } catch {
    vault.available = false
    console.warn('[token-vault] 系统钥匙串不可用，鹰角 token 只留在内存里')
  }
  installAccountHooks(accounts, vault)
  state = vault
}

/** 仅供测试 */
export function resetTokenVaultForTests(): void {
  state = undefined
}
