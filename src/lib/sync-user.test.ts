import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { checkSyncUser, type SyncUser } from './cloud/codec'
import { db } from './db'
import {
  equalUsers,
  loadConflicts,
  loadDeviceUser,
  mergeAccountUser,
  mergeUsers,
  newSyncUser,
  reconcile,
  reconcileAccountUser,
  resolveConflict,
  sameUser,
} from './sync-user'
import type { Account } from './types'

const hex = (c: string) => c.repeat(32)
const user = (c: string, createdAt: number, merged?: string[]): SyncUser => (merged ? { id: hex(c), createdAt, merged } : { id: hex(c), createdAt })
const A = user('a', 100)
const B = user('b', 200)
const C = user('c', 300)

describe('生成和合并', () => {
  it('新识别码是 128 位随机数，格式合规', () => {
    const one = newSyncUser(5)
    expect(checkSyncUser(one)).toBe(true)
    expect(one.createdAt).toBe(5)
    expect(newSyncUser(5).id).not.toBe(one.id)
  })

  it('保留先生成的，其余记进 merged；同时生成时取 id 小的', () => {
    expect(mergeUsers(B, A)).toEqual({ id: A.id, createdAt: 100, merged: [B.id] })
    expect(mergeUsers(A, B)).toEqual(mergeUsers(B, A))
    expect(mergeUsers(user('b', 100), user('a', 100))).toEqual({ id: hex('a'), createdAt: 100, merged: [hex('b')] })
    expect(mergeUsers(A, A)).toEqual(A)
  })

  it('幂等、交换、结合，结果总是合规', () => {
    const pool = [A, B, C, user('d', 50, [hex('e')]), user('f', 300, [hex('a'), hex('e')])]
    for (const x of pool) {
      expect(mergeUsers(x, x)).toEqual(x)
      for (const y of pool) {
        expect(mergeUsers(x, y)).toEqual(mergeUsers(y, x))
        expect(checkSyncUser(mergeUsers(x, y))).toBe(true)
        for (const z of pool) expect(mergeUsers(mergeUsers(x, y), z)).toEqual(mergeUsers(x, mergeUsers(y, z)))
      }
    }
  })

  it('合并过的识别码认作同一个人', () => {
    expect(sameUser(A, B)).toBe(false)
    expect(sameUser(mergeUsers(A, B), B)).toBe(true)
    expect(sameUser(B, mergeUsers(A, B))).toBe(true)
    expect(equalUsers(mergeUsers(A, B), mergeUsers(B, A))).toBe(true)
    expect(equalUsers(A, undefined)).toBe(false)
    expect(equalUsers(undefined, undefined)).toBe(true)
  })

  it('云端数据带来的识别码并入本地账号', () => {
    expect(mergeAccountUser(undefined, undefined)).toBeUndefined()
    expect(mergeAccountUser(A, undefined)).toBe(A)
    expect(mergeAccountUser(undefined, B)).toBe(B)
    expect(mergeAccountUser(B, A)).toEqual(mergeUsers(A, B))
  })
})

describe('本机和账号对账', () => {
  it('都没有：生成新的，两边一样', () => {
    const r = reconcile(undefined, undefined, undefined, 42)
    expect(r.conflict).toBe(false)
    expect(r.device).toBe(r.account)
    expect(r.device!.createdAt).toBe(42)
  })

  it('只有一边有：另一边沿用', () => {
    expect(reconcile(A, undefined)).toEqual({ device: A, account: A, conflict: false })
    expect(reconcile(undefined, B)).toEqual({ device: B, account: B, conflict: false })
  })

  it('同一个人：两边合并；对不上：冲突，两边都不改', () => {
    expect(reconcile(A, A)).toEqual({ device: A, account: A, conflict: false })
    const merged = mergeUsers(A, B)
    expect(reconcile(B, merged)).toEqual({ device: merged, account: merged, conflict: false })
    expect(reconcile(A, B)).toEqual({ device: A, account: B, conflict: true })
  })

  it('用户说过不是自己的账号：什么都不改，也不生成', () => {
    expect(reconcile(A, B, 'other')).toEqual({ device: A, account: B, conflict: false })
    expect(reconcile(undefined, undefined, 'other')).toEqual({ device: undefined, account: undefined, conflict: false })
    expect(reconcile(A, undefined, 'other')).toEqual({ device: A, account: undefined, conflict: false })
  })
})

