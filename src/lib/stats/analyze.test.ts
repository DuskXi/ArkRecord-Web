import { describe, expect, it } from 'vitest'
import type { AkMeta, EfMeta } from '../meta'
import type { AkPull, EfPoolInfo, EfPull } from '../types'
import { analyze } from './analyze'
import { normalizeArknights, normalizeEndfield } from './events'
import { arknightsGuarantees } from './guarantees'
import { arknightsRate, distribution, endfieldRate } from './pity'

const DAY = 86_400

const meta: AkMeta = {
  version: 'test',
  generatedAt: '',
  upAvailable: true,
  chars: {},
  avatars: [],
  pools: {
    NORM_1_0_1: { n: '标准一', t: 'NORMAL', o: 0, e: 10 * DAY, up: { '6': ['char_up_a', 'char_up_b'] } },
    SINGLE_2_0_1: { n: '单 UP', t: 'SINGLE', o: 10 * DAY, e: 4e9, up: { '6': ['char_up_c'] } },
    CLASSIC_3_0_1: { n: '中坚', t: 'CLASSIC', o: 0, e: 4e9 },
    LIMITED_4_0_1: { n: '限定', t: 'LIMITED', o: 0, e: 4e9, free: 300, up: { '6': ['char_lim'] } },
    LINKAGE_5_0_1: { n: '联动', t: 'LINKAGE', o: 0, e: 4e9, loop6: 120, up: { '6': ['char_link'] } },
  },
}

let seq = 0
function ak(poolId: string, charId: string, star: number, day: number): AkPull {
  seq++
  const gachaTs = day * DAY * 1000 + seq
  return {
    accountId: 'a',
    key: `${poolId}:${charId}:${gachaTs}:0`,
    poolId,
    poolName: meta.pools[poolId]?.n ?? poolId,
    charId,
    charName: charId,
    rarity: star - 1,
    isNew: false,
    gachaTs,
    tsSec: Math.floor(gachaTs / 1000),
    pos: 0,
    source: 'api',
  }
}

function many(poolId: string, count: number, day: number): AkPull[] {
  return Array.from({ length: count }, () => ak(poolId, 'char_3', 3, day))
}

describe('明日方舟保底分组', () => {
  const model = { dist: distribution(arknightsRate), softPity: 50, hardPity: 99 }

  it('标准寻访各卡池共享计数，中坚和限定各自独立', () => {
    const pulls = [
      ...many('NORM_1_0_1', 30, 1),
      ...many('CLASSIC_3_0_1', 5, 2),
      ...many('LIMITED_4_0_1', 7, 3),
      ...many('SINGLE_2_0_1', 20, 11),
      ak('SINGLE_2_0_1', 'char_up_c', 6, 11),
    ]
    const result = analyze(normalizeArknights(pulls, meta), model)
    expect(result.hits).toHaveLength(1)
    // 30（标准一）+ 20 + 1（单 UP）共享标准计数
    expect(result.hits[0]!.pity).toBe(51)
    expect(result.hits[0]!.event.isUp).toBe(true)
    const state = Object.fromEntries(result.pity.map((p) => [p.family, p.current]))
    expect(state.standard).toBe(0)
    expect(state.kernel).toBe(5)
    expect(state['pool:LIMITED_4_0_1']).toBe(7)
  })

  it('UP 胜率只统计已知 UP 名单的卡池', () => {
    const pulls = [ak('NORM_1_0_1', 'char_other', 6, 1), ak('NORM_1_0_1', 'char_up_a', 6, 1), ak('CLASSIC_3_0_1', 'char_x', 6, 2)]
    const result = analyze(normalizeArknights(pulls, meta), model)
    expect(result.upTotal).toBe(2)
    expect(result.upWins).toBe(1)
  })

  it('定向保底与限定 300 抽进度', () => {
    const pulls = [
      ...many('SINGLE_2_0_1', 80, 11),
      ...many('LIMITED_4_0_1', 120, 12),
      ...many('LINKAGE_5_0_1', 50, 12),
      ak('LINKAGE_5_0_1', 'char_link', 6, 12),
      ...many('LINKAGE_5_0_1', 9, 12),
    ]
    const result = analyze(normalizeArknights(pulls, meta), model)
    const g = arknightsGuarantees(result, meta, 20 * DAY * 1000)
    expect(g.find((x) => x.poolName === '单 UP')).toMatchObject({ current: 80, target: 150, done: false })
    expect(g.find((x) => x.poolName === '限定')).toMatchObject({ current: 120, target: 300 })
    // 循环保底：自上次得到联动干员后又抽了 9 次
    expect(g.find((x) => x.poolName === '联动')).toMatchObject({ current: 9, target: 120 })
  })

  it('旧版数据只有卡池名时按名称归类', () => {
    const legacy: AkPull = { ...ak('NORM_1_0_1', 'char_3', 3, 1), poolId: null, poolName: '中坚寻访' }
    const [event] = normalizeArknights([legacy], meta)
    expect(event!.family).toBe('kernel')
  })
})

