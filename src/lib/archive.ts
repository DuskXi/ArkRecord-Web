/**
 * 本地存档的读写操作：迁移、导入、导出、快照、删除。
 *
 * 导出格式参照 UIGF 的结构（UIGF 本身只覆盖米哈游的游戏）：顶层 info + 按游戏分组，
 * 记录保留鹰角接口的原始字段名和类型，便于其他工具读取。
 */
import { db } from './db'
import type { LegacyAccount } from './legacy'
import { legacyLedger, legacyToAkPulls } from './legacy'
import type { AkMeta } from './meta'
import { mergeAkPulls } from './sync/arknights'
import type { Account, AkLedgerEntry, AkPull, EfPull, Game } from './types'

export const EXPORT_VERSION = 'v2.0'

export interface ExportFile {
  info: { export_app: 'ArkRecord'; export_app_version: string; export_timestamp: number; version: string }
  arknights: {
    uid: string
    nickName: string
    channelName?: string
    timezone: 8
    lang: 'zh-cn'
    list: {
      poolId: string | null
      poolName: string
      charId: string | null
      charName: string
      rarity: number
      isNew: boolean
      gachaTs: string
      pos: number
      category?: string
      source: AkPull['source']
    }[]
    ledger?: { kind: 'stone' | 'recharge'; raw: unknown }[]
  }[]
  endfield: {
    uid: string
    nickName: string
    channelName?: string
    timezone: 8
    lang: 'zh-cn'
    list: Record<string, unknown>[]
  }[]
}

export function makeAccountId(game: Game, uid: string): string {
  return `${game}:${uid}`
}

async function ensureAccount(game: Game, uid: string, nickName: string, extra: Partial<Account> = {}): Promise<Account> {
  const id = makeAccountId(game, uid)
  const existing = await db.accounts.get(id)
  if (existing) {
    const patch: Partial<Account> = {}
    if (!existing.accountToken && extra.accountToken) patch.accountToken = extra.accountToken
    if (Object.keys(patch).length) await db.accounts.update(id, patch)
    return { ...existing, ...patch }
  }
  const account: Account = { id, game, uid, nickName, createdAt: Date.now(), ...extra }
  await db.accounts.put(account)
  return account
}

/** 写入旧版数据：同一秒内已有接口数据时跳过（接口数据更完整） */
export async function mergeLegacyPulls(accountId: string, pulls: AkPull[]): Promise<number> {
  if (!pulls.length) return 0
  let added = 0
  await db.transaction('rw', db.akPulls, async () => {
    const seconds = [...new Set(pulls.map((p) => p.tsSec))]
    const covered = new Set(
      (await db.akPulls.where('[accountId+tsSec]').anyOf(seconds.map((s) => [accountId, s])).toArray())
        .filter((p) => p.source !== 'legacy')
        .map((p) => p.tsSec),
    )
    const fresh = pulls.filter((p) => !covered.has(p.tsSec))
    const existing = new Set((await db.akPulls.bulkGet(fresh.map((p) => [accountId, p.key]))).filter(Boolean).map((p) => p!.key))
    const toAdd = fresh.filter((p) => !existing.has(p.key))
    await db.akPulls.bulkPut(toAdd)
    added = toAdd.length
  })
  return added
}

export interface ImportSummary {
  accounts: number
  pulls: number
  ledger: number
}

export async function importLegacyAccounts(
  legacy: LegacyAccount[],
  meta: AkMeta,
  options: { rememberTokens?: boolean } = {},
): Promise<ImportSummary> {
  const summary: ImportSummary = { accounts: 0, pulls: 0, ledger: 0 }
  for (const item of legacy) {
    const account = await ensureAccount('arknights', item.uid, item.nickName, {
      channelName: item.channel === 'bilibili' ? 'bilibili服' : item.channel === 'official' ? '官服' : undefined,
      isOfficial: item.channel === 'official',
      accountToken: options.rememberTokens ? item.accountToken : undefined,
    })
    summary.accounts++
    summary.pulls += await mergeLegacyPulls(account.id, legacyToAkPulls(account.id, item.pools, meta))
    const ledger = legacyLedger(account.id, item.stone, item.recharge)
    await db.akLedger.bulkPut(ledger)
    summary.ledger += ledger.length
  }
  return summary
}

