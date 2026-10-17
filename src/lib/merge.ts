/**
 * 同一条记录有多个版本时保留哪一个（docs/rewrite/cloud-sync.md 10.1）。
 *
 * 同一个键可能出现内容不同的版本：例如同一抽在一台设备上来自接口、在另一台上来自导入文件。
 * 每种记录都在一个全序上取最大值，所以合并结果与顺序无关（幂等、交换、结合）：
 *   - 寻访：来源 接口 > 导入 > 旧版 → 字段更全的 → 规范编码按 UTF-8 字节序更小的；
 *   - 终末地卡池信息：fetchedAt 更新的 → 规范编码更小的；
 *   - 源石 / 充值的规则在 ledger.ts（要用到那里的格式识别）。
 * 从鹰角同步、导入文件、云同步都走这里，不再有“后写的覆盖先写的”或“先写的保留”这类与顺序有关的规则。
 */
import { compareUtf8, jcs } from './jcs'
import type { AkPull, EfPoolInfo, EfPull } from './types'

/** 记录去掉 accountId（由所在账号决定）后的规范编码；宽松模式，永远不报错 */
function canonicalOf(record: object): string {
  const { accountId: _, ...rest } = record as Record<string, unknown>
  return jcs(rest, false)
}

/** 有值的字段数（不计 accountId） */
export function fieldCount(record: object): number {
  return Object.entries(record).filter(([k, v]) => k !== 'accountId' && v !== undefined).length
}

/**
 * 按“排名（逐项比较，大者优先）→ 规范编码更小者优先”比较两个版本：返回值大于 0 表示 a 更好，0 表示两者完全相同。
 */
export function compareVersions<T extends object>(a: T, b: T, rank: (r: T) => readonly number[]): number {
  const ra = rank(a)
  const rb = rank(b)
  for (let i = 0; i < ra.length; i++) {
    const d = (ra[i] ?? 0) - (rb[i] ?? 0)
    if (d !== 0) return d
  }
  return compareUtf8(canonicalOf(b), canonicalOf(a))
}

/** 两个版本中保留更好的那个；完全相同时返回第一个（调用方据此判断不需要写入） */
export function pickBetter<T extends object>(a: T, b: T, rank: (r: T) => readonly number[]): T {
  return compareVersions(a, b, rank) >= 0 ? a : b
}

/** 按键去重，同键只留更好的版本 */
export function dedupeBy<T extends object>(records: readonly T[], keyOf: (r: T) => string, pick: (a: T, b: T) => T): T[] {
  const out = new Map<string, T>()
  for (const r of records) {
    const key = keyOf(r)
    const prev = out.get(key)
    out.set(key, prev ? pick(prev, r) : r)
  }
  return [...out.values()]
}

const AK_SOURCE_RANK: Record<AkPull['source'], number> = { api: 2, import: 1, legacy: 0 }
export const akPullRank = (p: AkPull) => [AK_SOURCE_RANK[p.source] ?? -1, fieldCount(p)] as const
export const pickAkPull = (a: AkPull, b: AkPull) => pickBetter(a, b, akPullRank)

const EF_SOURCE_RANK: Record<EfPull['source'], number> = { api: 1, import: 0 }
export const efPullRank = (p: EfPull) => [EF_SOURCE_RANK[p.source] ?? -1, fieldCount(p)] as const
export const pickEfPull = (a: EfPull, b: EfPull) => pickBetter(a, b, efPullRank)

export const efPoolRank = (p: EfPoolInfo) => [p.fetchedAt] as const
export const pickEfPool = (a: EfPoolInfo, b: EfPoolInfo) => pickBetter(a, b, efPoolRank)

/**
 * 新来的记录与本地已有的同键记录逐条比较（existing[i] 对应 incoming[i]，没有则为 undefined），
 * 返回需要写入的记录（新增的，或比已有版本更好的）和新增的条数。
 */
export function planWrites<T extends object>(
  incoming: readonly T[],
  existing: readonly (T | undefined)[],
  pick: (a: T, b: T) => T,
): { writes: T[]; added: number } {
  const writes: T[] = []
  let added = 0
  incoming.forEach((record, i) => {
    const current = existing[i]
    if (!current) {
      added++
      writes.push(record)
    } else if (pick(current, record) !== current) {
      writes.push(record)
    }
  })
  return { writes, added }
}
