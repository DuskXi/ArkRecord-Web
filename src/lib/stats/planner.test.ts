import { describe, expect, it } from 'vitest'
import { arknightsRate, distribution, endfieldRate } from './pity'
import { plan } from './planner'

const AK = { rate: arknightsRate, hardPity: 99 }
const EF = { rate: endfieldRate, hardPity: 80 }

describe('抽卡规划', () => {
  it('至少一个 6★ 的概率与保底分布的累计概率一致', () => {
    const dist = distribution(arknightsRate)
    const r = plan({ ...AK, pity: 0, pulls: 60, upShare: 0 })
    const cdf = dist.pmf.slice(0, 60).reduce((a, b) => a + b, 0)
    expect(r.pSix).toBeCloseTo(cdf, 10)
    expect(r.pTarget).toBeNull()
  })

  it('硬保底：明日方舟 99 抽、终末地 80 抽必出 6★；垫满时下一抽必出', () => {
    expect(plan({ ...AK, pity: 0, pulls: 99, upShare: 0 }).pSix).toBeCloseTo(1, 12)
    expect(plan({ ...AK, pity: 0, pulls: 60, upShare: 0 }).pSix).toBeLessThan(1)
    expect(plan({ ...AK, pity: 98, pulls: 1, upShare: 0 }).pSix).toBeCloseTo(1, 12)
    expect(plan({ ...EF, pity: 0, pulls: 80, upShare: 0 }).pSix).toBeCloseTo(1, 12)
  })

  it('6★ 个数分布加起来为 1，期望约为 抽数 / 平均抽数', () => {
    const r = plan({ ...AK, pity: 0, pulls: 1000, upShare: 0 })
    expect(r.sixCountPmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 7)
    const mean = r.sixCountPmf.reduce((a, p, c) => a + p * c, 0)
    expect(mean).toBeCloseTo(r.expectedSix, 6)
    expect(r.expectedSix).toBeGreaterThan(1000 / 34.59 - 1)
    expect(r.expectedSix).toBeLessThan(1000 / 34.59 + 1)
  })

  it('UP 占 100% 且没有定向保底时，得到目标与出 6★ 的概率相同', () => {
    const r = plan({ ...AK, pity: 20, pulls: 70, upShare: 1 })
    expect(r.pTarget).toBeCloseTo(r.pSix, 12)
  })

  it('定向保底：单 UP 池第 150 抽必得，149 抽时还不一定', () => {
    const at150 = plan({ ...AK, pity: 0, pulls: 150, upShare: 0.5, spark: { at: 150, done: 0 } })
    const at149 = plan({ ...AK, pity: 0, pulls: 149, upShare: 0.5, spark: { at: 150, done: 0 } })
    expect(at150.pTarget).toBeCloseTo(1, 12)
    expect(at149.pTarget).toBeLessThan(1)
    // 本池已抽 100，再抽 50 就到 150
    expect(plan({ ...AK, pity: 0, pulls: 50, upShare: 0.5, spark: { at: 150, done: 100 } }).pTarget).toBeCloseTo(1, 12)
  })

  it('定向保底强制出的 6★ 计入 6★ 个数；累计赠送不计入', () => {
    const none = plan({ ...AK, pity: 0, pulls: 300, upShare: 0 })
    const forced = plan({ ...AK, pity: 0, pulls: 300, upShare: 0.5, spark: { at: 150, done: 0 } })
    const gift = plan({ ...AK, pity: 0, pulls: 300, upShare: 0.35, spark: { at: 300, done: 0, gift: true } })
    expect(forced.expectedSix).toBeGreaterThan(none.expectedSix)
    expect(gift.expectedSix).toBeCloseTo(none.expectedSix, 9)
    expect(gift.pTarget).toBeCloseTo(1, 12)
  })

  it('得到目标所需抽数的分位数随垫抽减少', () => {
    const fresh = plan({ ...EF, pity: 0, pulls: 1, upShare: 0.5, spark: { at: 120, done: 0 } })
    const deep = plan({ ...EF, pity: 70, pulls: 1, upShare: 0.5, spark: { at: 120, done: 70 } })
    expect(fresh.targetP90).toBe(120)
    expect(deep.targetMedian).not.toBeNull()
    expect(deep.targetMedian!).toBeLessThan(fresh.targetMedian!)
  })

  // 每抽必出最高星，方便直接核对大保底的规则
  const EVERY = { rate: () => 1, hardPity: 1, pity: 0 }

  it('大保底：歪了之后下一个最高星必是目标', () => {
    const one = plan({ ...EVERY, pulls: 1, upShare: 0.5, fallback: { guaranteed: false } })
    const two = plan({ ...EVERY, pulls: 2, upShare: 0.5, fallback: { guaranteed: false } })
    expect(one.pTarget).toBeCloseTo(0.5, 12)
    expect(two.pTarget).toBeCloseTo(1, 12)
    // 没有大保底时第二个仍是 50%
    expect(plan({ ...EVERY, pulls: 2, upShare: 0.5 }).pTarget).toBeCloseTo(0.75, 12)
    // 已经是大保底：下一个必是目标
    expect(plan({ ...EVERY, pulls: 1, upShare: 0.5, fallback: { guaranteed: true } }).pTarget).toBeCloseTo(1, 12)
  })

  it('原神定轨武器：小保底 37.5%，大保底时两把 UP 各一半，不是定轨的之后必是定轨的', () => {
    const small = plan({ ...EVERY, pulls: 1, upShare: 0.375, fallback: { guaranteed: false } })
    const big = plan({ ...EVERY, pulls: 1, upShare: 0.375, fallback: { guaranteed: true, guaranteedShare: 0.5 } })
    const bigTwo = plan({ ...EVERY, pulls: 2, upShare: 0.375, fallback: { guaranteed: true, guaranteedShare: 0.5 } })
    expect([small.pTarget, big.pTarget, bigTwo.pTarget].map((p) => Math.round(p! * 1e9) / 1e9)).toEqual([0.375, 0.5, 1])
  })

  it('大保底不改变出最高星的概率和个数', () => {
    const base = plan({ ...EF, pity: 10, pulls: 200, upShare: 0.5 })
    const withFallback = plan({ ...EF, pity: 10, pulls: 200, upShare: 0.5, fallback: { guaranteed: true } })
    expect(withFallback.pSix).toBeCloseTo(base.pSix, 12)
    expect(withFallback.expectedSix).toBeCloseTo(base.expectedSix, 9)
    expect(withFallback.sixCountPmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    expect(withFallback.pTarget!).toBeGreaterThan(base.pTarget!)
  })
})