/** 把没有 uid 的最早期数据导入到指定账号 */
export async function importAnonymousLegacy(
  account: Account,
  data: Pick<LegacyAccount, 'pools' | 'stone' | 'recharge'>,
  meta: AkMeta,
): Promise<ImportSummary> {
  const pulls = await mergeLegacyPulls(account.id, legacyToAkPulls(account.id, data.pools, meta))
  const ledger = legacyLedger(account.id, data.stone, data.recharge)
  await db.akLedger.bulkPut(ledger)
  return { accounts: 1, pulls, ledger: ledger.length }
}

export async function buildExport(version: string, accountIds?: string[]): Promise<ExportFile> {
  const accounts = (await db.accounts.toArray()).filter((a) => !accountIds || accountIds.includes(a.id))
  const file: ExportFile = {
    info: { export_app: 'ArkRecord', export_app_version: version, export_timestamp: Math.floor(Date.now() / 1000), version: EXPORT_VERSION },
    arknights: [],
    endfield: [],
  }
  for (const account of accounts) {
    if (account.game === 'arknights') {
      const pulls = await db.akPulls.where('accountId').equals(account.id).toArray()
      const ledger = await db.akLedger.where('accountId').equals(account.id).toArray()
      pulls.sort((a, b) => a.gachaTs - b.gachaTs || a.pos - b.pos)
      file.arknights.push({
        uid: account.uid,
        nickName: account.nickName,
        channelName: account.channelName,
        timezone: 8,
        lang: 'zh-cn',
        list: pulls.map((p) => ({
          poolId: p.poolId,
          poolName: p.poolName,
          charId: p.charId,
          charName: p.charName,
          rarity: p.rarity,
          isNew: p.isNew,
          gachaTs: String(p.gachaTs),
          pos: p.pos,
          category: p.category,
          source: p.source,
        })),
        ledger: ledger.length ? ledger.map((l) => ({ kind: l.kind, raw: l.raw })) : undefined,
      })
    } else {
      const pulls = await db.efPulls.where('accountId').equals(account.id).toArray()
      pulls.sort((a, b) => a.gachaTs - b.gachaTs)
      file.endfield.push({
        uid: account.uid,
        nickName: account.nickName,
        channelName: account.channelName,
        timezone: 8,
        lang: 'zh-cn',
        list: pulls.map((p) => ({
          type: p.type,
          poolId: p.poolId,
          poolName: p.poolName,
          poolType: p.poolType,
          ...(p.type === 'char' ? { charId: p.itemId, charName: p.itemName } : { weaponId: p.itemId, weaponName: p.itemName }),
          rarity: p.rarity,
          isNew: p.isNew,
          isFree: p.isFree,
          kind: p.kind,
          gachaTs: String(p.gachaTs),
          seqId: p.seqId,
          source: p.source,
        })),
      })
    }
  }
  return file
}

export function isExportFile(json: unknown): json is ExportFile {
  const info = (json as ExportFile | null)?.info
  return Boolean(info && info.export_app === 'ArkRecord' && Array.isArray((json as ExportFile).arknights))
}

