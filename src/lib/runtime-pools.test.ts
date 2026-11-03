/**
 * 运行时补上新卡池的 UP 名单：PRTS 卡池表的解析（和构建脚本共用）、什么时候去取、怎么合进卡池数据。
 * 卡池表是按 PRTS 的格式手写的小样本。
 */
import { describe, expect, it, vi } from 'vitest'
import { extractUpLists, inferRuleType, limitedChars, poolIds } from '../../shared/ak-pools.js'
import type { AkMeta } from './meta'
import { applyRuntimePools, GIVE_UP_MS, needsFetch, REFRESH_MS, RUNTIME_POOLS_URL, type RuntimePools, wantedPools, withRuntimePools } from './runtime-pools'
import { normalizeArknights } from './stats/events'
import type { AkPull } from './types'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 3)

/** PRTS 服务器侧卡池表的格式：只有卡池 ID 和卡池详情 */
function prtsPool(id: string, up: Record<number, string[]>, limited?: string) {
  return {
    gachaPoolId: id,
    gachaPoolDetail: {
      detailInfo: {
        upCharInfo: { perCharList: Object.entries(up).map(([star, ids]) => ({ rarityRank: Number(star) - 1, charIdList: ids, percent: 0.5, count: ids.length })) },
        ...(limited ? { limitedChar: [limited] } : {}),
      },
    },
  }
}

const TABLE = {
  gachaPoolClient: [
    prtsPool('LIMITED_79_0_1', { 6: ['char_9001_newa', 'char_9002_newb'], 5: ['char_9003_newc'] }, 'char_9001_newa'),
    prtsPool('SINGLE_78_0_1', { 6: ['char_4231_clemnt'] }),
    { gachaPoolId: 'BOOT_0_1_1', gachaPoolDetail: { detailInfo: {} } },
    // 格式不对的条目：跳过
    { gachaPoolId: '../x', gachaPoolDetail: {} },
    prtsPool('DOUBLE_1_0_1', { 6: ['<script>', 'char_1_ok'] }),
    null,
  ],
}

function meta(pools: AkMeta['pools'] = {}): AkMeta {
  return { version: 'v', generatedAt: '', upAvailable: true, chars: {}, pools, avatars: [] }
}

const BUILT = meta({
  SINGLE_78_0_1: { n: '海渊巡游', t: 'SINGLE', o: NOW / 1000 - 20 * 86400, e: NOW / 1000 + 86400, up: { '6': ['char_4231_clemnt'] } },
  NORM_4_0_4: { n: '联合行动 · 2019-11-01', t: 'NORMAL', o: 1572566400, e: 1573776000 },
  // 构建时游戏数据里已经有、PRTS 还没给 UP 名单的新卡池
  LIMITED_79_0_1: { n: '将雪投火', t: 'LIMITED', o: NOW / 1000 - 2 * 86400, e: NOW / 1000 + 12 * 86400 },
})

describe('PRTS 卡池表的解析（构建脚本和网页共用）', () => {
  it('取出 UP 名单（星级从 1 起）和限定干员，格式不对的跳过', () => {
    expect(extractUpLists(TABLE)).toEqual({
      LIMITED_79_0_1: { 6: ['char_9001_newa', 'char_9002_newb'], 5: ['char_9003_newc'] },
      SINGLE_78_0_1: { 6: ['char_4231_clemnt'] },
      DOUBLE_1_0_1: { 6: ['char_1_ok'] },
    })
    expect(limitedChars(TABLE)).toEqual({ LIMITED_79_0_1: 'char_9001_newa' })
    expect(poolIds(TABLE)).toEqual(['LIMITED_79_0_1', 'SINGLE_78_0_1', 'BOOT_0_1_1', 'DOUBLE_1_0_1'])
    expect(extractUpLists(null)).toEqual({})
    expect(extractUpLists({ gachaPoolClient: 'x' })).toEqual({})
  })

  it('按 poolId 前缀推断卡池类型', () => {
    expect(['LIMITED_79_0_1', 'NORM_4_0_4', 'CLASSIC_DOUBLE_78_0_1', 'CLASSIC_ATTAIN_1', 'BOOT_0_1_1'].map(inferRuleType)).toEqual([
      'LIMITED',
      'NORMAL',
      'CLASSIC_DOUBLE',
      'CLASSIC_ATTAIN',
      'BOOT',
    ])
  })
})

describe('哪些卡池要补', () => {
  it('构建数据里没有、或近期开放却没有 UP 名单的；本来就没有 UP 的类型、很早以前的卡池不补', () => {
    const ids = ['LIMITED_79_0_1', 'LINKAGE_80_0_1', 'SINGLE_78_0_1', 'NORM_4_0_4', 'BOOT_0_1_1', 'FESCLASSIC_9_0_1', '', null, 'bad id']
    expect(wantedPools(BUILT, ids, NOW)).toEqual(['LIMITED_79_0_1', 'LINKAGE_80_0_1'])
  })

  it('没有存过就取；存过的结果里还缺卡池时，隔 6 小时再取；PRTS 一直没有满 7 天就不再取', () => {
    expect(needsFetch(null, ['LIMITED_79_0_1'], NOW)).toBe(true)
    const cache: RuntimePools = { fetchedAt: NOW - 1000, ups: { LIMITED_79_0_1: { 6: ['char_9001_newa'] } }, lims: {}, missingSince: { LINKAGE_80_0_1: NOW - 1000 } }
    expect(needsFetch(cache, ['LIMITED_79_0_1'], NOW)).toBe(false)
    expect(needsFetch(cache, ['LINKAGE_80_0_1'], NOW)).toBe(false)
    expect(needsFetch(cache, ['LINKAGE_80_0_1'], NOW + REFRESH_MS)).toBe(true)
    expect(needsFetch(cache, ['LINKAGE_80_0_1'], NOW - 1000 + GIVE_UP_MS + REFRESH_MS)).toBe(false)
  })
})

