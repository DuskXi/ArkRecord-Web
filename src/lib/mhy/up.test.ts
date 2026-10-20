/**
 * 米哈游的歪没歪、大小保底、总览卡片和规划预设。记录都是假的（名称用常驻 / 虚构的，时间随便取）。
 */
import { describe, expect, it } from 'vitest'
import { analyze } from '../stats/analyze'
import { plan } from '../stats/planner'
import { analyzeUp } from '../stats/sixstar'
import { upTag } from '../stats/up-tag'
import { normalizeMhy } from './events'
import { mhyModel } from './models'
import { mhyPlanner } from './planner'
import type { MhyPull } from './types'
import { classifyUp, guaranteeStates, mhyGuarantees } from './up'

let seq = 0
function pull(game: 'genshin' | 'starrail', pool: string, time: string, name: string, rank = 5, extra: Partial<MhyPull> = {}): MhyPull {
  seq++
  return {
    accountId: `${game}:1`,
    id: String(1_700_000_000_000_000_000n + BigInt(seq)),
    gachaType: pool,
    pool: pool === '400' ? '301' : pool,
    itemId: '',
    name,
    itemType: '角色',
    rank,
    count: 1,
    time,
    ts: Date.parse(`${time.replace(' ', 'T')}+08:00`),
    lang: 'zh-cn',
    source: 'api',
    ...extra,
  }
}

describe('按名称和时间判断是不是 UP', () => {
  it('常驻角色在角色活动池是歪；首次 UP 那一期之前是 UP；刻晴 2021 年那一期是 UP', () => {
    expect(classifyUp('genshin', 'character', { name: '迪卢克', time: '2025-01-01 12:00:00', lang: 'zh-cn' })).toBe('off')
    expect(classifyUp('genshin', 'character', { name: '提纳里', time: '2022-09-01 12:00:00', lang: 'zh-cn' })).toBe('up')
    expect(classifyUp('genshin', 'character', { name: '提纳里', time: '2022-09-10 12:00:00', lang: 'zh-cn' })).toBe('off')
    expect(classifyUp('genshin', 'character', { name: '刻晴', time: '2021-02-20 12:00:00', lang: 'zh-cn' })).toBe('up')
    expect(classifyUp('genshin', 'character', { name: '虚构角色', time: '2025-01-01 12:00:00', lang: 'zh-cn' })).toBe('up')
  })

  it('原神常驻武器当过 UP 的那几期是 UP，开始前一天内和核对日期之后看不出来', () => {
    expect(classifyUp('genshin', 'weapon', { name: '和璞鸢', time: '2024-03-01 12:00:00', lang: 'zh-cn' })).toBe('up')
    expect(classifyUp('genshin', 'weapon', { name: '和璞鸢', time: '2024-03-20 12:00:00', lang: 'zh-cn' })).toBe('off')
    expect(classifyUp('genshin', 'weapon', { name: '和璞鸢', time: '2024-02-20 06:00:00', lang: 'zh-cn' })).toBe('unsure')
    expect(classifyUp('genshin', 'weapon', { name: '和璞鸢', time: '2026-12-01 12:00:00', lang: 'zh-cn' })).toBe('unsure')
  })

  it('星铁自选的前限定角色：加入常驻保底池之前是 UP，之后看不出来；别的语言、别的卡池不判断', () => {
    expect(classifyUp('starrail', 'character', { name: '刃', time: '2024-06-01 12:00:00', lang: 'zh-cn' })).toBe('up')
    expect(classifyUp('starrail', 'character', { name: '刃', time: '2025-06-01 12:00:00', lang: 'zh-cn' })).toBe('unsure')
    expect(classifyUp('starrail', 'lightcone', { name: '时节不居', time: '2025-06-01 12:00:00', lang: 'zh-cn' })).toBe('off')
    expect(classifyUp('starrail', 'character', { name: 'Bailu', time: '2025-06-01 12:00:00', lang: 'en-us' })).toBeNull()
    expect(classifyUp('genshin', 'standard', { name: '迪卢克', time: '2025-06-01 12:00:00', lang: 'zh-cn' })).toBeNull()
  })
})

