import { describe, expect, it } from 'vitest'
import { analyze } from './analyze'
import type { PullEvent } from './events'
import { computeInsights, groupBatches } from './insights'
import { arknightsRate, distribution } from './pity'

const MODEL = { dist: distribution(arknightsRate), softPity: 50, hardPity: 99 }
/** 2026-10-12（星期一）21:20 北京时间 */
const MONDAY_2120 = 1791811200000

let seq = 0
function ev(ts: number, star: number, name = `c${star}`, extra: Partial<PullEvent> = {}): PullEvent {
  seq++
  return {
    key: `k${seq}`,
    ts,
    order: seq,
    star,
    itemId: `char_${name}`,
    name,
    poolId: 'NORM_1',
    poolName: '标准',
    ruleType: 'NORMAL',
    family: 'standard',
    familyLabel: '标准寻访',
    isolated: false,
    mainModel: true,
    isNew: false,
    countsForPity: true,
    isUp: star === 6 ? false : null,
    weapon: false,
    ...extra,
  }
}

function ten(ts: number, stars: number[]): PullEvent[] {
  return stars.map((s) => ev(ts, s))
}

describe('十连分组', () => {
  it('同一时间、同一卡池的 10 条记录为一次十连，其余为单抽', () => {
    const events = [...ten(1000, [3, 3, 4, 3, 5, 3, 4, 3, 3, 4]), ev(2000, 4), ev(3000, 3, 'x', { poolId: 'NORM_2', poolName: '另一个' })]
    const batches = groupBatches(events)
    expect(batches.map((b) => b.kind)).toEqual(['ten', 'single', 'single'])
    expect(batches[0]!.events).toHaveLength(10)
  })

  it('统计十连的最高星级、双 6★ 十连与最好的一次十连', () => {
    const events = [
      ...ten(1000, [3, 3, 4, 3, 5, 3, 4, 3, 3, 4]),
      ...ten(2000, [6, 3, 4, 3, 6, 3, 5, 3, 3, 4]),
      ...ten(3000, [3, 3, 4, 3, 3, 3, 4, 3, 3, 4]),
    ]
    const s = computeInsights(events, analyze(events, MODEL))
    expect(s.tenPulls).toBe(3)
    expect(s.tenByBest).toEqual({ 3: 0, 4: 1, 5: 1, 6: 1 })
    expect(s.multiSixTens).toHaveLength(1)
    expect(s.bestTen?.ts).toBe(2000)
  })
})

describe('纪录与间隔', () => {
  it('5★ 及以上的平均间隔、最长间隔和当前间隔', () => {
    // 5★ 在第 3 抽、6★ 在第 10 抽（间隔 3、7），之后又抽了 4 抽
    const stars = [3, 3, 5, 3, 3, 3, 3, 3, 3, 6, 3, 3, 3, 3]
    const events = stars.map((s, i) => ev(10_000 + i * 1000, s))
    const s = computeInsights(events, analyze(events, MODEL))
    expect(s.fivePlus).toEqual({ count: 2, avgGap: 5, longestGap: 7, current: 4 })
  })

  it('最快、最慢、第一个 6★ 与按时间顺序的平均抽数', () => {
    const events = [
      ...Array.from({ length: 39 }, (_, i) => ev(100_000 + i, 3)),
      ev(200_000, 6, 'a'),
      ...Array.from({ length: 9 }, (_, i) => ev(300_000 + i, 3)),
      ev(400_000, 6, 'b'),
    ]
    const s = computeInsights(events, analyze(events, MODEL))
    expect(s.firstSix?.event.name).toBe('a')
    expect(s.fastestSix?.pity).toBe(10)
    expect(s.slowestSix?.pity).toBe(40)
    expect(s.sixSequence.map((x) => x.runningAvg)).toEqual([40, 25])
  })

  it('抽卡时段按北京时间统计（星期一为第一行）', () => {
    const events = ten(MONDAY_2120, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3])
    const s = computeInsights(events, analyze(events, MODEL))
    expect(s.hourWeek[0]![21]).toBe(10)
    expect(s.hourWeek.flat().reduce((a, b) => a + b, 0)).toBe(10)
    expect(s.busiestDay).toEqual({ day: '2026-10-12', pulls: 10, six: 0 })
  })

  it('收集：按干员合并 5★ 以上，记录次数与 UP 次数', () => {
    const events = [ev(1, 6, 'a', { isUp: true }), ev(2, 6, 'a', { isUp: false }), ev(3, 5, 'b'), ev(4, 4, 'c')]
    const s = computeInsights(events, analyze(events, MODEL))
    expect(s.collection.map((c) => [c.name, c.count, c.up])).toEqual([
      ['a', 2, 1],
      ['b', 1, 0],
    ])
  })
})
