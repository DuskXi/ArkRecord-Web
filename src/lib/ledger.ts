/**
 * 明日方舟的源石 / 充值记录。
 *
 * 记录有两种来源，统一保存在 akLedger 表里，原始条目原样保留在 raw 中：
 *   - 旧版存档、旧版导出（2022–2023 的旧接口）：
 *       源石 { timestamp(秒), operation, changes: [{ type, before, after }] }
 *       充值 { timestamp(秒), orderId, productName, amount(分), platform }
 *   - 新接口（官网用户中心的“源石记录”“充值记录”页）：
 *       源石 ak.hypergryph.com/user/api/inquiry/diamond → { operation, changeNum, after, eventTs(秒), pos }
 *       充值 u8.hypergryph.com/u8/pay/v1/recent        → { orderId, productName, amount(分), platform, payTime(秒) }
 *
 * 主键与来源无关：源石是“时间 + 操作 + 变化前后的数量”，充值是订单号。
 * 同一条记录不论从哪里来、以什么顺序、导入几次，都只保存一份。
 *
 * 官网只能查询最近 30 天（源石最多 100 条、充值最多 30 条），所以每次同步都顺便保存下来，越攒越全。
 */
import { Dexie } from 'dexie'
import { db } from './db'
import type { AkLedgerEntry } from './types'

export type LedgerKind = AkLedgerEntry['kind']
export type LedgerSource = 'legacy' | 'api'

export interface StoneRecord {
  key: string
  /** 毫秒时间戳 */
  ts: number
  operation: string
  before: number | null
  after: number | null
  /** 正数为获得，负数为消耗 */
  change: number | null
  platform: string | null
  source: LedgerSource
}

export interface RechargeRecord {
  key: string
  /** 毫秒时间戳 */
  ts: number
  orderId: string
  productName: string
  /** 金额（元） */
  yuan: number | null
  platform: string | null
  source: LedgerSource
}

interface RawStone {
  timestamp?: unknown
  eventTs?: unknown
  operation?: unknown
  changes?: { type?: unknown; before?: unknown; after?: unknown }[]
  changeNum?: unknown
  after?: unknown
}

interface RawRecharge {
  timestamp?: unknown
  payTime?: unknown
  orderId?: unknown
  productName?: unknown
  amount?: unknown
  platform?: unknown
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** 接口给的是秒；万一是毫秒也能识别 */
function seconds(value: unknown): number | null {
  const n = num(value)
  if (n === null || n <= 0) return null
  return Math.floor(n > 1e12 ? n / 1000 : n)
}

/** 原始条目先序列化一遍：调用方传入的可能是 Vue 响应式代理，IndexedDB 无法克隆代理对象（DataCloneError） */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function parseStone(raw: unknown): StoneRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as RawStone
  const isApi = r.eventTs !== undefined && r.timestamp === undefined
  const tsSec = seconds(isApi ? r.eventTs : r.timestamp)
  if (tsSec === null) return null
  let before: number | null
  let after: number | null
  let platform: string | null = null
  if (isApi) {
    after = num(r.after)
    const change = num(r.changeNum)
    before = after !== null && change !== null ? after - change : null
  } else {
    const first = Array.isArray(r.changes) ? r.changes[0] : undefined
    before = num(first?.before)
    after = num(first?.after)
    platform = first?.type === undefined || first?.type === null ? null : String(first.type)
  }
  const operation = String(r.operation ?? '')
  return {
    // 与旧版迁移时的主键格式一致（缺失的数量写作 undefined），已保存的记录不会因此重复
    key: `${tsSec}:${r.operation}:${before ?? undefined}:${after ?? undefined}`,
    ts: tsSec * 1000,
    operation,
    before,
    after,
    change: before !== null && after !== null ? after - before : null,
    platform,
    source: isApi ? 'api' : 'legacy',
  }
}

/** 充值平台：0 为 iOS，1 为安卓（与官网“充值记录”页一致） */
function rechargePlatform(value: unknown): string | null {
  if (value === 0 || value === '0') return 'iOS'
  if (value === 1 || value === '1') return '安卓'
  return value === undefined || value === null || value === '' ? null : String(value)
}

export function parseRecharge(raw: unknown): RechargeRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as RawRecharge
  const isApi = r.payTime !== undefined && r.timestamp === undefined
  const tsSec = seconds(isApi ? r.payTime : r.timestamp)
  if (tsSec === null) return null
  const cents = num(r.amount)
  return {
    // 与旧版迁移时的主键格式一致
    key: String(r.orderId ?? tsSec),
    ts: tsSec * 1000,
    orderId: r.orderId === undefined || r.orderId === null ? '' : String(r.orderId),
    productName: String(r.productName ?? ''),
    yuan: cents === null ? null : cents / 100,
    platform: rechargePlatform(r.platform),
    source: isApi ? 'api' : 'legacy',
  }
}

