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
export async function mergeAkPulls(accountId: string, pulls: AkPull[]): Promise<number> {
  if (!pulls.length) return 0
  const seconds = [...new Set(pulls.map((p) => p.tsSec))]
  await db.transaction('rw', db.akPulls, async () => {
    const legacy = await db.akPulls
      .where('[accountId+tsSec]')
      .anyOf(seconds.map((s) => [accountId, s]))
      .filter((p) => p.source === 'legacy')
      .primaryKeys()
    if (legacy.length) await db.akPulls.bulkDelete(legacy)
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
