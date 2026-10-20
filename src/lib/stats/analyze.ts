/**
 * 根据统一的寻访事件计算统计结果：保底状态、6★ 出货记录、运气、卡池汇总、按日/月统计。
 */
import type { PullEvent } from './events'
import { type Distribution, luckPercentile, remaining } from './pity'

export interface SixStarHit {
  event: PullEvent
  /** 这个 6★ 花了多少抽（在所属保底分组内计数） */
  pity: number
  /** 这是该卡池内的第几抽（只计入保底的抽数） */
  poolPull: number
}

export interface PityState {
  family: string
  label: string
  isolated: boolean
  /** 当前已垫抽数 */
  current: number
  /** 软保底开始、硬保底的抽数 */
  softPity: number
  hardPity: number
  /** 预计还需抽数的中位数与 90% 区间上界；没有概率模型（如终末地武器池）时为 null */
  expectedMedian: number | null
  expectedP90: number | null
  lastPoolName: string
  lastTs: number
  mainModel: boolean
}

export interface PoolSummary {
  poolId: string | null
  poolName: string
  ruleType: string
  family: string
  weapon: boolean
  pulls: number
  /** 计入保底的抽数（终末地不含免费十连和赠送） */
  paid: number
  stars: Record<3 | 4 | 5 | 6, number>
  sixStars: SixStarHit[]
  gotUp: boolean | null
  firstTs: number
  lastTs: number
}

export interface Analysis {
  /** 最高星级（来自 PityModel.topStar）：hits、mainIntervals 等“6★”都指这个星级 */
  topStar: number
  total: number
  stars: Record<3 | 4 | 5 | 6, number>
  hits: SixStarHit[]
  pity: PityState[]
  pools: PoolSummary[]
  /** 主保底模型下每个 6★ 的抽数 */
  mainIntervals: number[]
  avgPerSix: number | null
  /** UP 胜率：在已知 UP 名单的卡池中，6★ 是 UP 的比例（米哈游只算小保底的） */
  upWins: number
  upTotal: number
  /** 0–1，越大越欧 */
  luck: number | null
  perDay: Map<string, number>
  perMonth: Map<string, number>
  firstTs: number | null
  lastTs: number | null
}

export interface PityModel {
  /** 出 6★ 所需抽数的分布；规则不明确、无法建模时为 null（只显示保底进度，不计算期望与运气） */
  dist: Distribution | null
  softPity: number
  hardPity: number
  /** 最高星级：鹰角两款 6★（默认），米哈游 5★。保底计数、运气都按它算 */
  topStar?: number
  /** dist 是按官方公布的数字推算的，不是官方公布的曲线（米哈游）：界面上要标“推算，非官方” */
  derived?: boolean
}

const DAY_FORMAT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })

export function dayKey(ts: number): string {
  return DAY_FORMAT.format(ts)
}

function emptyStars(): Record<3 | 4 | 5 | 6, number> {
  return { 3: 0, 4: 0, 5: 0, 6: 0 }
}

export function analyze(events: PullEvent[], model: PityModel): Analysis {
  const top = model.topStar ?? 6
  const stars = emptyStars()
  const hits: SixStarHit[] = []
  const counters = new Map<string, { count: number; label: string; isolated: boolean; lastPool: string; lastTs: number; main: boolean }>()
  const pools = new Map<string, PoolSummary>()
  const perDay = new Map<string, number>()
  const perMonth = new Map<string, number>()
  let total = 0

  for (const e of events) {
    if (e.star >= 3 && e.star <= 6) stars[e.star as 3 | 4 | 5 | 6]++
    total++
    const day = dayKey(e.ts)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
    const month = day.slice(0, 7)
    perMonth.set(month, (perMonth.get(month) ?? 0) + 1)

    const poolKey = e.poolId ?? `name:${e.poolName}`
    let pool = pools.get(poolKey)
    if (!pool) {
      pool = {
        poolId: e.poolId,
        poolName: e.poolName,
        ruleType: e.ruleType,
        family: e.family,
        weapon: e.weapon,
        pulls: 0,
        paid: 0,
        stars: emptyStars(),
        sixStars: [],
        gotUp: null,
        firstTs: e.ts,
        lastTs: e.ts,
      }
      pools.set(poolKey, pool)
    }
    pool.pulls++
    pool.lastTs = e.ts
    if (e.star >= 3 && e.star <= 6) pool.stars[e.star as 3 | 4 | 5 | 6]++

    if (!e.countsForPity) continue
    pool.paid++
    const counter = counters.get(e.family) ?? {
      count: 0,
      label: e.familyLabel,
      isolated: e.isolated,
      lastPool: e.poolName,
      lastTs: e.ts,
      main: e.mainModel,
    }
    counter.count++
    counter.lastPool = e.poolName
    counter.lastTs = e.ts
    if (e.star === top) {
      const hit = { event: e, pity: counter.count, poolPull: pool.paid }
      hits.push(hit)
      pool.sixStars.push(hit)
      if (e.isUp !== null) pool.gotUp = (pool.gotUp ?? false) || e.isUp
      counter.count = 0
    }
    counters.set(e.family, counter)
  }

  const pity: PityState[] = [...counters.entries()].map(([family, c]) => {
    const rest = model.dist ? remaining(model.dist, c.count) : null
    return {
      family,
      label: c.label,
      isolated: c.isolated,
      current: c.count,
      softPity: model.softPity,
      hardPity: model.hardPity,
      expectedMedian: rest?.median ?? null,
      expectedP90: rest ? quantileOf(rest, 0.9) : null,
      lastPoolName: c.lastPool,
      lastTs: c.lastTs,
      mainModel: c.main,
    }
  })

  const mainIntervals = hits.filter((h) => h.event.mainModel).map((h) => h.pity)
  // 米哈游的大保底必是 UP，不算进胜率；看不出大小保底的也不算
  const known = hits.filter((h) => h.event.isUp !== null && (h.event.upShare === undefined || h.event.guarantee === 'small'))
  return {
    topStar: top,
    total,
    stars,
    hits,
    pity,
    pools: [...pools.values()].toSorted((a, b) => b.lastTs - a.lastTs),
    mainIntervals,
    avgPerSix: mainIntervals.length ? mainIntervals.reduce((a, b) => a + b, 0) / mainIntervals.length : null,
    upWins: known.filter((h) => h.event.isUp).length,
    upTotal: known.length,
    luck: model.dist ? luckPercentile(model.dist, mainIntervals) : null,
    perDay,
    perMonth,
    firstTs: events[0]?.ts ?? null,
    lastTs: events.at(-1)?.ts ?? null,
  }
}

function quantileOf(dist: Distribution, q: number): number {
  let acc = 0
  for (let i = 0; i < dist.pmf.length; i++) {
    acc += dist.pmf[i]!
    if (acc >= q) return i + 1
  }
  return dist.pmf.length
}

/** 运气百分位的文字描述 */
export function luckLabel(luck: number | null): { text: string; tone: 'great' | 'good' | 'neutral' | 'bad' | 'awful' } {
  if (luck === null) return { text: '样本不足', tone: 'neutral' }
  if (luck >= 0.9) return { text: '欧皇', tone: 'great' }
  if (luck >= 0.65) return { text: '偏欧', tone: 'good' }
  if (luck > 0.35) return { text: '符合期望', tone: 'neutral' }
  if (luck > 0.1) return { text: '偏非', tone: 'bad' }
  return { text: '非酋', tone: 'awful' }
}
