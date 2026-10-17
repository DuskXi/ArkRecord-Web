import { describe, expect, it } from 'vitest'
import type { AkMeta, EfMeta } from '../meta'
import type { AkPull, EfPull } from '../types'
import { buildCodex, efCodexItems, summarizeCodex } from './codex'
import { normalizeEndfield } from './events'
import { arknightsGifts, endfieldGifts, inferTokens, TOKEN_EVERY } from './gifts'

const meta: EfMeta = {
  generatedAt: '',
  pools: {
    special_1_6_1: { n: '万物更新', t: 'special', up: ['chr_0036_jsspsi'] },
    rerun_chr_tangtang: { n: '祖泉的新流', t: 'rerun', up: ['chr_0027_tangtang'] },
    standard: { n: '基础寻访', t: 'standard', up: [] },
    joint_1: { n: '辉光庆典', t: 'joint', up: ['chr_0016_laevat', 'chr_0013_aglina'] },
    weponbox_1_0_1: { n: '熔铸申领', t: 'weapon', up: ['wpn_sword_0006'] },
  },
  items: {
    chr_0036_jsspsi: { n: '祀', r: 6 },
    chr_0027_tangtang: { n: '汤汤', r: 6 },
    chr_0016_laevat: { n: '莱万汀', r: 6 },
    chr_0013_aglina: { n: '洁尔佩塔', r: 6 },
    chr_0001_a: { n: '甲', r: 4 },
    wpn_sword_0006: { n: '熔铸火焰', r: 6 },
    wpn_x: { n: '某武器', r: 4 },
  },
}

let seq = 0
function pull(poolId: string, extra: Partial<EfPull> = {}): EfPull {
  seq++
  const type = extra.type ?? 'char'
  return {
    accountId: 'endfield:1',
    key: `${type}:${poolId}:${seq}`,
    type,
    poolId,
    poolName: meta.pools[poolId]?.n ?? poolId,
    poolType: poolId.startsWith('special') ? 'E_CharacterGachaPoolType_Special' : poolId.startsWith('rerun') ? 'E_CharacterGachaPoolType_Rerun' : 'E_CharacterGachaPoolType_Standard',
    itemId: 'chr_0001_a',
    itemName: '甲',
    rarity: 4,
    isNew: false,
    isFree: false,
    kind: 'draw',
    gachaTs: 1_700_000_000_000 + seq * 1000,
    seqId: String(seq),
    source: 'api',
    ...extra,
  }
}
function draws(poolId: string, n: number, extra: Partial<EfPull> = {}): EfPull[] {
  return Array.from({ length: n }, () => pull(poolId, extra))
}

