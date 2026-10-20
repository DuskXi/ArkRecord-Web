/**
 * 可选的 UIGF 导入导出（维护者 2026-10-20：“UIGF别高调宣传，就纯粹在导入导出那边有个开关可以打开”）。
 *
 * 导入：UIGF v4.0～v4.2 的原神（hk4e）和星铁（hkrpg）；绝区零（nap）和千星奇域（hk4e_ugc）不支持，预览里列出跳过了什么。
 * 也认旧格式：UIGF v2.x / v3.x（只有原神）和 SRGF v1.x（只有星铁）。
 * - 记录的时间按文件里的时区（timezone）换算；文件里的 id 就是接口的 id，按 id 去重。
 * - 和本机已有的记录合并时，接口拉到的优先（record.ts 的 pickMhyPull），所以导入只追加、不覆盖接口的记录，也不删除任何记录。
 * - 缺少名称或星级的记录跳过：本应用没有物品 ID 对照表，只有 ID 显示不出来，也算不了保底。
 * - 先 previewUigf 看会发生什么（不写库），确认后 importUigf 才写。
 *
 * 导出：UIGF v4.2，一个游戏的一个或多个账号。时间按账号的时区从时间戳重新换算（不同来源的记录统一）。
 * 原神的接口不给 item_id，导出时 item_id 是空字符串（UIGF 的格式校验允许，但别的工具导入时可能需要 ID）。
 */
import { dedupeBy, planWrites } from '../merge'
import { type MhyDB, mhyDb } from './db'
import { pickMhyPull } from './record'
import { compareMhyPulls } from './stats'
import { toTimestamp } from './time'
import { type MhyAccount, type MhyGame, type MhyPull, mhyAccountId, poolInfo, poolOf } from './types'

/** 文件里一个账号的一段记录 */
export interface UigfSection {
  game: MhyGame
  uid: string
  /** 记录里的时间是哪个时区的（小时） */
  timezone: number
  lang: string
  list: readonly unknown[]
}

export interface ParsedUigf {
  /** 例如 “UIGF v4.2”“SRGF v1.0” */
  format: string
  /** 导出这个文件的应用（文件里写的） */
  exportApp: string
  sections: UigfSection[]
  /** 不支持、跳过的部分（给用户看） */
  unsupported: string[]
}

export interface UigfPreviewItem {
  game: MhyGame
  uid: string
  accountId: string
  /** 本机已经有这个账号 */
  accountExists: boolean
  timezone: number
  lang: string
  /** 文件里的条数 */
  total: number
  /** 会新增的条数 */
  added: number
  /** 本机已有、或文件里重复的条数 */
  duplicate: number
  skipped: number
  /** 跳过的原因 → 条数 */
  skippedReasons: Record<string, number>
  firstTs?: number
  lastTs?: number
  warnings: string[]
}

export interface UigfPreview {
  format: string
  exportApp: string
  items: UigfPreviewItem[]
  unsupported: string[]
}

const GAME_KEYS: Record<MhyGame, 'hk4e' | 'hkrpg'> = { genshin: 'hk4e', starrail: 'hkrpg' }
const UID_RE = /^\d{1,12}$/
const ID_RE = /^\d{1,19}$/
const RANK_RE = /^[1-5]$/
const HK4E_UIGF_TYPES = new Set(['100', '200', '301', '302', '500'])

class UigfError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uidOf(value: unknown): string | undefined {
  const uid = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  return typeof uid === 'string' && UID_RE.test(uid) ? uid : undefined
}

function timezoneOf(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^-?\d{1,2}$/.test(value.trim()) ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= -12 && n <= 14 ? n : undefined
}

// ───────────── 区服（导入的新账号用；文件里没有区服） ─────────────

