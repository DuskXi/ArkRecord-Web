/**
 * 桌面版总览的摘要：两个库、四款游戏。记录都是合成的。
 */
import 'fake-indexeddb/auto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { ArkRecordDB } from '../db'
import { MhyDB } from '../mhy/db'
import type { MhyPull } from '../mhy/types'
import type { AkPull, EfPull } from '../types'
import { summarizeGames } from './summary'

let n = 0
const dbs = () => ({ hg: new ArkRecordDB(`summary-hg-${++n}`), mhy: new MhyDB(`summary-mhy-${n}`, { indexedDB: new IDBFactory(), IDBKeyRange }) })

const T0 = Date.UTC(2026, 0, 1)

function akPull(accountId: string, i: number, rarity: number): AkPull {
  return {
    accountId,
    key: `pool:${i}`,
    poolId: 'NORM_1',
    poolName: '常驻标准寻访',
    charId: `char_${i}`,
    charName: `干员${i}`,
    rarity,
    isNew: false,
    gachaTs: T0 + i * 60_000,
    tsSec: Math.floor((T0 + i * 60_000) / 1000),
    pos: 0,
    source: 'api',
  }
}

function efPull(accountId: string, i: number, rarity: number, type: 'char' | 'weapon' = 'char'): EfPull {
  return {
    accountId,
    key: `${type}:p:${i}`,
    type,
    poolId: type === 'char' ? 'standard' : 'weaponbox_constant_1',
    poolName: type === 'char' ? '基础寻访' : '坚冰申领',
    poolType: type === 'char' ? 'E_CharacterGachaPoolType_Standard' : 'normal',
    itemId: `item_${i}`,
    itemName: `物品${i}`,
    rarity,
    isNew: false,
    isFree: false,
    kind: 'draw',
    gachaTs: T0 + i * 60_000,
    seqId: String(i),
    source: 'api',
  }
}

