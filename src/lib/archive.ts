/**
 * 本地存档的读写操作：迁移、导入、导出、快照、删除。
 *
 * 导出格式参照 UIGF 的结构（UIGF 本身只覆盖米哈游的游戏）：顶层 info + 按游戏分组，
 * 记录保留鹰角接口的原始字段名和类型，便于其他工具读取。
 */
import { db } from './db'
import { mergeLedger, toLedgerEntries } from './ledger'
import type { LegacyAccount } from './legacy'
import { legacyLedger, legacyToAkPulls } from './legacy'
import { type AkMeta, loadEfMeta } from './meta'
import { dedupeBy, pickAkPull, planWrites } from './merge'
import { coveredByModern, groupBySecond, LEGACY_MATCH_SECONDS, mergeAkPulls } from './sync/arknights'
import { mergeRoster, type RosterInput } from './roster'
import { efRarity, mergeEfPulls } from './sync/endfield'
import type { Account, AkLedgerEntry, AkPull, EfPull, Game } from './types'

/** 导出文件的格式版本（与程序版本号无关；导入时据此识别新版导出文件） */
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
    /** 截图识别的已拥有干员（见 roster.ts） */
    roster?: ExportRoster[]
  }[]
  endfield: {
    uid: string
    nickName: string
    channelName?: string
    timezone: 8
    lang: 'zh-cn'
    list: Record<string, unknown>[]
    roster?: ExportRoster[]
  }[]
}

export type ExportRoster = RosterInput

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

/**
 * 写入旧版数据，返回新增的条数：已有接口数据的寻访（见 coveredByModern）跳过；
 * 已有同键记录时按 merge.ts 的规则保留更好的版本，结果与写入顺序无关。
 */
export async function mergeLegacyPulls(accountId: string, pulls: AkPull[]): Promise<number> {
  const incoming = dedupeBy(pulls, (p) => p.key, pickAkPull)
  if (!incoming.length) return 0
  let added = 0
  await db.transaction('rw', db.akPulls, async () => {
    const batches = groupBySecond(incoming)
    const seconds = [...batches.keys()]
    const lo = Math.min(...seconds) - LEGACY_MATCH_SECONDS
    const hi = Math.max(...seconds) + LEGACY_MATCH_SECONDS
    const modern = groupBySecond(
      await db.akPulls
        .where('[accountId+tsSec]')
        .between([accountId, lo], [accountId, hi], true, true)
        .filter((p) => p.source !== 'legacy')
        .toArray(),
    )
    const fresh = [...batches].flatMap(([second, batch]) => (coveredByModern(second, batch, modern) ? [] : batch))
    const existing = await db.akPulls.bulkGet(fresh.map((p): [string, string] => [accountId, p.key]))
    const plan = planWrites(fresh, existing, pickAkPull)
    if (plan.writes.length) await db.akPulls.bulkPut(plan.writes)
    added = plan.added
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
  options: {
    rememberTokens?: boolean
    /** 每个账号开始导入前调用（index 从 0 开始），用于显示进度 */
    onProgress?: (index: number, item: LegacyAccount) => void
  } = {},
): Promise<ImportSummary> {
  const summary: ImportSummary = { accounts: 0, pulls: 0, ledger: 0 }
  for (const [index, item] of legacy.entries()) {
    options.onProgress?.(index, item)
    const account = await ensureAccount('arknights', item.uid, item.nickName, {
      channelName: item.channel === 'bilibili' ? 'bilibili服' : item.channel === 'official' ? '官服' : undefined,
      isOfficial: item.channel === 'official',
      accountToken: options.rememberTokens ? item.accountToken : undefined,
    })
    summary.accounts++
    summary.pulls += await mergeLegacyPulls(account.id, legacyToAkPulls(account.id, item.pools, meta))
    summary.ledger += await mergeLedger(legacyLedger(account.id, item.stone, item.recharge))
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
  const ledger = await mergeLedger(legacyLedger(account.id, data.stone, data.recharge))
  return { accounts: 1, pulls, ledger }
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
        roster: await exportRoster(account.id),
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
        roster: await exportRoster(account.id),
      })
    }
  }
  return file
}

async function exportRoster(accountId: string): Promise<ExportRoster[] | undefined> {
  const rows = await db.roster.where('accountId').equals(accountId).toArray()
  return rows.length ? rows.map(({ itemId, name, copies, potential, observedAt, source }) => ({ itemId, name, copies, potential, observedAt, source })) : undefined
}

const countOrNull = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

function importRoster(rows: unknown): RosterInput[] {
  if (!Array.isArray(rows)) return []
  const out: RosterInput[] = []
  for (const raw of rows) {
    const r = raw as Partial<RosterInput>
    if (typeof r.itemId !== 'string' || !r.itemId || typeof r.observedAt !== 'number' || !Number.isFinite(r.observedAt)) continue
    out.push({
      itemId: r.itemId,
      name: typeof r.name === 'string' ? r.name : r.itemId,
      copies: countOrNull(r.copies),
      potential: countOrNull(r.potential),
      observedAt: r.observedAt,
      source: r.source === 'manual' ? 'manual' : 'screenshot',
    })
  }
  return out
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
    summary.pulls += await mergeAkPulls(account.id, modern)
    // 原始条目可能来自旧版，也可能来自新接口，ledger.ts 统一识别
    const ledger: AkLedgerEntry[] = []
    for (const l of entry.ledger ?? []) {
      if (l.kind === 'stone' || l.kind === 'recharge') ledger.push(...toLedgerEntries(account.id, l.kind, [l.raw]))
    }
    summary.ledger += await mergeLedger(ledger)
    await mergeRoster(account.id, importRoster(entry.roster))
  }
  const efMeta = file.endfield.length ? await loadEfMeta() : undefined
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
        rarity: efRarity(r.rarity, String((type === 'char' ? r.charId : r.weaponId) ?? ''), efMeta),
        isNew: Boolean(r.isNew),
        isFree: Boolean(r.isFree),
        kind: String(r.kind ?? 'draw'),
        gachaTs: Number(r.gachaTs),
        seqId: String(r.seqId),
        // 新版导出文件保留了原来的来源
        source: r.source === 'api' ? 'api' : 'import',
      }
    })
    summary.pulls += await mergeEfPulls(account.id, pulls)
    await mergeRoster(account.id, importRoster(entry.roster))
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

/** 删除本地账号及其记录；云同步只删除这台设备上的状态和钥匙，不动云端（云端要在“云同步”里单独删除） */
export async function deleteAccountData(accountId: string): Promise<void> {
  await db.transaction('rw', [db.accounts, db.akPulls, db.efPulls, db.akLedger, db.cloud, db.roster], async () => {
    await db.akPulls.where('accountId').equals(accountId).delete()
    await db.roster.where('accountId').equals(accountId).delete()
    await db.efPulls.where('accountId').equals(accountId).delete()
    await db.akLedger.where('accountId').equals(accountId).delete()
    await db.cloud.delete(accountId)
    await db.accounts.delete(accountId)
  })
}