export async function importExportFile(file: ExportFile): Promise<ImportSummary> {
  const summary: ImportSummary = { accounts: 0, pulls: 0, ledger: 0 }
  for (const entry of file.arknights) {
    const account = await ensureAccount('arknights', entry.uid, entry.nickName, { channelName: entry.channelName })
    summary.accounts++
    const pulls: AkPull[] = entry.list.map((r) => {
      const gachaTs = Number(r.gachaTs)
      const source = r.source === 'legacy' ? 'legacy' : r.source === 'api' ? 'api' : 'import'
      return {
        accountId: account.id,
        key: source === 'legacy' ? `legacy:${Math.floor(gachaTs / 1000)}:${r.pos}` : `${r.poolId}:${r.charId}:${r.gachaTs}:${r.pos}`,
        poolId: r.poolId,
        poolName: r.poolName,
        category: r.category,
        charId: r.charId,
        charName: r.charName,
        rarity: r.rarity,
        isNew: r.isNew,
        gachaTs,
        tsSec: Math.floor(gachaTs / 1000),
        pos: r.pos,
        source,
      }
    })
    const legacy = pulls.filter((p) => p.source === 'legacy')
    const modern = pulls.filter((p) => p.source !== 'legacy')
    summary.pulls += await mergeLegacyPulls(account.id, legacy)
    if (modern.length) {
      const existing = new Set((await db.akPulls.bulkGet(modern.map((p) => [account.id, p.key]))).filter(Boolean).map((p) => p!.key))
      summary.pulls += await mergeAkPulls(account.id, modern.filter((p) => !existing.has(p.key)))
    }
    const ledger: AkLedgerEntry[] = []
    for (const l of entry.ledger ?? []) {
      const parsed = l.kind === 'stone' ? legacyLedger(account.id, [l.raw], []) : legacyLedger(account.id, [], [l.raw])
      ledger.push(...parsed)
    }
    await db.akLedger.bulkPut(ledger)
    summary.ledger += ledger.length
  }
  for (const entry of file.endfield) {
    const account = await ensureAccount('endfield', entry.uid, entry.nickName, { channelName: entry.channelName })
    summary.accounts++
    const pulls: EfPull[] = entry.list.map((raw) => {
      const r = raw as Record<string, string | number | boolean | undefined>
      const type = r.type === 'weapon' ? 'weapon' : 'char'
      return {
        accountId: account.id,
        key: `${type}:${r.poolId}:${r.seqId}`,
        type,
        poolId: String(r.poolId),
        poolName: String(r.poolName ?? ''),
        poolType: String(r.poolType ?? ''),
        itemId: String((type === 'char' ? r.charId : r.weaponId) ?? ''),
        itemName: String((type === 'char' ? r.charName : r.weaponName) ?? ''),
        rarity: Number(r.rarity),
        isNew: Boolean(r.isNew),
        isFree: Boolean(r.isFree),
        kind: String(r.kind ?? 'draw'),
        gachaTs: Number(r.gachaTs),
        seqId: String(r.seqId),
        source: 'import',
      }
    })
    const existing = new Set((await db.efPulls.bulkGet(pulls.map((p) => [account.id, p.key]))).filter(Boolean).map((p) => p!.key))
    const fresh = pulls.filter((p) => !existing.has(p.key))
    await db.efPulls.bulkPut(fresh)
    summary.pulls += fresh.length
  }
  return summary
}

/** 在导入、清空等操作之前自动保存一份快照，最多保留 10 份 */
export async function createSnapshot(reason: string, version: string): Promise<void> {
  const payload = JSON.stringify(await buildExport(version))
  await db.snapshots.add({ createdAt: Date.now(), reason, payload })
  const all = await db.snapshots.orderBy('createdAt').primaryKeys()
  if (all.length > 10) await db.snapshots.bulkDelete(all.slice(0, all.length - 10))
}

export async function deleteAccountData(accountId: string): Promise<void> {
  await db.transaction('rw', [db.accounts, db.akPulls, db.efPulls, db.akLedger], async () => {
    await db.akPulls.where('accountId').equals(accountId).delete()
    await db.efPulls.where('accountId').equals(accountId).delete()
    await db.akLedger.where('accountId').equals(accountId).delete()
    await db.accounts.delete(accountId)
  })
}