describe('终末地赠送条目', () => {
  it('赠送不进寻访事件，单独列出', () => {
    const list = [
      ...draws('special_1_6_1', 3),
      pull('special_1_6_1', { kind: 'gift_intel_book', itemId: '', itemName: '', rarity: 0 }),
      pull('special_1_6_1', { kind: 'gift_operator_token', itemId: 'chr_0036_jsspsi', itemName: '祀', rarity: 6 }),
    ]
    const events = normalizeEndfield(list, new Map(), meta)
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.star === 4)).toBe(true)

    const gifts = endfieldGifts(list, new Map(), meta)
    expect(gifts.map((g) => [g.label, g.copy, g.inferred])).toEqual([
      ['寻访情报书', false, false],
      ['信物赠礼', true, false],
    ])
    expect(gifts[1]).toMatchObject({ itemId: 'chr_0036_jsspsi', name: '祀', star: 6 })
  })

  it('特许寻访每累计 240 次推算一个当期 UP 信物，免费十连不计入', () => {
    const list = [...draws('special_1_6_1', 10, { isFree: true }), ...draws('special_1_6_1', 2 * TOKEN_EVERY + 5)]
    const inferred = inferTokens(list, new Map(), meta)
    expect(inferred.map((g) => g.at)).toEqual([240, 480])
    expect(inferred.every((g) => g.itemId === 'chr_0036_jsspsi' && g.inferred && g.copy)).toBe(true)
    // 推算的时间是第 240 次（不含免费十连）那一抽
    const paid = list.filter((p) => !p.isFree)
    expect(inferred[0]!.ts).toBe(paid[239]!.gachaTs)

    // 免费十连不够 240
    expect(inferTokens([...draws('special_1_6_1', 235), ...draws('special_1_6_1', 10, { isFree: true })], new Map(), meta)).toEqual([])
  })

  it('记录里已有的信物赠礼先算进去，只补缺少的（不会重复）', () => {
    const list = [
      ...draws('special_1_6_1', 2 * TOKEN_EVERY),
      pull('special_1_6_1', { kind: 'gift_operator_token', itemId: 'chr_0036_jsspsi', itemName: '祀', rarity: 6 }),
    ]
    const gifts = endfieldGifts(list, new Map(), meta)
    expect(gifts.filter((g) => !g.inferred)).toHaveLength(1)
    expect(gifts.filter((g) => g.inferred).map((g) => g.at)).toEqual([480])

    // 两个都有记录：不推算
    list.push(pull('special_1_6_1', { kind: 'gift_operator_token', itemId: 'chr_0036_jsspsi', itemName: '祀', rarity: 6 }))
    expect(endfieldGifts(list, new Map(), meta).filter((g) => g.inferred)).toEqual([])
  })

  it('特许寻访每期单独计数；重构寻访按同一卡池累计；基础寻访没有信物赠礼', () => {
    const list = [
      ...draws('special_1_6_1', 200),
      ...draws('special_other', 200, { poolType: 'E_CharacterGachaPoolType_Special' }),
      ...draws('rerun_chr_tangtang', 240),
      ...draws('standard', 500),
    ]
    const inferred = inferTokens(list, new Map(), meta)
    expect(inferred.map((g) => [g.poolId, g.name])).toEqual([['rerun_chr_tangtang', '汤汤']])
  })

  it('UP 未知时用官方接口的名字；都没有时不算作某个干员的一份', () => {
    const list = draws('special_new', TOKEN_EVERY, { poolType: 'E_CharacterGachaPoolType_Special' })
    const pools = new Map([['special_new', { poolId: 'special_new', poolName: '新卡池', poolType: 'special', gachaType: 'char' as const, up6Name: '祀', items: [], fetchedAt: 0 }]])
    expect(inferTokens(list, pools, meta)[0]).toMatchObject({ itemId: 'chr_0036_jsspsi', name: '祀', copy: true })
    expect(inferTokens(list, new Map(), meta)[0]).toMatchObject({ itemId: null, copy: false })
  })

  it('图鉴里抽到和赠送分开计数', async () => {
    const list = [...draws('special_1_6_1', TOKEN_EVERY), pull('special_1_6_1', { itemId: 'chr_0036_jsspsi', itemName: '祀', rarity: 6 })]
    const gifts = endfieldGifts(list, new Map(), meta)
    expect(gifts).toHaveLength(1)
    const codex = buildCodex(efCodexItems(meta, false), normalizeEndfield(list, new Map(), meta).filter((e) => !e.weapon), gifts)
    const si = codex.find((c) => c.id === 'chr_0036_jsspsi')!
    expect([si.count, si.gifted, si.giftedInferred]).toEqual([1, 1, 1])
    // 只有赠送、没有抽到的也算拥有
    const onlyGift = buildCodex(efCodexItems(meta, false), [], gifts)
    expect(summarizeCodex(onlyGift).find((s) => s.star === 6)!.owned).toBe(1)
  })

  it('接口的赠送条目没有干员 ID 和名字：按卡池的当期 UP 补上，计入图鉴；名字里提到的优先；辉光庆典（自选）不硬猜', () => {
    const noId = { itemId: '', itemName: '', rarity: 0 }
    const list = [
      pull('special_1_6_1', { kind: 'gift_operator_token', ...noId }),
      pull('rerun_chr_tangtang', { kind: 'gift_operator_token', ...noId }),
      pull('joint_1', { kind: 'gift_operator_token', poolType: 'E_CharacterGachaPoolType_Joint', ...noId }),
      pull('joint_1', { kind: 'gift_operator_token', poolType: 'E_CharacterGachaPoolType_Joint', ...noId, itemName: '莱万汀的信物' }),
      pull('weponbox_1_0_1', { type: 'weapon', kind: 'gift_weapon', poolType: 'normal', ...noId }),
      pull('weponbox_1_0_1', { type: 'weapon', kind: 'gift_weapon_box', poolType: 'normal', ...noId }),
    ]
    const gifts = endfieldGifts(list, new Map(), meta)
    expect(gifts.map((g) => [g.label, g.itemId, g.copy])).toEqual([
      ['信物赠礼', 'chr_0036_jsspsi', true],
      ['信物赠礼', 'chr_0027_tangtang', true],
      ['信物赠礼', null, false],
      ['信物赠礼', 'chr_0016_laevat', true],
      ['武器赠礼', 'wpn_sword_0006', true],
      ['武库赠礼', null, false],
    ])
    const codex = buildCodex(efCodexItems(meta, false), [], gifts.filter((g) => !g.weapon))
    expect(codex.find((c) => c.id === 'chr_0036_jsspsi')).toMatchObject({ gifted: 1, giftedInferred: 0 })
    expect(buildCodex(efCodexItems(meta, true), [], gifts.filter((g) => g.weapon)).find((c) => c.id === 'wpn_sword_0006')!.gifted).toBe(1)
  })

  it('武库申领（每次 10 把）：第 10 次送武库赠礼，第 18 次送 UP 武器，之后每 8 次交替；已有的先算进去', () => {
    const weapon = { type: 'weapon' as const, poolType: 'normal', itemId: 'wpn_x', itemName: '某武器', rarity: 4 }
    // 35 次申领：武库赠礼 10、26；UP 武器 18、34
    const list = draws('weponbox_1_0_1', 350, weapon)
    const gifts = endfieldGifts(list, new Map(), meta)
    expect(gifts.map((g) => [g.kind, g.at, g.itemId])).toEqual([
      ['gift_weapon_box', 10, null],
      ['gift_weapon', 18, 'wpn_sword_0006'],
      ['gift_weapon_box', 26, null],
      ['gift_weapon', 34, 'wpn_sword_0006'],
    ])
    expect(gifts.every((g) => g.inferred && g.weapon)).toBe(true)
    // 赠送时间是那次申领的最后一把
    expect(gifts[0]!.ts).toBe(list[99]!.gachaTs)
    // 记录里已有一把 UP 武器：只补第二把
    const withRecord = [...list, pull('weponbox_1_0_1', { ...weapon, kind: 'gift_weapon', itemId: '', itemName: '' })]
    expect(endfieldGifts(withRecord, new Map(), meta).filter((g) => g.kind === 'gift_weapon').map((g) => [g.inferred, g.at])).toEqual([
      [true, 34],
      [false, undefined],
    ])
  })
})

