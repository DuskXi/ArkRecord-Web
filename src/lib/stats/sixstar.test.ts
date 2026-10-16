import { describe, expect, it } from 'vitest'
import type { SixStarHit } from './analyze'
import type { PullEvent } from './events'
import { arknightsRate, distribution } from './pity'
import { analyzeUp, binPity, luckTrend, theoreticalUpShare } from './sixstar'

const DIST = distribution(arknightsRate)

function ev(star: number, extra: Partial<PullEvent> = {}): PullEvent {
  return {
    key: Math.random().toString(36),
    ts: 0,
    order: 0,
    star,
    itemId: null,
    name: 'x',
    poolId: 'SINGLE_1',
    poolName: '单 UP',
    ruleType: 'SINGLE',
    family: 'standard',
    familyLabel: '标准寻访',
    isolated: false,
    mainModel: true,
    isNew: false,
    countsForPity: true,
    isUp: star === 6 ? true : null,
    weapon: false,
    ...extra,
  }
}

const hit = (e: PullEvent, pity = 30): SixStarHit => ({ event: e, pity, poolPull: pity })

describe('出红抽数分布', () => {
  it('按区间统计你的 6★，理论期望个数之和等于 6★ 个数', () => {
    const bins = binPity([1, 5, 6, 60, 99], DIST, 99, 5)
    expect(bins.labels[0]).toBe('1–5')
    expect(bins.labels.at(-1)).toBe('96–99')
    expect(bins.actual.slice(0, 2)).toEqual([2, 1])
    expect(bins.actual.at(-1)).toBe(1)
    expect(bins.expected!.reduce((a, b) => a + b, 0)).toBeCloseTo(5, 9)
    expect(bins.cdfActual.at(-1)).toBeCloseTo(1, 12)
    expect(bins.cdfTheory!.at(-1)).toBeCloseTo(1, 9)
  })

  it('没有概率模型时只给出你的分布', () => {
    const bins = binPity([10, 40], null, 40, 5)
    expect(bins.expected).toBeNull()
    expect(bins.cdfTheory).toBeNull()
    expect(bins.actual.reduce((a, b) => a + b, 0)).toBe(2)
  })
})

describe('歪不歪', () => {
  it('各类卡池的理论 UP 概率', () => {
    expect(theoreticalUpShare(ev(6, { ruleType: 'LIMITED' }))).toBe(0.7)
    expect(theoreticalUpShare(ev(6, { ruleType: 'CLASSIC' }))).toBe(0.5)
    expect(theoreticalUpShare(ev(6, { ruleType: 'E_CharacterGachaPoolType_Special', family: 'ef:special' }))).toBe(0.5)
    expect(theoreticalUpShare(ev(6, { weapon: true }))).toBeNull()
    expect(theoreticalUpShare(ev(6, { ruleType: 'ATTAIN' }))).toBeNull()
  })

  it('UP 个数服从泊松二项分布；只统计 UP 名单已知的 6★', () => {
    const hits = [
      hit(ev(6, { isUp: true })),
      hit(ev(6, { isUp: false })),
      hit(ev(6, { isUp: true, ruleType: 'LIMITED' })),
      hit(ev(6, { isUp: null })),
    ]
    const r = analyzeUp(hits)
    expect(r.total).toBe(3)
    expect(r.wins).toBe(2)
    expect(r.expected).toBeCloseTo(1.7, 12)
    // P(k) for p = 0.5, 0.5, 0.7
    expect(r.pmf.map((x) => Number(x.toFixed(4)))).toEqual([0.075, 0.325, 0.425, 0.175])
    // P(X < 2) + P(X = 2) / 2
    expect(r.luck).toBeCloseTo(0.075 + 0.325 + 0.425 / 2, 9)
    expect(r.byType.map((t) => [t.label, t.total, t.wins])).toEqual([
      ['单 UP', 2, 1],
      ['限定', 1, 1],
    ])
  })

  it('最长连歪与当前连歪', () => {
    const seq = [true, false, false, false, true, false, false].map((up) => hit(ev(6, { isUp: up })))
    const r = analyzeUp(seq)
    expect([r.longestOffStreak, r.currentOffStreak]).toEqual([3, 2])
  })
})

describe('欧非走势', () => {
  it('理论累计 6★ 等于每一抽当时出红概率之和；第 99 抽必出', () => {
    const events = [...Array.from({ length: 98 }, () => ev(3)), ev(6)]
    const points = luckTrend(events, DIST)
    expect(points).toHaveLength(99)
    expect(points.at(-1)!.actual).toBe(1)
    // 从 0 垫抽连抽 99 抽，理论上恰好出 1 个 6★ 的期望值 = 各抽 hazard 之和
    let survive = 1
    let sum = 0
    for (let n = 1; n <= 99; n++) {
      const r = arknightsRate(n)
      sum += r
      survive *= 1 - r
    }
    expect(points.at(-1)!.expected).toBeCloseTo(sum, 9)
    expect(survive).toBeCloseTo(0, 12)
  })

  it('点数过多时抽样，保留最后一点', () => {
    const events = Array.from({ length: 1000 }, (_, i) => ev(i % 40 === 39 ? 6 : 3))
    const points = luckTrend(events, DIST, 100)
    expect(points.length).toBeLessThanOrEqual(101)
    expect(points.at(-1)!.pulls).toBe(1000)
    expect(luckTrend(events, null)).toEqual([])
  })
})