/** 按 UID 的第一位推断区服；推断不出来时 region、gameBiz 为空字符串 */
export function regionFromUid(game: MhyGame, uid: string): { region: string; gameBiz: string } {
  const first = uid.length === 9 ? uid[0] : undefined
  const table: Record<MhyGame, Record<string, [string, string]>> = {
    genshin: {
      '1': ['cn_gf01', 'hk4e_cn'],
      '2': ['cn_gf01', 'hk4e_cn'],
      '5': ['cn_qd01', 'hk4e_cn'],
      '6': ['os_usa', 'hk4e_global'],
      '7': ['os_euro', 'hk4e_global'],
      '8': ['os_asia', 'hk4e_global'],
      '9': ['os_cht', 'hk4e_global'],
    },
    starrail: {
      '1': ['prod_gf_cn', 'hkrpg_cn'],
      '2': ['prod_gf_cn', 'hkrpg_cn'],
      '5': ['prod_qd_cn', 'hkrpg_cn'],
      '6': ['prod_official_usa', 'hkrpg_global'],
      '7': ['prod_official_eur', 'hkrpg_global'],
      '8': ['prod_official_asia', 'hkrpg_global'],
      '9': ['prod_official_cht', 'hkrpg_global'],
    },
  }
  const hit = first ? table[game][first] : undefined
  return hit ? { region: hit[0], gameBiz: hit[1] } : { region: '', gameBiz: '' }
}

/** 旧格式没有时区时按区服：美服 -5，欧服 +1，其余 +8 */
function defaultTimezone(game: MhyGame, uid: string): number {
  const { region } = regionFromUid(game, uid)
  return /usa/.test(region) ? -5 : /eur/.test(region) ? 1 : 8
}

// ───────────── 解析 ─────────────

function sectionsOf(game: MhyGame, value: unknown): UigfSection[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new UigfError(`文件里的 ${GAME_KEYS[game]} 不是列表，文件可能已损坏`)
  return value.map((entry, i) => {
    if (!isObject(entry)) throw new UigfError(`文件里 ${GAME_KEYS[game]} 的第 ${i + 1} 个账号格式不对`)
    const uid = uidOf(entry.uid)
    const timezone = timezoneOf(entry.timezone)
    if (!uid) throw new UigfError(`文件里 ${GAME_KEYS[game]} 的第 ${i + 1} 个账号缺少 UID`)
    if (timezone === undefined) throw new UigfError(`文件里 UID ${uid} 的时区（timezone）缺失或不对`)
    if (!Array.isArray(entry.list)) throw new UigfError(`文件里 UID ${uid} 没有记录列表（list）`)
    return { game, uid, timezone, lang: typeof entry.lang === 'string' ? entry.lang : '', list: entry.list }
  })
}

function countOf(value: unknown): { accounts: number; records: number } {
  if (!Array.isArray(value)) return { accounts: 0, records: 0 }
  return {
    accounts: value.length,
    records: value.reduce((n: number, e) => n + (isObject(e) && Array.isArray(e.list) ? e.list.length : 0), 0),
  }
}

/** 读 UIGF / SRGF 文件（已经 JSON.parse 过的对象）。格式不对时抛出的错误信息可以直接给用户看 */
export function parseUigf(json: unknown): ParsedUigf {
  if (!isObject(json) || !isObject(json.info)) throw new UigfError('不是 UIGF 格式的文件（缺少 info）')
  const info = json.info
  const exportApp = typeof info.export_app === 'string' ? info.export_app : ''

  // UIGF v4.x：多个游戏、多个账号
  if (typeof info.version === 'string') {
    const m = /^v(\d+)\.(\d+)$/.exec(info.version)
    if (!m || m[1] !== '4') throw new UigfError(`不支持的 UIGF 版本：${info.version}（支持 v4.0～v4.2 和旧的 v2、v3）`)
    const sections = [...sectionsOf('genshin', json.hk4e), ...sectionsOf('starrail', json.hkrpg)]
    const unsupported: string[] = []
    for (const [key, label] of [
      ['nap', '绝区零'],
      ['hk4e_ugc', '千星奇域'],
    ] as const) {
      const { accounts, records } = countOf(json[key])
      if (accounts) unsupported.push(`${label}：${accounts} 个账号、${records} 条记录（不支持，已跳过）`)
    }
    return { format: `UIGF ${info.version}`, exportApp, sections, unsupported }
  }

  // 旧格式：一个文件一个账号
  const legacy =
    typeof info.uigf_version === 'string' && /^v[23]\.\d+$/.test(info.uigf_version)
      ? { game: 'genshin' as const, format: `UIGF ${info.uigf_version}` }
      : typeof info.srgf_version === 'string' && /^v1\.\d+$/.test(info.srgf_version)
        ? { game: 'starrail' as const, format: `SRGF ${info.srgf_version}` }
        : undefined
  if (!legacy) throw new UigfError('不是 UIGF 格式的文件（看不出版本号）')
  if (!Array.isArray(json.list)) throw new UigfError('文件里没有记录列表（list）')
  const firstUid = json.list.find((r) => isObject(r) && uidOf(r.uid))
  const uid = uidOf(info.uid) ?? (isObject(firstUid) ? uidOf(firstUid.uid) : undefined)
  if (!uid) throw new UigfError('文件里缺少 UID')
  const timezone = timezoneOf(info.region_time_zone) ?? defaultTimezone(legacy.game, uid)
  return {
    format: legacy.format,
    exportApp,
    sections: [{ game: legacy.game, uid, timezone, lang: typeof info.lang === 'string' ? info.lang : '', list: json.list }],
    unsupported: [],
  }
}