describe('合进卡池数据', () => {
  it('给已有的卡池补上 UP 名单和限定干员；构建数据里没有的卡池按前缀推断类型；不改原来的对象', () => {
    const cache: RuntimePools = {
      fetchedAt: NOW,
      ups: extractUpLists(TABLE),
      lims: limitedChars(TABLE),
      missingSince: {},
    }
    const merged = applyRuntimePools(meta(), cache, ['LIMITED_79_0_1'])
    expect(merged.pools.LIMITED_79_0_1).toEqual({ n: '', t: 'LIMITED', o: 0, e: 0, up: { 6: ['char_9001_newa', 'char_9002_newb'], 5: ['char_9003_newc'] }, lim: 'char_9001_newa' })
    const fromBuilt = applyRuntimePools(BUILT, cache, ['LIMITED_79_0_1'])
    expect(fromBuilt.pools.LIMITED_79_0_1).toMatchObject({ n: '将雪投火', t: 'LIMITED', lim: 'char_9001_newa' })
    expect(BUILT.pools.LIMITED_79_0_1!.up).toBeUndefined()
    // 没有可补的：原样返回
    expect(applyRuntimePools(BUILT, cache, ['LINKAGE_80_0_1'])).toBe(BUILT)
  })

  it('补上之后，新卡池里的 6★ 能判断是不是 UP', () => {
    const pull = (i: number, charId: string, rarity: number): AkPull => ({
      accountId: 'arknights:1',
      key: `p:${i}`,
      poolId: 'LIMITED_79_0_1',
      poolName: '将雪投火',
      charId,
      charName: charId,
      rarity,
      isNew: false,
      gachaTs: NOW - i * 60_000,
      tsSec: Math.floor((NOW - i * 60_000) / 1000),
      pos: 0,
      source: 'api',
    })
    const pulls = [pull(1, 'char_9001_newa', 5), pull(2, 'char_9002_newb', 5), pull(3, 'char_002_amiya', 5)]
    const before = normalizeArknights(pulls, BUILT).filter((e) => e.star === 6)
    expect(before.map((e) => e.isUp)).toEqual([null, null, null])
    const cache: RuntimePools = { fetchedAt: NOW, ups: extractUpLists(TABLE), lims: limitedChars(TABLE), missingSince: {} }
    const after = normalizeArknights(pulls, applyRuntimePools(BUILT, cache, ['LIMITED_79_0_1'])).filter((e) => e.star === 6)
    expect(after.map((e) => [e.itemId, e.isUp])).toEqual([
      ['char_002_amiya', false],
      ['char_9002_newb', true],
      ['char_9001_newa', true],
    ])
  })
})

/** 运行时取卡池表用的依赖：假的 fetch 和存储 */
function deps(stored: unknown = undefined, response: () => Promise<Response> = async () => Response.json(TABLE)) {
  const saved: RuntimePools[] = []
  return {
    saved,
    deps: {
      fetch: vi.fn(response) as unknown as typeof fetch,
      load: async () => stored,
      save: async (v: RuntimePools) => {
        saved.push(v)
      },
      now: () => NOW,
    },
  }
}

describe('运行时取卡池表', () => {
  it('需要时经本站转发取一次、存下解析结果、补上 UP 名单', async () => {
    const { deps: d, saved } = deps()
    const out = await withRuntimePools(BUILT, ['LIMITED_79_0_1', 'SINGLE_78_0_1'], d)
    expect(d.fetch).toHaveBeenCalledWith(RUNTIME_POOLS_URL, { headers: { 'x-arkrecord-client': '1' } })
    expect(out.pools.LIMITED_79_0_1!.up).toEqual({ 6: ['char_9001_newa', 'char_9002_newb'], 5: ['char_9003_newc'] })
    expect(saved).toHaveLength(1)
    expect(saved[0]!.fetchedAt).toBe(NOW)
  })

  it('不需要补时不取；存着的结果够用时不取', async () => {
    const none = deps()
    expect(await withRuntimePools(BUILT, ['SINGLE_78_0_1', 'BOOT_0_1_1'], none.deps)).toBe(BUILT)
    expect(none.deps.fetch).not.toHaveBeenCalled()
    const stored: RuntimePools = { fetchedAt: NOW - DAY, ups: extractUpLists(TABLE), lims: {}, missingSince: {} }
    const cached = deps(stored)
    const out = await withRuntimePools(BUILT, ['LIMITED_79_0_1'], cached.deps)
    expect(cached.deps.fetch).not.toHaveBeenCalled()
    expect(out.pools.LIMITED_79_0_1!.up).toBeDefined()
  })

  it('取不到（离线、转发出错、不是 JSON）时照旧，不报错；存着的结果格式不对时当作没有', async () => {
    for (const response of [
      async () => {
        throw new TypeError('offline')
      },
      async () => new Response(null, { status: 502 }),
      async () => new Response('<html>', { status: 200 }),
    ]) {
      const { deps: d, saved } = deps({ fetchedAt: 'x' }, response)
      expect(await withRuntimePools(BUILT, ['LIMITED_79_0_1'], d)).toBe(BUILT)
      expect(saved).toEqual([])
    }
  })
})