function ef(poolId: string, name: string, star: number, n: number, extra: Partial<EfPull> = {}): EfPull {
  return {
    accountId: 'e',
    key: `char:${poolId}:${n}`,
    type: 'char',
    poolId,
    poolName: poolId,
    poolType: poolId.startsWith('special') ? 'E_CharacterGachaPoolType_Special' : 'E_CharacterGachaPoolType_Standard',
    itemId: name,
    itemName: name,
    rarity: star,
    isNew: false,
    isFree: false,
    kind: 'draw',
    gachaTs: 1_790_000_000_000 + n * 1000,
    seqId: String(n),
    source: 'api',
    ...extra,
  }
}

describe('终末地', () => {
  const model = { dist: distribution(endfieldRate), softPity: 65, hardPity: 80 }



  it('免费十连和赠送条目不计入保底；特许寻访之间共享计数', () => {
    const pulls: EfPull[] = []
    let s = 0
    for (let i = 0; i < 10; i++) pulls.push(ef('special_1_0_1', '甲', 4, ++s, { isFree: true }))
    for (let i = 0; i < 30; i++) pulls.push(ef('special_1_0_1', '甲', 4, ++s))
    pulls.push(ef('special_1_0_1', '赠品', 5, ++s, { kind: 'gift_intel_book' }))
    for (let i = 0; i < 20; i++) pulls.push(ef('special_1_0_2', '乙', 4, ++s))
    pulls.push(ef('special_1_0_2', '莱万汀', 6, ++s))
    const pools = new Map<string, EfPoolInfo>([
      ['special_1_0_2', { poolId: 'special_1_0_2', poolName: '', poolType: 'special', gachaType: 'char', up6Name: '莱万汀', items: [], fetchedAt: 0 }],
    ])
    const result = analyze(normalizeEndfield(pulls, pools), model)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.pity).toBe(51)
    expect(result.hits[0]!.event.isUp).toBe(true)
  })

  it('旧卡池（官方接口已下线）按游戏数据表的 UP 名单判断；辉光庆典单独计数且不参与运气评估', () => {
    const efMeta: EfMeta = {
      generatedAt: '',
      items: {},
      pools: {
        special_1_0_1: { n: '熔火灼痕', t: 'special', up: ['chr_0016_laevat'] },
        joint_1_2_2: { n: '辉光庆典', t: 'joint', up: ['chr_0016_laevat', 'chr_0013_aglina'] },
      },
    }
    const pulls = [
      ef('special_1_0_1', '莱万汀', 6, 1, { itemId: 'chr_0016_laevat' }),
      ef('special_1_0_1', '骏卫', 6, 2, { itemId: 'chr_0029_pograni' }),
      ef('joint_1_2_2', '洁尔佩塔', 6, 3, { itemId: 'chr_0013_aglina', poolName: '辉光庆典', poolType: 'E_CharacterGachaPoolType_Joint' }),
    ]
    const events = normalizeEndfield(pulls, new Map(), efMeta)
    expect(events.map((e) => e.isUp)).toEqual([true, false, true])
    expect(events[2]).toMatchObject({ family: 'ef:pool:joint_1_2_2', familyLabel: '辉光庆典', isolated: true, mainModel: false })
    // 没有元数据、官方接口也查不到时，UP 未知
    expect(normalizeEndfield(pulls.slice(0, 1), new Map()).map((e) => e.isUp)).toEqual([null])
  })
})