export function toLedgerEntries(accountId: string, kind: LedgerKind, raws: readonly unknown[]): AkLedgerEntry[] {
  const out: AkLedgerEntry[] = []
  for (const raw of raws) {
    const parsed = kind === 'stone' ? parseStone(raw) : parseRecharge(raw)
    if (parsed) out.push({ accountId, kind, key: parsed.key, ts: parsed.ts, raw: plain(raw) })
  }
  return out
}

/** 写入源石 / 充值记录，返回新增的条数（已有的记录按主键覆盖，不重复） */
export async function mergeLedger(entries: AkLedgerEntry[]): Promise<number> {
  if (!entries.length) return 0
  const existing = await db.akLedger.bulkGet(entries.map((e): [string, string, string] => [e.accountId, e.kind, e.key]))
  await db.akLedger.bulkPut(entries)
  return new Set(entries.filter((_, i) => !existing[i]).map((e) => `${e.kind}:${e.key}`)).size
}

/** 某个账号已保存的某类记录的主键 */
export async function ledgerKeys(accountId: string, kind: LedgerKind): Promise<Set<string>> {
  const keys = await db.akLedger
    .where('[accountId+kind+key]')
    .between([accountId, kind, Dexie.minKey], [accountId, kind, Dexie.maxKey], true, true)
    .primaryKeys()
  return new Set(keys.map(([, , key]) => key))
}

// ── 统计 ──

export interface StoneSummary {
  count: number
  gained: number
  spent: number
  /** 最近一条记录之后的源石数量 */
  balance: number | null
  /** 按操作类型汇总，消耗多的在前 */
  byOperation: { operation: string; count: number; gained: number; spent: number }[]
}

export function summarizeStone(records: readonly StoneRecord[]): StoneSummary {
  let gained = 0
  let spent = 0
  const ops = new Map<string, { operation: string; count: number; gained: number; spent: number }>()
  let latest: StoneRecord | null = null
  for (const r of records) {
    const op = ops.get(r.operation) ?? { operation: r.operation, count: 0, gained: 0, spent: 0 }
    op.count++
    if (r.change !== null && r.change > 0) {
      gained += r.change
      op.gained += r.change
    } else if (r.change !== null && r.change < 0) {
      spent -= r.change
      op.spent -= r.change
    }
    ops.set(r.operation, op)
    if (r.after !== null && (!latest || r.ts >= latest.ts)) latest = r
  }
  return {
    count: records.length,
    gained,
    spent,
    balance: latest?.after ?? null,
    byOperation: [...ops.values()].toSorted((a, b) => b.spent - a.spent || b.gained - a.gained || b.count - a.count),
  }
}

const MONTH = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })

export interface RechargeSummary {
  count: number
  yuan: number
  /** 按月汇总（北京时间），从早到晚，没有充值的月份也列出 */
  byMonth: { month: string; yuan: number; count: number }[]
  /** 按商品汇总，金额多的在前 */
  byProduct: { productName: string; yuan: number; count: number }[]
}

export function summarizeRecharge(records: readonly RechargeRecord[]): RechargeSummary {
  let yuan = 0
  const months = new Map<string, { month: string; yuan: number; count: number }>()
  const products = new Map<string, { productName: string; yuan: number; count: number }>()
  for (const r of records) {
    const amount = r.yuan ?? 0
    yuan += amount
    const month = MONTH.format(r.ts)
    const m = months.get(month) ?? { month, yuan: 0, count: 0 }
    m.yuan += amount
    m.count++
    months.set(month, m)
    const p = products.get(r.productName) ?? { productName: r.productName, yuan: 0, count: 0 }
    p.yuan += amount
    p.count++
    products.set(r.productName, p)
  }
  const sorted = [...months.keys()].toSorted()
  const byMonth: RechargeSummary['byMonth'] = []
  if (sorted.length) {
    let [y, mo] = sorted[0]!.split('-').map(Number) as [number, number]
    const last = sorted.at(-1)!
    for (;;) {
      const key = `${y}-${String(mo).padStart(2, '0')}`
      byMonth.push(months.get(key) ?? { month: key, yuan: 0, count: 0 })
      if (key >= last) break
      mo++
      if (mo > 12) {
        mo = 1
        y++
      }
    }
  }
  return {
    count: records.length,
    yuan: Math.round(yuan * 100) / 100,
    byMonth: byMonth.map((m) => ({ ...m, yuan: Math.round(m.yuan * 100) / 100 })),
    byProduct: [...products.values()]
      .map((p) => ({ ...p, yuan: Math.round(p.yuan * 100) / 100 }))
      .toSorted((a, b) => b.yuan - a.yuan || b.count - a.count),
  }
}