// ───────────── 转换 ─────────────

type Converted = { pull: MhyPull } | { reason: string }

function convert(section: UigfSection, accountId: string, raw: unknown): Converted {
  if (!isObject(raw)) return { reason: '格式不对' }
  const s = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined)
  const id = s('id')
  if (!id || !ID_RE.test(id)) return { reason: '缺少记录 ID' }
  // 旧格式的每条记录也带 uid：不是这个账号的跳过
  const rowUid = uidOf(raw.uid)
  if (rowUid && rowUid !== section.uid) return { reason: '属于别的 UID' }
  const gachaType = s('gacha_type') ?? ''
  const uigfType = s('uigf_gacha_type')
  const pool = section.game === 'genshin' && uigfType && HK4E_UIGF_TYPES.has(uigfType) ? uigfType : poolOf(section.game, gachaType)
  if (!gachaType || !poolInfo(section.game, pool)) return { reason: '卡池类型不认识' }
  const name = s('name')
  if (!name) return { reason: '缺少名称（只有物品 ID）' }
  const rank = s('rank_type')
  if (!rank || !RANK_RE.test(rank)) return { reason: '缺少星级' }
  const time = s('time') ?? ''
  const ts = toTimestamp(time, section.timezone)
  if (!Number.isFinite(ts)) return { reason: '时间格式不对' }
  const count = Number(s('count') ?? '1')
  const pull: MhyPull = {
    accountId,
    id,
    gachaType,
    pool,
    itemId: s('item_id') ?? '',
    name,
    itemType: s('item_type') ?? '',
    rank: Number(rank),
    count: Number.isSafeInteger(count) && count > 0 ? count : 1,
    time,
    ts,
    lang: section.lang || s('lang') || '',
    source: 'import',
  }
  const gachaId = s('gacha_id')
  if (gachaId) pull.gachaId = gachaId
  return { pull }
}

interface Group {
  game: MhyGame
  uid: string
  accountId: string
  timezone: number
  lang: string
  total: number
  pulls: MhyPull[]
  skippedReasons: Record<string, number>
  timezones: Set<number>
}

function groupSections(parsed: ParsedUigf): Group[] {
  const groups = new Map<string, Group>()
  for (const section of parsed.sections) {
    const accountId = mhyAccountId(section.game, section.uid)
    let group = groups.get(accountId)
    if (!group) {
      group = {
        game: section.game,
        uid: section.uid,
        accountId,
        timezone: section.timezone,
        lang: section.lang,
        total: 0,
        pulls: [],
        skippedReasons: {},
        timezones: new Set(),
      }
      groups.set(accountId, group)
    }
    group.timezones.add(section.timezone)
    for (const raw of section.list) {
      group.total++
      const result = convert(section, accountId, raw)
      if ('pull' in result) group.pulls.push(result.pull)
      else group.skippedReasons[result.reason] = (group.skippedReasons[result.reason] ?? 0) + 1
    }
  }
  return [...groups.values()]
}

// ───────────── 预览、导入 ─────────────

