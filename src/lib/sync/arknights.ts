/**
 * 明日方舟增量同步：按类别逐页拉取，遇到本地已有的记录就停止（只追加，不覆盖）。
 */
import { db } from '../db'
import { getU8Token, grantOAuthToken } from '../hg/auth'
import { type AkRawRecord, fetchCategories, fetchHistoryPage, roleLogin } from '../hg/arknights'
import type { Account, AkPull } from '../types'

export interface SyncProgress {
  stage: string
  detail?: string
  added: number
}

export interface SyncResult {
  added: number
  fetched: number
}

export function akKey(r: Pick<AkRawRecord, 'poolId' | 'charId' | 'gachaTs' | 'pos'>): string {
  return `${r.poolId}:${r.charId}:${r.gachaTs}:${r.pos}`
}

export function toAkPull(accountId: string, category: string, raw: AkRawRecord): AkPull {
  const gachaTs = Number(raw.gachaTs)
  return {
    accountId,
    key: akKey(raw),
    poolId: raw.poolId,
    poolName: raw.poolName,
    category,
    charId: raw.charId,
    charName: raw.charName,
    rarity: raw.rarity,
    isNew: Boolean(raw.isNew),
    gachaTs,
    tsSec: Math.floor(gachaTs / 1000),
    pos: raw.pos,
    source: 'api',
  }
}

/**
 * 写入接口数据。旧版迁移来的记录没有 poolId / charId，无法用同一个键去重；
 * 同一秒内若已有旧版记录，以接口数据为准替换掉它们。
 */
/**
 * 旧版存档的时间是旧接口给的秒级时间，新接口是毫秒级；同一次十连在两边可能相差一两秒。
 * 时间相差不超过这个秒数、且内容（干员与星级）完全相同的十连，视为同一次寻访。
 */
export const LEGACY_MATCH_SECONDS = 3

/** 一次寻访（同一秒内的若干抽）的内容签名：干员与星级的多重集合，与顺序无关 */
export function batchSignature(pulls: Pick<AkPull, 'charName' | 'rarity'>[]): string {
  return pulls.map((p) => `${p.charName}/${p.rarity}`).toSorted().join('|')
}

export function groupBySecond<T extends { tsSec: number }>(pulls: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>()
  for (const p of pulls) {
    const list = out.get(p.tsSec)
    if (list) list.push(p)
    else out.set(p.tsSec, [p])
  }
  return out
}

/**
 * 判断一次旧版寻访是否已经有对应的接口数据：同一秒有接口数据；或者是十连（2 抽以上），
 * 前后几秒内有内容完全相同的接口寻访。单抽内容重复的概率太高，只按同一秒判断。
 */
export function coveredByModern(second: number, legacyBatch: AkPull[], modern: Map<number, AkPull[]>): boolean {
  if (modern.has(second)) return true
  if (legacyBatch.length < 2) return false
  const signature = batchSignature(legacyBatch)
  for (let d = 1; d <= LEGACY_MATCH_SECONDS; d++) {
    for (const s of [second - d, second + d]) {
      const batch = modern.get(s)
      if (batch && batch.length === legacyBatch.length && batchSignature(batch) === signature) return true
    }
  }
  return false
}

function secondRange(pulls: AkPull[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const p of pulls) {
    lo = Math.min(lo, p.tsSec)
    hi = Math.max(hi, p.tsSec)
  }
  return [lo - LEGACY_MATCH_SECONDS, hi + LEGACY_MATCH_SECONDS]
}

/** 写入接口数据；同一次寻访的旧版数据（同一秒，或前后几秒内容相同的十连）被接口数据替换 */
export async function mergeAkPulls(accountId: string, pulls: AkPull[]): Promise<number> {
  if (!pulls.length) return 0
  const [lo, hi] = secondRange(pulls)
  const modern = groupBySecond(pulls)
  await db.transaction('rw', db.akPulls, async () => {
    const legacy = await db.akPulls
      .where('[accountId+tsSec]')
      .between([accountId, lo], [accountId, hi], true, true)
      .filter((p) => p.source === 'legacy')
      .toArray()
    const replaced: [string, string][] = []
    for (const [second, batch] of groupBySecond(legacy)) {
      if (coveredByModern(second, batch, modern)) replaced.push(...batch.map((p): [string, string] => [accountId, p.key]))
    }
    if (replaced.length) await db.akPulls.bulkDelete(replaced)
    await db.akPulls.bulkPut(pulls)
  })
  return pulls.length
}

export async function syncArknights(
  account: Account,
  accountToken: string,
  options: { full?: boolean; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncResult> {
  const report = (stage: string, detail?: string) => options.onProgress?.({ stage, detail, added: collected.length })
  const collected: AkPull[] = []
  let fetched = 0

  report('正在登录')
  const oauth = await grantOAuthToken(accountToken)
  const u8 = await getU8Token(oauth, account.uid)
  const session = await roleLogin(account.uid, u8)

  report('正在读取寻访类别')
  const categories = await fetchCategories(session)
  const existing = new Set(
    (await db.akPulls.where('accountId').equals(account.id).primaryKeys()).map(([, key]) => key),
  )

  for (const category of categories) {
    let cursor: { pos: number; gachaTs: string } | undefined
    for (let page = 1; ; page++) {
      report(category.name, `第 ${page} 页`)
      const result = await fetchHistoryPage(session, category.id, cursor)
      fetched += result.list.length
      const records = result.list.map((raw) => toAkPull(account.id, category.id, raw))
      const fresh = records.filter((r) => !existing.has(r.key))
      for (const r of fresh) existing.add(r.key)
      collected.push(...fresh)
      // 这一页里出现了已有记录：更早的都已经同步过了
      if (!options.full && fresh.length < records.length) break
      const last = result.list.at(-1)
      if (!result.hasMore || !last) break
      cursor = { pos: last.pos, gachaTs: last.gachaTs }
    }
  }

  report('正在保存')
  await mergeAkPulls(account.id, collected)
  await db.accounts.update(account.id, { lastSyncAt: Date.now() })
  return { added: collected.length, fetched }
}
