/**
 * 同步识别码（设计见 docs/rewrite/sync-user-id.md）。
 *
 * - 本机识别码：第一次开通云同步时生成，存在 IndexedDB 的 kv 表里；任何开关（关闭云同步、删除云端数据、关闭统计、删除账号）都不删它。
 * - 账号识别码：每个开着云同步的账号带一个（Account.syncUser），随加密的同步数据一起上传，服务器看不到。
 * - 合并：两边不同时保留先生成的，其余的记进 merged（同一个人的其他识别码）。规则和顺序无关。
 * - 本机和账号的识别码对不上、又不在 merged 里时，是冲突：记下来，同步结束后问用户（SyncUserConflictDialog）。
 */
import { db } from './db'
import { MAX_MERGED_USERS, type SyncUser } from './cloud/codec'
import type { Account } from './types'

const DEVICE_KEY = 'sync-user'
const CONFLICTS_KEY = 'sync-user-conflicts'

export function newSyncUser(now = Date.now()): SyncUser {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return { id: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''), createdAt: now }
}

/** 先生成的在前；同时生成的按 id 比较 */
function earlier(a: SyncUser, b: SyncUser): SyncUser {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a : b
  return a.id <= b.id ? a : b
}

/** 合并两个识别码：保留先生成的，其余全部记进 merged。满足幂等、交换、结合 */
export function mergeUsers(a: SyncUser, b: SyncUser): SyncUser {
  const winner = earlier(a, b)
  const ids = new Set([a.id, b.id, ...(a.merged ?? []), ...(b.merged ?? [])])
  ids.delete(winner.id)
  const merged = [...ids].toSorted().slice(0, MAX_MERGED_USERS)
  return merged.length ? { id: winner.id, createdAt: winner.createdAt, merged } : { id: winner.id, createdAt: winner.createdAt }
}

/** 是不是同一个人：同一个识别码，或者一方的 merged 里有另一方 */
export function sameUser(a: SyncUser, b: SyncUser): boolean {
  return a.id === b.id || Boolean(a.merged?.includes(b.id)) || Boolean(b.merged?.includes(a.id))
}

export function equalUsers(a: SyncUser | undefined, b: SyncUser | undefined): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.createdAt === b.createdAt && (a.merged ?? []).join() === (b.merged ?? []).join()
}

export interface Reconciled {
  device: SyncUser | undefined
  account: SyncUser | undefined
  /** 本机和账号的识别码对不上，要问用户 */
  conflict: boolean
}

/**
 * 本机识别码和一个账号的识别码对账（纯函数）：
 *   都没有 → 生成新的；只有一边有 → 另一边沿用；是同一个人 → 两边合并；对不上 → 冲突，两边都不改。
 * 用户说过“这个账号不是我的”（decision = other）时，什么都不改。
 */
export function reconcile(device: SyncUser | undefined, account: SyncUser | undefined, decision?: 'other', now = Date.now()): Reconciled {
  if (decision === 'other') return { device, account, conflict: false }
  if (!device && !account) {
    const created = newSyncUser(now)
    return { device: created, account: created, conflict: false }
  }
  if (!account) return { device, account: device, conflict: false }
  if (!device) return { device: account, account, conflict: false }
  if (sameUser(device, account)) {
    const merged = mergeUsers(device, account)
    return { device: merged, account: merged, conflict: false }
  }
  return { device, account, conflict: true }
}

// ───────────── 本地存储 ─────────────

export async function loadDeviceUser(): Promise<SyncUser | undefined> {
  return (await db.kv.get(DEVICE_KEY))?.value as SyncUser | undefined
}

async function saveDeviceUser(user: SyncUser): Promise<void> {
  await db.kv.put({ key: DEVICE_KEY, value: user })
}

export interface SyncUserConflict {
  accountId: string
  /** 账号在云端的识别码 */
  user: SyncUser
}

export async function loadConflicts(): Promise<SyncUserConflict[]> {
  return ((await db.kv.get(CONFLICTS_KEY))?.value as SyncUserConflict[] | undefined) ?? []
}

async function setConflict(accountId: string, user: SyncUser | undefined): Promise<void> {
  const list = (await loadConflicts()).filter((c) => c.accountId !== accountId)
  if (user) list.push({ accountId, user })
  await db.kv.put({ key: CONFLICTS_KEY, value: list })
}

/** 把云端一批数据里的识别码合并进本地账号（applyDataset 调用） */
export function mergeAccountUser(local: SyncUser | undefined, remote: SyncUser | undefined): SyncUser | undefined {
  if (!remote) return local
  return local ? mergeUsers(local, remote) : remote
}

/**
 * 云同步时调用（拉取合并之后、准备上传之前；开通时也调用）：本机识别码和这个账号对账，
 * 更新本地账号的识别码（随后上传）和本机识别码；对不上时记下冲突，什么都不改。
 */
export async function reconcileAccountUser(accountId: string): Promise<void> {
  const account = await db.accounts.get(accountId)
  if (!account) return
  const device = await loadDeviceUser()
  const result = reconcile(device, account.syncUser, account.syncUserDecision)
  if (result.device && !equalUsers(result.device, device)) await saveDeviceUser(result.device)
  if (!equalUsers(result.account, account.syncUser)) await db.accounts.update(accountId, { syncUser: result.account })
  await setConflict(accountId, result.conflict ? account.syncUser : undefined)
}

/**
 * 用户回答冲突：
 *   same：是同一个人，保留先生成的。本机和所有开着同步的账号都改用合并后的识别码，返回需要重新同步的账号；
 *   other：这个账号不是我的，以后不把本机识别码写进它；
 *   later：这次不改，下次同步时再问。
 */
export async function resolveConflict(accountId: string, answer: 'same' | 'other' | 'later'): Promise<string[]> {
  const conflict = (await loadConflicts()).find((c) => c.accountId === accountId)
  await setConflict(accountId, undefined)
  if (!conflict || answer === 'later') return []
  if (answer === 'other') {
    await db.accounts.update(accountId, { syncUserDecision: 'other' })
    return []
  }
  const device = mergeUsers((await loadDeviceUser()) ?? conflict.user, conflict.user)
  await saveDeviceUser(device)
  const changed: string[] = []
  const synced = new Set((await db.cloud.toArray()).map((s) => s.accountId))
  const accounts: Account[] = await db.accounts.toArray()
  for (const account of accounts) {
    if (!synced.has(account.id) || account.syncUserDecision === 'other') continue
    const current = account.syncUser
    // 这个账号就是这次确认的；其他账号只在本来就是同一个人时才改
    if (account.id !== accountId && current && !sameUser(current, device)) continue
    const next = current ? mergeUsers(current, device) : device
    if (!equalUsers(next, current)) {
      await db.accounts.update(account.id, { syncUser: next })
      changed.push(account.id)
    }
  }
  return changed
}