describe('明日方舟限定池的 300 抽赠送', () => {
  const ak: AkMeta = {
    version: '',
    generatedAt: '',
    upAvailable: true,
    chars: { char_2014_nian: { n: '年', r: 6, p: 'TANK' }, char_123_fang: { n: '芬', r: 3, p: 'PIONEER' } },
    pools: {
      LIMITED_16_0_1: { n: '地生五金', t: 'LIMITED', o: 0, e: 2e9, free: 300, lim: 'char_2014_nian', up: { '6': ['char_2014_nian', 'char_225_haak'] } },
      SINGLE_1: { n: '单 UP', t: 'SINGLE', o: 0, e: 2e9 },
    },
    avatars: [],
  }
  let n = 0
  const akPull = (poolId: string): AkPull => {
    n++
    return {
      accountId: 'arknights:1',
      key: `${poolId}:${n}`,
      poolId,
      poolName: ak.pools[poolId]!.n,
      charId: 'char_123_fang',
      charName: '芬',
      rarity: 2,
      isNew: false,
      gachaTs: 1_600_000_000_000 + Math.floor(n / 10) * 60_000,
      tsSec: 0,
      pos: n % 10,
      source: 'api',
    }
  }

  it('累计 300 抽推算赠送一名限定干员，计入图鉴；不够 300、不是限定池都没有', () => {
    const list = [...Array.from({ length: 310 }, () => akPull('LIMITED_16_0_1')), ...Array.from({ length: 400 }, () => akPull('SINGLE_1'))]
    const gifts = arknightsGifts(list, ak)
    expect(gifts).toHaveLength(1)
    expect(gifts[0]).toMatchObject({ kind: 'gift_limited', itemId: 'char_2014_nian', name: '年', star: 6, copy: true, inferred: true, at: 300 })
    expect(gifts[0]!.ts).toBe(list.toSorted((a, b) => a.gachaTs - b.gachaTs || a.pos - b.pos)[299]!.gachaTs)
    expect(arknightsGifts(list.slice(0, 299), ak)).toEqual([])
  })
})
