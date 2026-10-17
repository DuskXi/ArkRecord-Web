/**
 * 本地数据库 ⇄ 云同步的数据集（codec.ts 编码的对象）。
 *
 *   - readLocalDataset：读出一个账号的全部记录（去掉 accountId），用于上传；
 *   - applyDataset：把云端的一批记录合并进本地，走与从鹰角同步、导入文件相同的合并规则（merge.ts），结果与顺序无关；
 *   - recordHashes：每条记录的标识和内容哈希，用来判断云端是否已经有了本地的这个版本。
 */
import { db } from '../db'
import { compareUtf8, jcs } from '../jcs'
import { mergeLedger } from '../ledger'
import { mergeAkPulls } from '../sync/arknights'
import { mergeEfPools, mergeEfPulls } from '../sync/endfield'
import { mergeLegacyPulls, makeAccountId } from '../archive'
import type { Account, AkLedgerEntry, AkPull, EfPull } from '../types'
import type { CloudAccountInfo, CloudDataset } from './codec'

/** 去掉 accountId，以及值为 undefined 的字段（编码规范里它们等同于缺省） */
function strip<T extends { accountId: string }>(record: T): Omit<T, 'accountId'> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) if (k !== 'accountId' && v !== undefined) out[k] = v
  return out as Omit<T, 'accountId'>
}

export function accountInfo(account: Account): CloudAccountInfo {
  return {
    nickName: typeof account.nickName === 'string' ? account.nickName : String(account.uid),
    ...(typeof account.channelName === 'string' ? { channelName: account.channelName } : {}),
    ...(typeof account.isOfficial === 'boolean' ? { isOfficial: account.isOfficial } : {}),
    metaAt: Number.isSafeInteger(account.metaAt) ? account.metaAt! : 0,
  }
}

export async function readLocalDataset(account: Account): Promise<CloudDataset> {
  const info = accountInfo(account)
  if (account.game === 'arknights') {
    const pulls = await db.akPulls.where('accountId').equals(account.id).toArray()
    const ledger = await db.akLedger.where('accountId').equals(account.id).toArray()
    // poolId、charId 在本地可能是 undefined（很早期的导入文件），与 null 同义：都表示“没有”
    const shaped = pulls.map((p) => ({ ...strip(p), poolId: p.poolId ?? null, charId: p.charId ?? null }))
    return { game: 'arknights', uid: account.uid, account: info, pulls: shaped, ledger: ledger.map(strip) }
  }
  const pulls = await db.efPulls.where('accountId').equals(account.id).toArray()
  const poolIds = [...new Set(pulls.map((p) => p.poolId))]
  const pools = (await db.efPools.bulkGet(poolIds)).filter((p) => p !== undefined)
  return { game: 'endfield', uid: account.uid, account: info, pulls: pulls.map(strip), pools }
}

/** 账号信息：metaAt 新的优先，相同时取规范编码更小的（与顺序无关） */
export function pickAccountInfo(a: CloudAccountInfo, b: CloudAccountInfo): CloudAccountInfo {
  if (a.metaAt !== b.metaAt) return a.metaAt > b.metaAt ? a : b
  return compareUtf8(jcs(a), jcs(b)) <= 0 ? a : b
}

/** 把云端的一批记录合并进本地；账号不存在时按云端的账号信息新建。返回新增的记录数 */
export async function applyDataset(ds: CloudDataset): Promise<number> {
  const accountId = makeAccountId(ds.game, ds.uid)
  const existing = await db.accounts.get(accountId)
  if (!existing) {
    await db.accounts.put({ id: accountId, game: ds.game, uid: ds.uid, createdAt: Date.now(), ...ds.account })
  } else {
    const local = accountInfo(existing)
    const winner = pickAccountInfo(local, ds.account)
    if (winner !== local) {
      await db.accounts.update(accountId, {
        nickName: winner.nickName,
        channelName: winner.channelName,
        isOfficial: winner.isOfficial,
        metaAt: winner.metaAt,
      })
    }
  }
  let added = 0
  if (ds.game === 'arknights') {
    const pulls: AkPull[] = ds.pulls.map((p) => ({ ...p, accountId }))
    // 先写接口数据，再写旧版数据：被接口数据覆盖的旧版记录直接跳过
    added += await mergeAkPulls(
      accountId,
      pulls.filter((p) => p.source !== 'legacy'),
    )
    added += await mergeLegacyPulls(
      accountId,
      pulls.filter((p) => p.source === 'legacy'),
    )
    await mergeLedger(ds.ledger.map((e): AkLedgerEntry => ({ ...e, accountId })))
  } else {
    added += await mergeEfPulls(
      accountId,
      ds.pulls.map((p): EfPull => ({ ...p, accountId })),
    )
    await mergeEfPools(ds.pools)
  }
  return added
}

/** 53 位的字符串哈希（cyrb53），只用来判断内容是否变化，不用于安全 */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** 每条记录的标识 → 内容哈希。标识：寻访 p:key，源石/充值 l:kind:key，卡池 o:poolId，账号信息 a */
export function recordHashes(ds: CloudDataset): Map<string, string> {
  const out = new Map<string, string>()
  out.set('a', cyrb53(jcs(ds.account)))
  for (const p of ds.pulls) out.set(`p:${p.key}`, cyrb53(jcs(p)))
  if (ds.game === 'arknights') for (const e of ds.ledger) out.set(`l:${e.kind}:${e.key}`, cyrb53(jcs(e)))
  else for (const p of ds.pools) out.set(`o:${p.poolId}`, cyrb53(jcs(p)))
  return out
}

/** 从数据集里挑出标识在 ids 里的记录（账号信息总是带上） */
export function subset(ds: CloudDataset, ids: ReadonlySet<string>): CloudDataset {
  if (ds.game === 'arknights') {
    return {
      ...ds,
      pulls: ds.pulls.filter((p) => ids.has(`p:${p.key}`)),
      ledger: ds.ledger.filter((e) => ids.has(`l:${e.kind}:${e.key}`)),
    }
  }
  return { ...ds, pulls: ds.pulls.filter((p) => ids.has(`p:${p.key}`)), pools: ds.pools.filter((p) => ids.has(`o:${p.poolId}`)) }
}

/** 数据集里的记录条数（不算账号信息） */
export function recordCount(ds: CloudDataset): number {
  return ds.pulls.length + (ds.game === 'arknights' ? ds.ledger.length : ds.pools.length)
}
