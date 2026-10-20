/**
 * 记录的空档：很久没有记录时，空档前后的抽数不接着算，大小保底重新判断。记录都是假的。
 */
import { describe, expect, it } from 'vitest'
import { analyze } from '../stats/analyze'
import { listGaps } from '../stats/gaps'
import { computeInsights } from '../stats/insights'
import { upTag } from '../stats/up-tag'
import { normalizeMhy } from './events'
import { mhyModel } from './models'
import type { MhyGame, MhyPull } from './types'
import { guaranteeStates, mhyGuarantees } from './up'

let seq = 0
const DAY = 86_400_000

/** 从 start（北京时间）起每分钟一抽 */
function pulls(game: MhyGame, pool: string, start: string, names: string[]): MhyPull[] {
  const t0 = Date.parse(`${start.replace(' ', 'T')}+08:00`)
  return names.map((name, i) => {
    seq++
    const ts = t0 + i * 60_000
    return {
      accountId: `${game}:1`,
      id: String(1_700_000_000_000_000_000n + BigInt(seq)),
      gachaType: pool,
      pool,
      itemId: '',
      name,
      itemType: '角色',
      rank: name.endsWith('三星') ? 3 : 5,
      count: 1,
      time: new Date(ts + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
      ts,
      lang: 'zh-cn',
      source: 'api',
    }
  })
}

const threes = (n: number) => Array.from({ length: n }, () => '三星')

describe('记录的空档', () => {
  it('空档前每个保底分组的最后一条打上标记；空档后第一个 5★ 抽数未知、不算平均；大小保底重新判断', () => {
    const events = normalizeMhy('genshin', [
      // 2022 年：角色活动第 10 抽歪了（迪卢克），之后又抽 5 次；常驻抽 3 次
      ...pulls('genshin', '301', '2022-01-01 12:00:00', [...threes(9), '迪卢克', ...threes(5)]),
      ...pulls('genshin', '200', '2022-01-02 12:00:00', threes(3)),
      // 约 500 天后：角色活动 20 抽后出了 UP，再 11 抽歪了
      ...pulls('genshin', '301', '2023-05-17 12:00:00', [...threes(19), '虚构角色', ...threes(10), '迪卢克']),
    ])
    expect(listGaps(events).map((g) => g.days)).toEqual([500])
    // 角色活动、常驻空档前的最后一条各一个标记
    expect(events.filter((e) => e.gapAfter !== undefined).map((e) => [e.family, e.name])).toEqual([
      ['genshin:character', '三星'],
      ['genshin:standard', '三星'],
    ])

    const a = analyze(events, mhyModel('genshin', 'char'))
    expect(a.hits.map((h) => [h.event.name, h.pity, h.afterGap ?? false])).toEqual([
      ['迪卢克', 10, false],
      // 记录里有的是空档前垫的 5 抽加空档后的 20 抽，空档里可能还有：抽数未知，25 只是下限
      ['虚构角色', 25, true],
      ['迪卢克', 11, false],
    ])
    expect(a.mainIntervals).toEqual([10, 11])
    // 空档前歪过，但空档后看不出来是不是大保底：只标 UP，不标“大保底”
    const up = a.hits[1]!.event
    expect(up.guarantee).toBeUndefined()
    expect(upTag(up)?.text).toBe('UP')
    // 第二个迪卢克在 UP 之后，是小保底歪的
    expect(a.hits[2]!.event.guarantee).toBe('small')
    // 常驻空档后没再抽：现在的垫抽只是至少这么多
    expect(a.pity.find((p) => p.family === 'genshin:standard')).toMatchObject({ current: 3, afterGap: true })
    expect(a.pity.find((p) => p.family === 'genshin:character')!.afterGap).toBeUndefined()

    // 最快 / 最慢不算抽数未知的；累计平均也不算
    const insights = computeInsights(events, a)
    expect([insights.fastestSix?.pity, insights.slowestSix?.pity]).toEqual([10, 11])
    expect(insights.sixSequence.map((s) => s.runningAvg)).toEqual([10, 10, 10.5])
  })

  it('歪了之后有空档、空档后还没出 5★：大小保底看不出来，垫抽标“至少”', () => {
    const events = normalizeMhy('genshin', [
      ...pulls('genshin', '301', '2022-01-01 12:00:00', [...threes(9), '迪卢克']),
      ...pulls('genshin', '301', '2023-06-01 12:00:00', threes(4)),
    ])
    expect(guaranteeStates(events).get('genshin:character')).toBe('unknown')
    const a = analyze(events, mhyModel('genshin', 'char'))
    expect(a.pity[0]).toMatchObject({ current: 4, afterGap: true })
    const [card] = mhyGuarantees('genshin', a, events)
    expect(card).toMatchObject({ label: '大小保底看不出来（有空档）', current: 4, atLeast: true })
    expect(card!.hint).toContain('至少垫了 4 抽')
  })

  it('间隔不到保留时长不算空档；星铁按 180 天，原神按 365 天', () => {
    const gi = normalizeMhy('genshin', [...pulls('genshin', '301', '2022-01-01 12:00:00', threes(3)), ...pulls('genshin', '301', '2022-07-20 12:00:00', threes(3))])
    expect(listGaps(gi)).toEqual([])
    const sr = normalizeMhy('starrail', [...pulls('starrail', '11', '2024-01-01 12:00:00', threes(3)), ...pulls('starrail', '11', '2024-07-20 12:00:00', threes(3))])
    const gaps = listGaps(sr)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.to - gaps[0]!.from).toBeGreaterThan(180 * DAY)
  })

  it('没有空档时和以前一样：歪了之后的下一个是大保底', () => {
    const events = normalizeMhy('genshin', pulls('genshin', '301', '2022-01-01 12:00:00', [...threes(9), '迪卢克', ...threes(4), '虚构角色']))
    expect(events.some((e) => e.gapAfter !== undefined)).toBe(false)
    const a = analyze(events, mhyModel('genshin', 'char'))
    expect(a.hits.map((h) => [h.pity, h.afterGap ?? false, h.event.guarantee])).toEqual([
      [10, false, 'small'],
      [5, false, 'big'],
    ])
  })
})