describe('大小保底', () => {
  it('第一个 UP 看不出大小保底；歪了之后是大保底；UP 之后是小保底；跨期继承', () => {
    const pulls = [
      pull('genshin', '301', '2025-01-01 10:00:00', '虚构甲'),
      pull('genshin', '301', '2025-01-02 10:00:00', '迪卢克'),
      pull('genshin', '400', '2025-01-03 10:00:00', '虚构乙'),
      pull('genshin', '301', '2025-02-03 10:00:00', '虚构丙'),
      pull('genshin', '301', '2025-02-04 10:00:00', '虚构丙', 4),
    ]
    const events = normalizeMhy('genshin', pulls)
    const tags = events.filter((e) => e.star === 5).map((e) => [e.isUp, e.guarantee, upTag(e)?.text])
    expect(tags).toEqual([
      [true, undefined, 'UP'],
      [false, 'small', '歪'],
      [true, 'big', '大保底'],
      [true, 'small', '不歪'],
    ])
    expect(events.at(-1)!.isUp).toBeNull()
    expect(guaranteeStates(events).get('genshin:character')).toBe('small')
  })

  it('一开始就歪：说明之前是小保底；看不出来的会让之后的状态变成未知', () => {
    const events = normalizeMhy('genshin', [
      pull('genshin', '302', '2026-06-01 10:00:00', '天空之翼'),
      pull('genshin', '302', '2026-12-01 10:00:00', '虚构武器'),
      pull('genshin', '302', '2026-12-02 10:00:00', '和璞鸢'),
    ])
    expect(events.map((e) => [e.isUp, e.guarantee])).toEqual([
      [false, 'small'],
      [true, 'big'],
      [null, 'small'],
    ])
    expect(guaranteeStates(events).get('genshin:weapon')).toBe('unknown')
    // 原神武器池的大保底：悬停说明提到定轨
    expect(upTag(events[1]!)!.title).toContain('定轨')
    expect(upTag({ isUp: true, guarantee: 'big', family: 'genshin:character' })!.title).not.toContain('定轨')
  })

  it('星铁：同一期里出过别的 UP，前限定角色就是歪的；大保底时一定是 UP', () => {
    const events = normalizeMhy('starrail', [
      pull('starrail', '11', '2025-06-01 10:00:00', '虚构星铁甲', 5, { gachaId: '2001' }),
      pull('starrail', '11', '2025-06-02 10:00:00', '刃', 5, { gachaId: '2001' }),
      pull('starrail', '11', '2025-07-01 10:00:00', '希儿', 5, { gachaId: '2002' }),
      pull('starrail', '11', '2025-08-01 10:00:00', '符玄', 5, { gachaId: '2003' }),
    ])
    expect(events.map((e) => [e.isUp, e.guarantee])).toEqual([
      [true, undefined],
      [false, 'small'],
      [true, 'big'],
      [null, 'small'],
    ])
  })

  it('UP 胜率只算小保底的；大保底不算运气', () => {
    const events = normalizeMhy('starrail', [
      pull('starrail', '11', '2025-06-01 10:00:00', '虚构一'),
      pull('starrail', '11', '2025-06-02 10:00:00', '姬子'),
      pull('starrail', '11', '2025-06-03 10:00:00', '虚构二'),
      pull('starrail', '11', '2025-06-04 10:00:00', '虚构三'),
    ])
    const analysis = analyze(events, mhyModel('starrail', 'char'))
    expect([analysis.upWins, analysis.upTotal]).toEqual([1, 2])
    const luck = analyzeUp(analysis.hits)
    expect([luck.total, luck.wins, luck.expected]).toEqual([2, 1, 1])
    expect(luck.byType[0]!.label).toBe('角色活动跃迁')
  })

  it('总览卡片：现在的大小保底和已垫抽数', () => {
    const pulls = [pull('genshin', '301', '2025-01-01 10:00:00', '琴'), pull('genshin', '301', '2025-01-01 10:01:00', '虚构', 4)]
    const events = normalizeMhy('genshin', pulls)
    const cards = mhyGuarantees('genshin', analyze(events, mhyModel('genshin', 'char')), events)
    expect(cards).toEqual([{ poolName: '角色活动祈愿', label: '大保底：下一个 5★ 必是 UP', current: 1, target: 90, done: false }])
  })
})

describe('米哈游的抽卡规划', () => {
  it('UP 角色：现在是大保底时，得到 UP 和出 5★ 一样', () => {
    const planner = mhyPlanner('genshin', 'char')!
    const up = planner.presets.find((p) => p.id === 'up')!
    const input = { rate: planner.rate, hardPity: 90, pity: 0, pulls: 90, upShare: up.upShare }
    const big = plan({ ...input, fallback: { guaranteed: true } })
    const small = plan({ ...input, fallback: { guaranteed: false } })
    expect(big.pTarget).toBeCloseTo(big.pSix, 12)
    expect(small.pTarget!).toBeLessThan(big.pTarget!)
    // 小保底时 180 抽必得 UP
    expect(plan({ ...input, pulls: 180, fallback: { guaranteed: false } }).pTarget).toBeCloseTo(1, 9)
  })

  it('预设：原神武器有“定轨的武器”，星铁光锥 75%', () => {
    expect(mhyPlanner('genshin', 'weapon')!.presets.map((p) => p.id)).toEqual(['any', 'up', 'path'])
    expect(mhyPlanner('starrail', 'weapon')!.presets.find((p) => p.id === 'up')!.upShare).toBe(0.75)
  })
})