/** 导入会发生什么（不写库） */
export async function previewUigf(parsed: ParsedUigf, db: MhyDB = mhyDb): Promise<UigfPreview> {
  const items: UigfPreviewItem[] = []
  for (const group of groupSections(parsed)) {
    const account = await db.accounts.get(group.accountId)
    const unique = dedupeBy(group.pulls, (p) => p.id, pickMhyPull)
    const existing = await db.pulls.bulkGet(unique.map((p) => [p.accountId, p.id] as [string, string]))
    const added = existing.filter((e) => !e).length
    const skipped = Object.values(group.skippedReasons).reduce((a, b) => a + b, 0)
    const warnings: string[] = []
    if (group.timezones.size > 1) warnings.push('同一个 UID 在文件里出现了几次、时区不同，各段按自己的时区换算')
    if (account && account.utcOffset !== group.timezone) {
      warnings.push(`文件里的时区是 UTC${sign(group.timezone)}，本机这个账号是 UTC${sign(account.utcOffset)}；导入的记录按文件的时区换算`)
    }
    if (group.lang && group.lang !== 'zh-cn') warnings.push('记录不是简体中文：不判断歪没歪，也不显示图标')
    if (!account && !regionFromUid(group.game, group.uid).region) warnings.push('从 UID 看不出区服，账号的区服先空着，下次从游戏读取时补上')
    const ts = unique.map((p) => p.ts)
    items.push({
      game: group.game,
      uid: group.uid,
      accountId: group.accountId,
      accountExists: !!account,
      timezone: group.timezone,
      lang: group.lang,
      total: group.total,
      added,
      duplicate: group.pulls.length - added,
      skipped,
      skippedReasons: group.skippedReasons,
      ...(ts.length ? { firstTs: Math.min(...ts), lastTs: Math.max(...ts) } : {}),
      warnings,
    })
  }
  return { format: parsed.format, exportApp: parsed.exportApp, items, unsupported: parsed.unsupported }
}

function sign(offset: number): string {
  return offset >= 0 ? `+${offset}` : String(offset)
}

/** 写入本机：只追加，同一条记录本机已有时按合并规则保留更好的（接口拉到的优先）。返回涉及的账号和新增条数 */
export async function importUigf(
  parsed: ParsedUigf,
  db: MhyDB = mhyDb,
  now: () => number = Date.now,
): Promise<{ accountIds: string[]; added: number }> {
  const accountIds: string[] = []
  let added = 0
  for (const group of groupSections(parsed)) {
    // 一条有效记录都没有：不建空账号
    if (!group.pulls.length) continue
    await db.transaction('rw', db.accounts, db.pulls, async () => {
      const existing = await db.accounts.get(group.accountId)
      if (!existing) {
        const account: MhyAccount = {
          id: group.accountId,
          game: group.game,
          uid: group.uid,
          ...regionFromUid(group.game, group.uid),
          utcOffset: group.timezone,
          createdAt: now(),
        }
        await db.accounts.put(account)
      }
      const incoming = dedupeBy(group.pulls, (p) => p.id, pickMhyPull)
      const current = await db.pulls.bulkGet(incoming.map((p) => [p.accountId, p.id] as [string, string]))
      const plan = planWrites(incoming, current, pickMhyPull)
      await db.pulls.bulkPut(plan.writes)
      added += plan.added
    })
    accountIds.push(group.accountId)
  }
  return { accountIds, added }
}

// ───────────── 导出 ─────────────

function localTime(ts: number, offsetHours: number): string {
  return new Date(ts + offsetHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
}

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

/** UIGF v4.2 的对象（序列化、保存由页面做）。accountIds 为空时导出这个游戏的全部账号 */
export async function exportUigf(
  game: MhyGame,
  accountIds: readonly string[] = [],
  db: MhyDB = mhyDb,
  options: { now?: number; appVersion?: string } = {},
): Promise<Record<string, unknown>> {
  const accounts = (await db.accounts.where('game').equals(game).toArray())
    .filter((a) => !accountIds.length || accountIds.includes(a.id))
    .toSorted((a, b) => a.uid.localeCompare(b.uid))
  const entries = []
  for (const account of accounts) {
    const pulls = (await db.pulls.where('accountId').equals(account.id).toArray()).toSorted(compareMhyPulls)
    const offset = account.utcOffset
    const list = pulls.map((p) => {
      const common = {
        gacha_type: p.gachaType,
        item_id: p.itemId,
        count: String(p.count),
        time: localTime(p.ts, offset),
        name: p.name,
        item_type: p.itemType,
        rank_type: String(p.rank),
        id: p.id,
      }
      return game === 'genshin' ? { uigf_gacha_type: p.pool, ...common } : { gacha_id: p.gachaId ?? '', ...common }
    })
    const lang = mostCommon(pulls.map((p) => p.lang))
    // lang 在 UIGF 里是可选的，不知道就不写
    entries.push({ uid: account.uid, timezone: offset, ...(lang ? { lang } : {}), list })
  }
  return {
    info: {
      export_timestamp: Math.floor((options.now ?? Date.now()) / 1000),
      export_app: 'ArkRecord',
      export_app_version: options.appVersion ?? (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0'),
      version: 'v4.2',
    },
    [GAME_KEYS[game]]: entries,
  }
}

export { UigfError }
