/**
 * 终末地增量同步：角色池按 pool_type、武器池按 poolId 逐页拉取，遇到本地已有记录即停止。
 */
import { HgError } from '../hg/client'
import { db } from '../db'
import { getU8Token, grantOAuthToken } from '../hg/auth'
import {
  type EfRawRecord,
  fetchCharPage,
  fetchCharPoolTypes,
  fetchPoolContent,
  fetchWeaponPage,
  fetchWeaponPools,
} from '../hg/endfield'
import type { Account, EfPull } from '../types'
import type { SyncProgress, SyncResult } from './arknights'

/** 卡池信息缓存一天；进行中的卡池可能更新 UP 信息 */
const POOL_INFO_TTL = 24 * 3600 * 1000

export function toEfPull(accountId: string, type: 'char' | 'weapon', poolType: string, raw: EfRawRecord): EfPull {
  return {
    accountId,
    key: `${type}:${raw.poolId}:${raw.seqId}`,
    type,
    poolId: raw.poolId,
    poolName: raw.poolName,
    poolType: type === 'char' ? poolType : (raw.poolType ?? poolType),
    itemId: (type === 'char' ? raw.charId : raw.weaponId) ?? '',
    itemName: (type === 'char' ? raw.charName : raw.weaponName) ?? '',
    rarity: raw.rarity,
    isNew: Boolean(raw.isNew),
    isFree: Boolean(raw.isFree),
    kind: raw.kind ?? 'draw',
    gachaTs: Number(raw.gachaTs),
    seqId: String(raw.seqId),
    source: 'api',
  }
}

export async function syncEndfield(
  account: Account,
  accountToken: string,
  options: { full?: boolean; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncResult> {
  const collected: EfPull[] = []
  const report = (stage: string, detail?: string) => options.onProgress?.({ stage, detail, added: collected.length })
  let fetched = 0

  report('正在登录')
  const oauth = await grantOAuthToken(accountToken)
  const token = await getU8Token(oauth, account.uid)

  const existing = new Set(
    (await db.efPulls.where('accountId').equals(account.id).primaryKeys()).map(([, key]) => key),
  )

  async function paginate(
    label: string,
    type: 'char' | 'weapon',
    poolType: string,
    fetchPage: (seqId?: string) => ReturnType<typeof fetchCharPage>,
  ) {
    let seqId: string | undefined
    for (let page = 1; ; page++) {
      report(label, `第 ${page} 页`)
      const result = await fetchPage(seqId)
      fetched += result.list.length
      const records = result.list.map((raw) => toEfPull(account.id, type, poolType, raw))
      const fresh = records.filter((r) => !existing.has(r.key))
      for (const r of fresh) existing.add(r.key)
      collected.push(...fresh)
      if (!options.full && fresh.length < records.length) break
      const last = result.list.at(-1)
      if (!result.hasMore || !last) break
      seqId = String(last.seqId)
    }
  }

  report('正在读取卡池类型')
  for (const poolType of await fetchCharPoolTypes(token)) {
    await paginate(charPoolLabel(poolType), 'char', poolType, (seq) => fetchCharPage(token, poolType, seq))
  }
  for (const pool of await fetchWeaponPools(token)) {
    await paginate(pool.poolName, 'weapon', pool.poolType, (seq) => fetchWeaponPage(token, pool.poolId, seq))
  }

  report('正在保存')
  if (collected.length) await db.efPulls.bulkPut(collected)
  await db.accounts.update(account.id, { lastSyncAt: Date.now() })

  report('正在更新卡池信息')
  await refreshPoolInfo([...new Set(collected.map((p) => p.poolId))])
  return { added: collected.length, fetched }
}

const GONE_KEY = 'efPoolGone'
const GONE_TTL = 7 * 24 * 3600 * 1000

/**
 * 补全卡池信息（当期 UP、卡池图等）；失败不影响同步结果。
 * 官方接口只保留当期卡池，已下线的返回 40402，记下来一周内不再请求（UP 名单改由构建时的游戏数据表提供）。
 */
export async function refreshPoolInfo(poolIds: string[]): Promise<void> {
  const gone = ((await db.kv.get(GONE_KEY))?.value ?? {}) as Record<string, number>
  let goneChanged = false
  for (const poolId of poolIds) {
    const cached = await db.efPools.get(poolId)
    if (cached && Date.now() - cached.fetchedAt < POOL_INFO_TTL) continue
    if (Date.now() - (gone[poolId] ?? 0) < GONE_TTL) continue
    try {
      await db.efPools.put(await fetchPoolContent(poolId))
    } catch (error) {
      if (error instanceof HgError && error.code === '40402') {
        gone[poolId] = Date.now()
        goneChanged = true
      }
      // 其他错误忽略，下次同步再试
    }
  }
  if (goneChanged) await db.kv.put({ key: GONE_KEY, value: gone })
}

export function charPoolLabel(poolType: string): string {
  const name = poolType.replace('E_CharacterGachaPoolType_', '')
  return (
    {
      Special: '特许寻访',
      Rerun: '重构寻访',
      Joint: '辉光庆典',
      Standard: '基础寻访',
      Beginner: '启程寻访',
    }[name] ?? name
  )
}
