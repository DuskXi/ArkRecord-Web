/**
 * 原神、星铁的基础统计：每组卡池的抽数、5★ 列表（每个 5★ 用了多少抽）、距离上一个 5★ / 4★ 的抽数。
 *
 * 只数事实，不推断规则：保底上限、“小保底 / 大保底”、UP 判定这些要按官方公示核对后再写（docs/desktop/plan.md），
 * 这里不做。同一组卡池（原神 301 和 400）共用计数。
 */
import { MHY_POOLS, type MhyGame, type MhyPoolInfo, type MhyPull } from './types'

export interface MhyFiveStar {
  pull: MhyPull
  /** 距离上一个 5★（或这组的第一抽）用了多少抽，含这一抽 */
  pity: number
}

export interface MhyPoolSummary {
  pool: MhyPoolInfo
  total: number
  fiveStars: MhyFiveStar[]
  fourStars: number
  /** 最近一个 5★ 之后又抽了多少 */
  sinceFive: number
  /** 最近一个 4★ 或 5★ 之后又抽了多少 */
  sinceFour: number
  first?: number
  last?: number
}

/** 从旧到新：先按时间，同一秒（十连）按 id */
export function compareMhyPulls(a: MhyPull, b: MhyPull): number {
  if (a.ts !== b.ts) return a.ts - b.ts
  if (a.id.length !== b.id.length) return a.id.length - b.id.length
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function summarizeMhy(game: MhyGame, pulls: readonly MhyPull[]): MhyPoolSummary[] {
  const byGroup = new Map<string, MhyPull[]>()
  const groupOf = new Map(MHY_POOLS[game].map((p) => [p.type, p.group]))
  for (const p of pulls) {
    const group = groupOf.get(p.pool)
    if (!group) continue
    let list = byGroup.get(group)
    if (!list) byGroup.set(group, (list = []))
    list.push(p)
  }
  const seen = new Set<string>()
  const out: MhyPoolSummary[] = []
  for (const pool of MHY_POOLS[game]) {
    if (seen.has(pool.group)) continue
    seen.add(pool.group)
    const list = (byGroup.get(pool.group) ?? []).toSorted(compareMhyPulls)
    const fiveStars: MhyFiveStar[] = []
    let fourStars = 0
    let sinceFive = 0
    let sinceFour = 0
    for (const p of list) {
      sinceFive++
      sinceFour++
      if (p.rank === 5) {
        fiveStars.push({ pull: p, pity: sinceFive })
        sinceFive = 0
        sinceFour = 0
      } else if (p.rank === 4) {
        fourStars++
        sinceFour = 0
      }
    }
    out.push({ pool, total: list.length, fiveStars, fourStars, sinceFive, sinceFour, first: list[0]?.ts, last: list.at(-1)?.ts })
  }
  return out
}