function mhyPull(accountId: string, i: number, rank: number, name: string, pool = '301'): MhyPull {
  const ts = T0 + i * 60_000
  return {
    accountId,
    id: String(1_700_000_000_000_000_000n + BigInt(i)),
    gachaType: pool,
    pool,
    itemId: '',
    name,
    itemType: pool === '302' ? '武器' : '角色',
    rank,
    count: 1,
    time: new Date(ts + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
    ts,
    lang: 'zh-cn',
    source: 'api',
  }
}

describe('summarizeGames', () => {
  it('没有账号时四款游戏都在，按明日方舟、终末地、原神、星铁排', async () => {
    const out = await summarizeGames({}, dbs())
    expect(out.map((g) => [g.game, g.vendor, g.label, g.topStar, g.accounts.length, g.pulls])).toEqual([
      ['arknights', 'hypergryph', '明日方舟', 6, 0, 0],
      ['endfield', 'hypergryph', '终末地', 6, 0, 0],
      ['genshin', 'mihoyo', '原神', 5, 0, 0],
      ['starrail', 'mihoyo', '崩坏：星穹铁道', 5, 0, 0],
    ])
  })

  it('每个账号的总抽数、最高星、角色池垫抽、运气；游戏的合计和最近一次读取', async () => {
    const d = dbs()
    await d.hg.accounts.bulkPut([
      { id: 'arknights:1', game: 'arknights', uid: '1', nickName: '博士', createdAt: 1, lastSyncAt: 100 },
      { id: 'endfield:2', game: 'endfield', uid: '2', nickName: '', createdAt: 2, lastSyncAt: 300 },
    ])
    // 明日方舟：第 10 抽出 6★（rarity 5），之后又抽 4 次
    await d.hg.akPulls.bulkPut(Array.from({ length: 14 }, (_, i) => akPull('arknights:1', i, i === 9 ? 5 : 2)))
    // 终末地：角色 6 抽（第 3 抽 6★），武器 3 抽（有一个 6★ 武器）
    await d.hg.efPulls.bulkPut([
      ...Array.from({ length: 6 }, (_, i) => efPull('endfield:2', i, i === 2 ? 6 : 4)),
      ...Array.from({ length: 3 }, (_, i) => efPull('endfield:2', 100 + i, i === 0 ? 6 : 4, 'weapon')),
    ])
    await d.mhy.accounts.put({ id: 'genshin:100000001', game: 'genshin', uid: '100000001', region: 'cn_gf01', gameBiz: 'hk4e_cn', utcOffset: 8, createdAt: 1, lastSyncAt: 200 })
    // 原神：角色池第 5 抽歪了（迪卢克，常驻），之后 2 抽；武器池 1 个 5★
    await d.mhy.pulls.bulkPut([
      ...Array.from({ length: 7 }, (_, i) => mhyPull('genshin:100000001', i, i === 4 ? 5 : 3, i === 4 ? '迪卢克' : '某三星')),
      mhyPull('genshin:100000001', 50, 5, '某五星武器', '302'),
    ])

    const [ak, ef, gi, sr] = await summarizeGames({ now: Date.UTC(2026, 1, 15) }, d)
    expect(ak!.accounts[0]).toMatchObject({ name: '博士', pulls: 14, top: 1, lastSyncAt: 100, derived: false })
    expect(ak!.accounts[0]!.pity).toMatchObject({ current: 4, hardPity: 99 })
    expect(ak!.accounts[0]!.luck).toBeGreaterThan(0.5)

    // 终末地：总数含武器，垫抽只看角色池；没有昵称时显示 UID
    expect(ef!.accounts[0]).toMatchObject({ name: '2', pulls: 9, top: 2 })
    expect(ef!.accounts[0]!.pity).toMatchObject({ current: 3, hardPity: 80 })

    // 原神：推算的模型；歪了之后是大保底；武器池的 5★ 也算进最高星个数
    expect(gi!.accounts[0]).toMatchObject({ name: '100000001', pulls: 8, top: 2, derived: true, guarantee: 'big' })
    expect(gi!.accounts[0]!.pity).toMatchObject({ current: 2, hardPity: 90 })
    expect([gi!.pulls, gi!.top, gi!.lastSyncAt]).toEqual([8, 2, 200])
    expect(sr!.accounts).toEqual([])

    // 出货率、平均抽数、最近的最高星（新的在前，带第几抽、是否 UP、大小保底、武器标记）
    expect(ak!.accounts[0]!.topRate).toBeCloseTo(1 / 14, 9)
    expect(ak!.accounts[0]!.avgPerTop).toBe(10)
    expect(ef!.accounts[0]!.recentTop.map((h) => [h.name, h.pity, h.weapon])).toEqual([
      ['物品100', 1, true],
      ['物品2', 3, false],
    ])
    expect(gi!.recentTop.map((h) => [h.name, h.pity, h.isUp, h.guarantee, h.weapon])).toEqual([
      ['某五星武器', 1, true, undefined, true],
      ['迪卢克', 5, false, 'small', false],
    ])
    // 每月抽数：最近 12 个月（北京时间），记录都在 2026 年 1 月
    expect(gi!.monthly).toHaveLength(12)
    expect(gi!.monthly.at(-1)).toEqual({ month: '2026-02', pulls: 0 })
    expect(gi!.monthly.at(-2)).toEqual({ month: '2026-01', pulls: 8 })
    expect(gi!.monthly[0]!.month).toBe('2025-03')
    expect(sr!.monthly.every((m) => m.pulls === 0)).toBe(true)
  })

  it('不含演示账号', async () => {
    const d = dbs()
    await d.hg.accounts.put({ id: 'arknights:demo', game: 'arknights', uid: 'demo', nickName: '演示', createdAt: 1 })
    await d.hg.akPulls.bulkPut(Array.from({ length: 3 }, (_, i) => akPull('arknights:demo', i, 2)))
    const [ak] = await summarizeGames({}, d)
    expect([ak!.accounts.length, ak!.pulls]).toEqual([0, 0])
  })

  it('月份按北京时间：UTC 的 1 月 31 日 20 点算 2 月', async () => {
    const d = dbs()
    await d.mhy.accounts.put({ id: 'starrail:100000002', game: 'starrail', uid: '100000002', region: 'prod_gf_cn', gameBiz: 'hkrpg_cn', utcOffset: 8, createdAt: 1 })
    const pull = { ...mhyPull('starrail:100000002', 1, 3, '某三星', '1'), ts: Date.UTC(2026, 0, 31, 20) }
    await d.mhy.pulls.put(pull)
    const [, , , sr] = await summarizeGames({ now: Date.UTC(2026, 1, 15) }, d)
    expect(sr!.monthly.at(-1)).toEqual({ month: '2026-02', pulls: 1 })
    expect(sr!.accounts[0]).toMatchObject({ topRate: 0, avgPerTop: null, recentTop: [] })
  })
})
