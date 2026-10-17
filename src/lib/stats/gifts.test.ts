import { describe, expect, it } from 'vitest'
import type { EfMeta } from '../meta'
import type { EfPull } from '../types'
import { buildCodex, efCodexItems, summarizeCodex } from './codex'
import { normalizeEndfield } from './events'
import { endfieldGifts, inferTokens, TOKEN_EVERY } from './gifts'

const meta: EfMeta = {
  generatedAt: '',
  pools: {
    special_1_6_1: { n: '万物更新', t: 'special', up: ['chr_0036_jsspsi'] },
    rerun_chr_tangtang: { n: '祖泉的新流', t: 'rerun', up: ['chr_0027_tangtang'] },
    standard: { n: '基础寻访', t: 'standard', up: [] },
  },
  items: {
    chr_0036_jsspsi: { n: '祀', r: 6 },
    chr_0027_tangtang: { n: '汤汤', r: 6 },
    chr_0001_a: { n: '甲', r: 4 },
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

  it('武器池不推算；图鉴里抽到和赠送分开计数', () => {
    const list = [
      ...draws('special_1_6_1', TOKEN_EVERY),
      pull('special_1_6_1', { itemId: 'chr_0036_jsspsi', itemName: '祀', rarity: 6 }),
      ...draws('weponbox_1_0_1', 300, { type: 'weapon', poolType: 'normal' }),
    ]
    const gifts = endfieldGifts(list, new Map(), meta)
    expect(gifts).toHaveLength(1)
    const codex = buildCodex(efCodexItems(meta, false), normalizeEndfield(list, new Map(), meta).filter((e) => !e.weapon), gifts)
    const si = codex.find((c) => c.id === 'chr_0036_jsspsi')!
    expect([si.count, si.gifted, si.giftedInferred]).toEqual([1, 1, 1])
    // 只有赠送、没有抽到的也算拥有
    const onlyGift = buildCodex(efCodexItems(meta, false), [], gifts)
    expect(summarizeCodex(onlyGift).find((s) => s.star === 6)!.owned).toBe(1)
  })
})
