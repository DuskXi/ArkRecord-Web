/**
 * 米哈游接上统一的统计引擎：推算的保底曲线、记录 → 寻访事件、最高星级为 5★ 时的分析和高级统计。记录都是假的。
 */
import { describe, expect, it } from 'vitest'
import { analyze } from '../stats/analyze'
import { computeInsights } from '../stats/insights'
import { luckTrend } from '../stats/sixstar'
import { normalizeMhy } from './events'
import { deriveCurve, mhyModel, OFFICIAL_RATES } from './models'
import type { MhyPull } from './types'

const T0 = 1_760_000_000_000

function pull(pool: string, n: number, rank: number, extra: Partial<MhyPull> = {}): MhyPull {
  return {
    accountId: 'genshin:1',
    id: String(1_700_000_000_000_000_000n + BigInt(n)),
    gachaType: pool,
    pool: pool === '400' ? '301' : pool,
    itemId: '',
    name: `假物品${n}`,
    itemType: '角色',
    rank,
    count: 1,
    time: '',
    ts: T0 + Math.floor(n / 10) * 60_000,
    lang: 'zh-cn',
    source: 'api',
    ...extra,
  }
}

describe('按官方数字推算的保底曲线', () => {
  it('平均抽数对上官方综合概率；原神角色池从第 74 抽起上升', () => {
    const gi = deriveCurve(OFFICIAL_RATES.genshin.character!)!
    expect(gi.start).toBe(74)
    expect(gi.consolidated).toBeCloseTo(0.016, 3)
    expect(gi.dist.max).toBe(90)
    expect(deriveCurve(OFFICIAL_RATES.genshin.weapon!)!.consolidated).toBeCloseTo(0.0185, 3)
    expect(deriveCurve(OFFICIAL_RATES.starrail.lightcone!)!.consolidated).toBeCloseTo(0.0187, 3)
  })

  it('对不上官方综合概率时不建模型（例如星铁新手池的公示数字）', () => {
    expect(deriveCurve({ base: 0.006, consolidated: 0.0208, hardPity: 50 })).toBeNull()
  })

  it('页面用的模型：最高星级 5★、推算、没有软保底标记', () => {
    const char = mhyModel('genshin', 'char')
    expect(char).toMatchObject({ topStar: 5, derived: true, softPity: 90, hardPity: 90 })
    expect(char.dist!.mean).toBeCloseTo(62.4, 0)
    expect(mhyModel('genshin', 'weapon').hardPity).toBe(80)
    expect(mhyModel('starrail', 'weapon').hardPity).toBe(80)
  })
})

describe('记录 → 寻访事件', () => {
  it('301 和 400 共用一个保底分组；十连内按 id 排序；武器池标成 weapon', () => {
    const pulls = [pull('400', 2, 3), pull('301', 1, 3), pull('302', 30, 4, { itemType: '武器' }), pull('100', 40, 3)]
    const events = normalizeMhy('genshin', pulls)
    expect(events.map((e) => [e.key.slice(-2), e.family, e.order])).toEqual([
      ['01', 'genshin:character', 0],
      ['02', 'genshin:character', 1],
      ['30', 'genshin:weapon', 0],
      ['40', 'genshin:beginner', 0],
    ])
    expect(events.map((e) => e.weapon)).toEqual([false, false, true, false])
    // 新手池没有建模型，不参与运气
    expect(events.map((e) => e.mainModel)).toEqual([true, true, true, false])
    expect(events[0]).toMatchObject({ isUp: null, poolName: '角色活动祈愿', star: 3, itemId: null })
  })

  it('星铁按 gacha_id 区分每期卡池，联动池不参与运气', () => {
    const events = normalizeMhy('starrail', [
      pull('11', 1, 5, { gachaId: '2001' }),
      pull('21', 20, 4, { gachaId: '9001' }),
    ])
    expect(events.map((e) => [e.poolId, e.family, e.mainModel])).toEqual([
      ['2001', 'starrail:character', true],
      ['9001', 'starrail:collab-character', false],
    ])
  })
})

describe('最高星级为 5★ 时的分析', () => {
  // 角色池：第 10、20、30 抽是 5★（第 30 抽在 400 池里），其余 4★ / 3★
  const pulls = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1
    return pull(n === 30 ? '400' : '301', n, n % 10 === 0 ? 5 : n % 5 === 0 ? 4 : 3)
  })
  const events = normalizeMhy('genshin', pulls)
  const model = mhyModel('genshin', 'char')
  const analysis = analyze(events, model)

  it('5★ 是最高星级：保底计数、间隔都按 5★', () => {
    expect(analysis.topStar).toBe(5)
    expect(analysis.hits.map((h) => h.pity)).toEqual([10, 10, 10])
    expect(analysis.mainIntervals).toEqual([10, 10, 10])
    expect(analysis.stars).toMatchObject({ 3: 24, 4: 3, 5: 3, 6: 0 })
    expect(analysis.pity).toEqual([expect.objectContaining({ family: 'genshin:character', current: 0, hardPity: 90 })])
    expect(analysis.luck).not.toBeNull()
  })

  it('高级统计和运气走势也按 5★', () => {
    const insights = computeInsights(events, analysis)
    // 1–9 抽不满十连、30 抽是单抽：完整的十连只有两组，各出一个 5★
    expect(insights.tenByBest[5]).toBe(2)
    expect(luckTrend(events, model.dist, 300, 5).at(-1)?.actual).toBe(3)
  })

  it('鹰角两款不传最高星级时照旧按 6★', () => {
    expect(analyze(events, { dist: null, softPity: 50, hardPity: 99 }).hits).toEqual([])
  })
})
