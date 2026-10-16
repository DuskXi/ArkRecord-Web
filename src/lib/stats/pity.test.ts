import { describe, expect, it } from 'vitest'
import { arknightsRate, distribution, endfieldRate, luckPercentile, quantile, remaining } from './pity'

describe('保底分布', () => {
  it('明日方舟：期望 34.59 抽、中位数 35、第 99 抽必出', () => {
    const d = distribution(arknightsRate)
    expect(d.mean).toBeCloseTo(34.59, 2)
    expect(d.median).toBe(35)
    expect(d.max).toBe(99)
    expect(d.pmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
  })

  it('终末地角色池：期望 53.90 抽、第 80 抽必出', () => {
    const d = distribution(endfieldRate)
    expect(d.mean).toBeCloseTo(53.9, 1)
    expect(d.max).toBe(80)
  })

  it('已垫抽数越多，剩余期望越少', () => {
    const d = distribution(arknightsRate)
    const after60 = remaining(d, 60)
    expect(after60.max).toBe(39)
    expect(after60.mean).toBeLessThan(d.mean)
    expect(quantile(after60.pmf, 1)).toBeLessThanOrEqual(39)
  })
})

describe('运气百分位', () => {
  const d = distribution(arknightsRate)

  it('没有样本时返回 null', () => {
    expect(luckPercentile(d, [])).toBeNull()
  })

  it('一抽出 6★ 非常欧，99 抽才出非常非', () => {
    expect(luckPercentile(d, [1])!).toBeGreaterThan(0.98)
    expect(luckPercentile(d, [99])!).toBeLessThan(0.01)
  })

  it('接近期望时约为 0.5', () => {
    const p = luckPercentile(d, [35, 34, 35, 35])!
    expect(p).toBeGreaterThan(0.4)
    expect(p).toBeLessThan(0.6)
  })

  it('大量样本时的正态近似与精确计算衔接平滑', () => {
    const exact = luckPercentile(d, Array(40).fill(33))!
    const approx = luckPercentile(d, Array(41).fill(33))!
    expect(Math.abs(exact - approx)).toBeLessThan(0.05)
  })
})
