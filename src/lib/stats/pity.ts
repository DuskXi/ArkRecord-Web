/**
 * 保底概率模型与精确分布计算（全部在本地完成）。
 *
 * rate(n)：距离上一个 6★ 的第 n 抽（n 从 1 开始）出 6★ 的概率。
 * 由此可以精确算出“出一个 6★ 需要多少抽”的分布 T：
 *   P(T = n) = rate(n) × ∏_{k<n} (1 − rate(k))
 */

export type RateFn = (n: number) => number

/** 明日方舟：基础 2%，连续 50 抽未出后每抽 +2%，第 99 抽必出 */
export const arknightsRate: RateFn = (n) => (n <= 50 ? 0.02 : Math.min(1, 0.02 + 0.02 * (n - 50)))

/** 终末地角色池：基础 0.8%，第 65 抽之后每抽 +5%，第 80 抽必出 */
export const endfieldRate: RateFn = (n) => (n >= 80 ? 1 : n <= 65 ? 0.008 : Math.min(1, 0.008 + 0.05 * (n - 65)))

export interface Distribution {
  /** pmf[i] = P(T = i + 1) */
  pmf: number[]
  mean: number
  variance: number
  median: number
  max: number
}

export function distribution(rate: RateFn, limit = 1000): Distribution {
  const pmf: number[] = []
  let survive = 1
  for (let n = 1; n <= limit && survive > 0; n++) {
    const p = Math.min(1, Math.max(0, rate(n)))
    pmf.push(survive * p)
    survive *= 1 - p
  }
  return summarize(pmf)
}

function summarize(pmf: number[]): Distribution {
  let mean = 0
  let second = 0
  pmf.forEach((p, i) => {
    mean += p * (i + 1)
    second += p * (i + 1) ** 2
  })
  return { pmf, mean, variance: second - mean ** 2, median: quantile(pmf, 0.5), max: pmf.length }
}

/** 最小的 n，使 P(T ≤ n) ≥ q */
export function quantile(pmf: number[], q: number): number {
  let acc = 0
  for (let i = 0; i < pmf.length; i++) {
    acc += pmf[i]!
    if (acc >= q - 1e-12) return i + 1
  }
  return pmf.length
}

/** 已经垫了 pulled 抽时，还需要多少抽的条件分布 */
export function remaining(dist: Distribution, pulled: number): Distribution {
  const tail = dist.pmf.slice(pulled)
  const total = tail.reduce((a, b) => a + b, 0)
  if (total <= 0) return summarize([1])
  return summarize(tail.map((p) => p / total))
}

const EXACT_LIMIT = 40

/**
 * 运气百分位：与“出了同样多个 6★ 的理论玩家”相比，用户花的总抽数比多少比例的玩家少。
 * 返回 0–1，越大越欧；0.5 表示正好符合期望。
 * samples 为每个 6★ 实际花费的抽数（不含尚未出货的当前垫抽）。
 */
export function luckPercentile(dist: Distribution, samples: number[]): number | null {
  const k = samples.length
  if (k === 0) return null
  const observed = samples.reduce((a, b) => a + b, 0)

  if (k <= EXACT_LIMIT) {
    let sum = [1] // 和为 0 的概率为 1
    for (let i = 0; i < k; i++) sum = convolve(sum, dist.pmf)
    // sum[j] = P(S = j + k)，因为每次 T ≥ 1
    let less = 0
    let equal = 0
    for (let j = 0; j < sum.length; j++) {
      const s = j + k
      if (s < observed) less += sum[j]!
      else if (s === observed) equal += sum[j]!
    }
    return clamp01(1 - less - equal / 2)
  }

  // 样本多时用中心极限定理近似。P(S < x) + ½P(S = x) 恰好对应连续性修正后的 Φ((x − μ)/σ)
  const mean = k * dist.mean
  const sd = Math.sqrt(k * dist.variance)
  return clamp01(1 - normalCdf((observed - mean) / sd))
}

function convolve(a: number[], b: number[]): number[] {
  const out = Array.from({ length: a.length + b.length - 1 }, () => 0)
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    if (ai < 1e-15) continue
    for (let j = 0; j < b.length; j++) out[i + j]! += ai * b[j]!
  }
  return out
}

function normalCdf(z: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}
