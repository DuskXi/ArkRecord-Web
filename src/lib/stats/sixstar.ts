/**
 * 6★ 分析（明日方舟叫出金，终末地叫出红）：抽数分布、歪不歪的概率分布、欧非走势。全部在本地精确计算。
 */
import { ruleLabel } from '../labels'
import type { SixStarHit } from './analyze'
import type { PullEvent } from './events'
import type { Distribution } from './pity'

// ───────────────────────── 出 6★ 的抽数分布 ─────────────────────────

export interface PityBins {
  labels: string[]
  /** 你的 6★ 落在各区间的个数 */
  actual: number[]
  /** 同样多的 6★ 在理论分布下各区间的期望个数；没有概率模型时为 null */
  expected: number[] | null
  /** 累计比例（0–1）：你的、理论的 */
  cdfActual: number[]
  cdfTheory: number[] | null
}

function cumulate(xs: number[], total: number): number[] {
  let acc = 0
  return xs.map((x) => (acc += x) / (total || 1))
}

export function binPity(intervals: number[], dist: Distribution | null, hardPity: number, bin = 5): PityBins {
  const count = Math.ceil(hardPity / bin)
  const index = (n: number) => Math.min(count - 1, Math.floor((n - 1) / bin))
  const actual = Array.from({ length: count }, () => 0)
  for (const n of intervals) actual[index(n)]!++
  const labels = Array.from({ length: count }, (_, i) => `${i * bin + 1}–${Math.min(hardPity, (i + 1) * bin)}`)
  let expected: number[] | null = null
  let cdfTheory: number[] | null = null
  if (dist) {
    const prob = Array.from({ length: count }, () => 0)
    dist.pmf.forEach((p, i) => (prob[index(i + 1)]! += p))
    expected = prob.map((p) => p * intervals.length)
    cdfTheory = cumulate(prob, 1)
  }
  return { labels, actual, expected, cdfActual: cumulate(actual, intervals.length), cdfTheory }
}

// ───────────────────────── 歪不歪 ─────────────────────────

/**
 * 一个 6★ 是当期 UP 的理论概率（docs/rewrite/research.md 1.8、2.3）；规则不明确时为 null。
 * 不计入 150 / 120 抽等定向保底，因此对抽得很深的卡池略微低估。
 */
export function theoreticalUpShare(e: PullEvent): number | null {
  if (e.weapon) return null
  if (e.family === 'ef:special' || e.family === 'ef:rerun') return 0.5
  switch (e.ruleType) {
    case 'SINGLE':
    case 'LINKAGE':
    case 'DOUBLE':
    case 'NORMAL':
    case 'CLASSIC':
    case 'CLASSIC_DOUBLE':
    case 'FESCLASSIC':
      return 0.5
    case 'LIMITED':
      return 0.7
    case 'SPECIAL':
      return 1
    default:
      return null
  }
}

export interface UpLuck {
  /** 参与统计的 6★（UP 名单已知、理论概率已知） */
  total: number
  wins: number
  expected: number
  /** pmf[k] = 理论上 total 个 6★ 中恰有 k 个 UP 的概率 */
  pmf: number[]
  /** 0–1，越大越“不歪”；样本为 0 时为 null */
  luck: number | null
  byType: { key: string; label: string; total: number; wins: number; share: number }[]
  longestOffStreak: number
  currentOffStreak: number
}

/** 各 6★ 的 UP 概率不同，UP 个数服从泊松二项分布，逐个卷积精确计算 */
export function analyzeUp(hits: SixStarHit[]): UpLuck {
  const samples = hits
    .map((h) => ({ e: h.event, p: theoreticalUpShare(h.event) }))
    .filter((x): x is { e: PullEvent; p: number } => x.p !== null && x.e.isUp !== null)

  let pmf = [1]
  for (const { p } of samples) {
    const next = Array.from({ length: pmf.length + 1 }, () => 0)
    pmf.forEach((q, k) => {
      next[k]! += q * (1 - p)
      next[k + 1]! += q * p
    })
    pmf = next
  }
  const wins = samples.filter((x) => x.e.isUp).length
  const below = pmf.slice(0, wins).reduce((a, b) => a + b, 0)

  const types = new Map<string, { key: string; label: string; total: number; wins: number; share: number }>()
  for (const { e, p } of samples) {
    const key = e.family.startsWith('ef:') ? e.family : e.ruleType
    const t = types.get(key) ?? { key, label: e.family.startsWith('ef:') ? e.familyLabel : ruleLabel(e.ruleType).label, total: 0, wins: 0, share: p }
    t.total++
    if (e.isUp) t.wins++
    types.set(key, t)
  }

  let longest = 0
  let current = 0
  for (const { e } of samples) {
    current = e.isUp ? 0 : current + 1
    longest = Math.max(longest, current)
  }

  return {
    total: samples.length,
    wins,
    expected: samples.reduce((a, x) => a + x.p, 0),
    pmf,
    luck: samples.length ? Math.min(1, below + (pmf[wins] ?? 0) / 2) : null,
    byType: [...types.values()].toSorted((a, b) => b.total - a.total),
    longestOffStreak: longest,
    currentOffStreak: current,
  }
}

// ───────────────────────── 欧非走势 ─────────────────────────

export interface TrendPoint {
  /** 第几抽（只计入适用主模型、计入保底的抽数） */
  pulls: number
  actual: number
  /** 按每一抽当时的垫抽，理论上应出的 6★ 个数（累计） */
  expected: number
}

/**
 * 由分布反推每一抽出 6★ 的概率：h(n) = P(T = n) / P(T ≥ n)。
 * P(T ≥ n) 从尾部往前累加：用 1 减去已出概率在抽数很深时会因精度丢失而严重失真。
 */
function hazards(dist: Distribution): number[] {
  const tail = Array.from({ length: dist.pmf.length + 1 }, () => 0)
  for (let i = dist.pmf.length - 1; i >= 0; i--) tail[i] = tail[i + 1]! + dist.pmf[i]!
  return dist.pmf.map((p, i) => (tail[i]! > 0 ? Math.min(1, p / tail[i]!) : 1))
}

/** topStar：最高星级（鹰角 6★，米哈游 5★） */
export function luckTrend(events: PullEvent[], dist: Distribution | null, maxPoints = 300, topStar = 6): TrendPoint[] {
  if (!dist) return []
  const h = hazards(dist)
  const counters = new Map<string, number>()
  const points: TrendPoint[] = []
  let pulls = 0
  let actual = 0
  let expected = 0
  for (const e of events) {
    if (!e.mainModel || !e.countsForPity) continue
    const count = counters.get(e.family) ?? 0
    expected += h[Math.min(count, h.length - 1)] ?? 1
    pulls++
    if (e.star === topStar) {
      actual++
      counters.set(e.family, 0)
    } else {
      counters.set(e.family, count + 1)
    }
    points.push({ pulls, actual, expected })
  }
  if (points.length <= maxPoints) return points
  const step = Math.ceil(points.length / maxPoints)
  return points.filter((_, i) => i % step === 0 || i === points.length - 1)
}
