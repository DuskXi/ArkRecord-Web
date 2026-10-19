/**
 * 高级统计：十连、5★ 间隔、各种纪录、收集情况、抽卡时段。全部由寻访事件在本地计算。
 */
import { type Analysis, dayKey, type SixStarHit } from './analyze'
import type { PullEvent } from './events'

/** 一次寻访操作：同一时间、同一卡池的记录（十连或单抽） */
export interface Batch {
  key: string
  ts: number
  poolId: string | null
  poolName: string
  /** 按抽取顺序 */
  events: PullEvent[]
  kind: 'ten' | 'single' | 'other'
}

export function groupBatches(events: PullEvent[]): Batch[] {
  const out: Batch[] = []
  let current: Batch | null = null
  for (const e of events) {
    if (current && current.ts === e.ts && current.poolId === e.poolId && current.poolName === e.poolName) {
      current.events.push(e)
      continue
    }
    current = { key: e.key, ts: e.ts, poolId: e.poolId, poolName: e.poolName, events: [e], kind: 'single' }
    out.push(current)
  }
  for (const b of out) b.kind = b.events.length === 10 ? 'ten' : b.events.length === 1 ? 'single' : 'other'
  return out
}

export function bestStar(batch: Batch): number {
  return Math.max(...batch.events.map((e) => e.star))
}

export interface CollectionEntry {
  id: string
  itemId: string | null
  name: string
  star: number
  weapon: boolean
  count: number
  up: number
  firstTs: number
  lastTs: number
}

export interface Insights {
  batches: Batch[]
  tenPulls: number
  singles: number
  /** 十连按最高星级分类的次数 */
  tenByBest: Record<3 | 4 | 5 | 6, number>
  /** 出了 2 个及以上 6★ 的十连 */
  multiSixTens: Batch[]
  /** 6★、5★ 最多的一次十连 */
  bestTen: Batch | null
  /** 5★ 及以上之间的间隔（只计入保底的抽数） */
  fivePlus: { count: number; avgGap: number | null; longestGap: number; current: number }
  fastestSix: SixStarHit | null
  slowestSix: SixStarHit | null
  firstSix: SixStarHit | null
  busiestDay: { day: string; pulls: number; six: number } | null
  /** 6★ 最多的一天 */
  luckiestDay: { day: string; pulls: number; six: number } | null
  /** [星期一..星期日][0..23 时] 的抽数，北京时间 */
  hourWeek: number[][]
  /** 同上，出 6★ 的次数 */
  sixHourWeek: number[][]
  /** 每个小时的抽数与出 6★ 数（只计入保底的抽数），用于看各时段出 6★ 的比例 */
  byHour: { pulls: number; six: number }[]
  collection: CollectionEntry[]
  /** 按时间顺序的 6★ 与截至当时的平均抽数 */
  sixSequence: { hit: SixStarHit; runningAvg: number }[]
}

const CN_OFFSET_MS = 8 * 3600 * 1000

export function computeInsights(events: PullEvent[], analysis: Analysis): Insights {
  // 最高星级（鹰角 6★，米哈游 5★）；下面的 six / five 指最高星级和次一级
  const top = analysis.topStar
  const batches = groupBatches(events)
  const tenByBest: Record<3 | 4 | 5 | 6, number> = { 3: 0, 4: 0, 5: 0, 6: 0 }
  const multiSixTens: Batch[] = []
  let bestTen: Batch | null = null
  let bestScore = -1
  let tenPulls = 0
  let singles = 0
  for (const b of batches) {
    if (b.kind === 'single') singles++
    if (b.kind !== 'ten') continue
    tenPulls++
    const best = bestStar(b)
    if (best >= 3 && best <= 6) tenByBest[best as 3 | 4 | 5 | 6]++
    const six = b.events.filter((e) => e.star === top).length
    const five = b.events.filter((e) => e.star === top - 1).length
    if (six >= 2) multiSixTens.push(b)
    const score = six * 100 + five
    if (score > bestScore) {
      bestScore = score
      bestTen = b
    }
  }

  // 5★ 及以上的间隔
  let gap = 0
  let gapCount = 0
  let gapTotal = 0
  let longestGap = 0
  let fivePlusCount = 0
  for (const e of events) {
    if (!e.countsForPity || e.weapon) continue
    gap++
    if (e.star >= top - 1) {
      fivePlusCount++
      gapTotal += gap
      gapCount++
      longestGap = Math.max(longestGap, gap)
      gap = 0
    }
  }
  longestGap = Math.max(longestGap, gap)

  // 按天统计
  const days = new Map<string, { pulls: number; six: number }>()
  const hourWeek = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  const sixHourWeek = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  const byHour = Array.from({ length: 24 }, () => ({ pulls: 0, six: 0 }))
  for (const e of events) {
    const day = dayKey(e.ts)
    const d = days.get(day) ?? { pulls: 0, six: 0 }
    d.pulls++
    if (e.star === top && !e.weapon) d.six++
    days.set(day, d)
    // 中国没有夏令时，固定 +8 小时即可得到北京时间
    const local = new Date(e.ts + CN_OFFSET_MS)
    const weekday = (local.getUTCDay() + 6) % 7
    const hour = local.getUTCHours()
    hourWeek[weekday]![hour]!++
    if (e.star === top) sixHourWeek[weekday]![hour]!++
    if (e.countsForPity) {
      byHour[hour]!.pulls++
      if (e.star === top) byHour[hour]!.six++
    }
  }
  let busiestDay: Insights['busiestDay'] = null
  let luckiestDay: Insights['luckiestDay'] = null
  for (const [day, d] of days) {
    if (!busiestDay || d.pulls > busiestDay.pulls) busiestDay = { day, ...d }
    if (d.six > 0 && (!luckiestDay || d.six > luckiestDay.six || (d.six === luckiestDay.six && d.pulls < luckiestDay.pulls))) {
      luckiestDay = { day, ...d }
    }
  }

  // 收集
  const collection = new Map<string, CollectionEntry>()
  for (const e of events) {
    if (e.star < top - 1) continue
    const id = `${e.weapon ? 'w' : 'c'}:${e.itemId ?? e.name}`
    const c = collection.get(id) ?? {
      id,
      itemId: e.itemId,
      name: e.name,
      star: e.star,
      weapon: e.weapon,
      count: 0,
      up: 0,
      firstTs: e.ts,
      lastTs: e.ts,
    }
    c.count++
    if (e.isUp) c.up++
    c.lastTs = e.ts
    collection.set(id, c)
  }

  const hits = analysis.hits.filter((h) => !h.event.weapon)
  let total = 0
  const sixSequence = hits.map((hit, i) => {
    total += hit.pity
    return { hit, runningAvg: total / (i + 1) }
  })
  const byPity = hits.toSorted((a, b) => a.pity - b.pity || a.event.ts - b.event.ts)

  return {
    batches,
    tenPulls,
    singles,
    tenByBest,
    multiSixTens,
    bestTen: bestScore >= 100 ? bestTen : null,
    fivePlus: { count: fivePlusCount, avgGap: gapCount ? gapTotal / gapCount : null, longestGap, current: gap },
    fastestSix: byPity[0] ?? null,
    slowestSix: byPity.at(-1) ?? null,
    firstSix: hits[0] ?? null,
    busiestDay,
    luckiestDay,
    hourWeek,
    sixHourWeek,
    byHour,
    collection: [...collection.values()].toSorted((a, b) => b.star - a.star || b.count - a.count || b.lastTs - a.lastTs),
    sixSequence,
  }
}