const account = (id: string, syncUser?: SyncUser): Account => ({ id, game: 'arknights', uid: id, nickName: id, createdAt: 1, metaAt: 1, ...(syncUser ? { syncUser } : {}) })
const enableCloud = (accountId: string) => db.cloud.put({ accountId, game: 'arknights', uid: accountId, locator: 'x', mode: 'password', remember: true, kid: 1, requireHg: false, lastSeq: 0, remote: {} })

describe('本地存储', () => {
  beforeEach(async () => {
    await Promise.all([db.accounts.clear(), db.kv.clear(), db.cloud.clear()])
  })

  it('第一次开通时生成本机识别码；之后其他账号沿用', async () => {
    await db.accounts.bulkPut([account('1'), account('2')])
    await reconcileAccountUser('1')
    const device = await loadDeviceUser()
    expect(device).toBeDefined()
    expect((await db.accounts.get('1'))!.syncUser).toEqual(device)
    await reconcileAccountUser('2')
    expect((await db.accounts.get('2'))!.syncUser).toEqual(device)
    expect(await loadDeviceUser()).toEqual(device)
    expect(await loadConflicts()).toEqual([])
  })

  it('新设备：沿用云端带来的识别码，不生成新的', async () => {
    await db.accounts.put(account('1', B))
    await reconcileAccountUser('1')
    expect(await loadDeviceUser()).toEqual(B)
  })

  it('冲突时记下来，两边都不改；“以后再说”下次还会问', async () => {
    await db.kv.put({ key: 'sync-user', value: A })
    await db.accounts.put(account('1', B))
    await reconcileAccountUser('1')
    expect(await loadDeviceUser()).toEqual(A)
    expect((await db.accounts.get('1'))!.syncUser).toEqual(B)
    expect(await loadConflicts()).toEqual([{ accountId: '1', user: B }])

    expect(await resolveConflict('1', 'later')).toEqual([])
    expect(await loadConflicts()).toEqual([])
    await reconcileAccountUser('1')
    expect(await loadConflicts()).toEqual([{ accountId: '1', user: B }])
  })

  it('“不是我的”：以后不再问，账号保留自己的识别码', async () => {
    await db.kv.put({ key: 'sync-user', value: A })
    await db.accounts.put(account('1', B))
    await reconcileAccountUser('1')
    expect(await resolveConflict('1', 'other')).toEqual([])
    await reconcileAccountUser('1')
    expect(await loadConflicts()).toEqual([])
    expect(await loadDeviceUser()).toEqual(A)
    expect((await db.accounts.get('1'))!.syncUser).toEqual(B)
  })

  it('“是同一个人”：保留先生成的，本机和开着同步的同一个人的账号都改用它', async () => {
    // 本机是 B；账号 1 在云端是更早的 A（冲突）；账号 2 开着同步、是 B；账号 3 没开同步；账号 4 是别人的 C（回答过不是）
    await db.kv.put({ key: 'sync-user', value: B })
    await db.accounts.bulkPut([account('1', A), account('2', B), account('3', B), { ...account('4', C), syncUserDecision: 'other' as const }])
    await Promise.all(['1', '2', '4'].map(enableCloud))
    await reconcileAccountUser('1')
    expect(await loadConflicts()).toHaveLength(1)

    const changed = await resolveConflict('1', 'same')
    const merged = mergeUsers(A, B)
    expect(merged.id).toBe(A.id)
    expect(await loadDeviceUser()).toEqual(merged)
    expect(changed.toSorted()).toEqual(['1', '2'])
    expect((await db.accounts.get('1'))!.syncUser).toEqual(merged)
    expect((await db.accounts.get('2'))!.syncUser).toEqual(merged)
    expect((await db.accounts.get('3'))!.syncUser).toEqual(B)
    expect((await db.accounts.get('4'))!.syncUser).toEqual(C)
    expect(await loadConflicts()).toEqual([])

    // 之后再对账不会冲突；没开同步的账号以后开通时也会并过来
    await reconcileAccountUser('1')
    await reconcileAccountUser('3')
    expect(await loadConflicts()).toEqual([])
    expect((await db.accounts.get('3'))!.syncUser).toEqual(merged)
  })

  it('没有记录冲突时回答不改任何东西', async () => {
    await db.kv.put({ key: 'sync-user', value: A })
    await db.accounts.put(account('1', B))
    await enableCloud('1')
    expect(await resolveConflict('1', 'same')).toEqual([])
    expect(await loadDeviceUser()).toEqual(A)
  })
})
