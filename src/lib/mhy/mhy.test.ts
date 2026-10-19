/**
 * 米哈游数据层：时间换算、记录转换与合并、增量同步（假的后端，按 end_id 翻页）、基础统计。
 * UID、记录都是假的。
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { MhyDB } from './db'
import { pickMhyPull, toMhyPull } from './record'
import { summarizeMhy } from './stats'
import { type MhyRpc, MhySyncError, mhyCacheStamp, mhyLocate, syncMhy } from './sync'
import { offsetFor, parseTimeZone, toTimestamp } from './time'
import type { MhyPull } from './types'

const UID = '100000001'
const T0 = 1_760_000_000_000

function raw(gachaType: string, n: number, extra: Record<string, unknown> = {}) {
  const t = new Date(T0 + n * 60_000 + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
  return {
    uid: UID,
    gacha_type: gachaType,
    item_id: '',
    count: '1',
    time: t,
    name: `假物品${n}`,
    lang: 'zh-cn',
    item_type: '角色',
    rank_type: n % 10 === 0 ? '5' : n % 5 === 0 ? '4' : '3',
    op_gacha_type: gachaType === '400' ? '301' : gachaType,
    id: String(1_700_000_000_000_000_000n + BigInt(n)),
    ...extra,
  }
}

/** 假的后端：每个卡池一列记录（从新到旧）；可以让某个卡池在第几页出错 */
function fakeBackend(pools: Record<string, ReturnType<typeof raw>[]>, options: { link?: Record<string, unknown>; failAt?: { pool: string; page: number; kind: string } } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const pages = new Map<string, number>()
  const rpc: MhyRpc = async (method, params) => {
    const p = (params ?? {}) as Record<string, unknown>
    calls.push({ method, params: p })
    if (method === 'mhy.readCache' || method === 'mhy.useLink') {
      return { handle: 'h1', game: 'genshin', gameBiz: 'hk4e_cn', region: 'cn_gf01', uid: UID, source: 'cache', ...options.link }
    }
    if (method === 'mhy.forget') return { ok: true }
    if (method === 'mhy.locate') return { logs: ['C:/x/output_log.txt'], searched: [], dataDirs: [{ path: 'D:/Game/YuanShen_Data', versions: ['5.0.0.0', 3] }, { nope: 1 }] }
    if (method === 'mhy.cacheStamp') return { mtime: 123.5 }
    if (method === 'mhy.fetchPage') {
      const type = String(p.gachaType)
      const page = (pages.get(type) ?? 0) + 1
      pages.set(type, page)
      if (options.failAt && options.failAt.pool === type && options.failAt.page === page) {
        throw { code: -32000, message: '抽卡链接已过期：请在游戏里重新打开一次抽卡记录', data: { kind: options.failAt.kind } }
      }
      let list = pools[type] ?? []
      if (p.endId !== '0') list = list.filter((r) => BigInt(r.id) < BigInt(String(p.endId)))
      return { list: list.slice(0, 20), region: 'cn_gf01', regionTimeZone: null }
    }
    throw new Error(`unexpected ${method}`)
  }
  return { rpc, calls }
}

let dbCount = 0
function freshDb(): MhyDB {
  return new MhyDB(`mhy-test-${++dbCount}`, { indexedDB: new IDBFactory(), IDBKeyRange })
}

/** 每页都返回同样的 20 条常驻记录：id 不会变小 */
const STUCK = Array.from({ length: 20 }, (_, i) => raw('200', 19 - i))
const stuckRpc: MhyRpc = async (method, params) => {
  if (method === 'mhy.readCache') return { handle: 'h', game: 'genshin', gameBiz: 'hk4e_cn', region: 'cn_gf01', uid: UID }
  if (method === 'mhy.fetchPage') return { list: (params as { gachaType: string }).gachaType === '200' ? STUCK : [] }
  return { ok: true }
}

/** 缓存里没有链接 */
const noLinkRpc: MhyRpc = async () => {
  throw { code: -32000, message: '缓存里没有抽卡链接', data: { kind: 'no_link' } }
}

/** 星铁美服：接口给 region_time_zone = -5 */
const starrailRpc: MhyRpc = async (method, params) => {
  if (method === 'mhy.readCache') return { handle: 'h', game: 'starrail', gameBiz: 'hkrpg_global', region: 'prod_official_usa', uid: UID }
  if (method === 'mhy.fetchPage') {
    const list = (params as { gachaType: string }).gachaType === '1' ? [raw('1', 1, { time: '2026-10-01 08:00:00' })] : []
    return { list, regionTimeZone: '-5' }
  }
  return { ok: true }
}

const newestFirst = (gachaType: string, from: number, to: number) => Array.from({ length: to - from }, (_, i) => raw(gachaType, to - 1 - i))

describe('时间', () => {
  it('按区服的固定偏移换算；格式或日期不对时为 NaN', () => {
    expect(toTimestamp('2026-10-01 08:00:00', 8)).toBe(Date.UTC(2026, 9, 1, 0, 0, 0))
    expect(toTimestamp('2026-10-01 08:00:00', -5)).toBe(Date.UTC(2026, 9, 1, 13, 0, 0))
    expect(toTimestamp('2026-02-30 08:00:00', 8)).toBeNaN()
    expect(toTimestamp('2026/10/01 08:00', 8)).toBeNaN()
    expect([offsetFor('cn_gf01'), offsetFor('os_usa'), offsetFor('os_euro'), offsetFor('prod_official_eur'), offsetFor('xx')]).toEqual([8, -5, 1, 1, 8])
    expect([parseTimeZone(8), parseTimeZone('-5'), parseTimeZone('x'), parseTimeZone(99), parseTimeZone(null)]).toEqual([8, -5, undefined, undefined, undefined])
  })
})

describe('记录', () => {
  it('转换：400 归入 301，id 保持字符串，时间换算成时间戳', () => {
    const p = toMhyPull('genshin', `genshin:${UID}`, raw('400', 3), 8)!
    expect(p).toMatchObject({ gachaType: '400', pool: '301', opGachaType: '301', rank: 3, count: 1, source: 'api', itemId: '' })
    expect(p.id).toBe('1700000000000000003')
    expect(p.ts).toBe(T0 + 3 * 60_000)
    expect(toMhyPull('starrail', 'x', raw('11', 1, { gacha_id: '2001' }), 8)).toMatchObject({ pool: '11', gachaId: '2001' })
  })

  it('缺主键、星级或时间不对的记录返回 null', () => {
    for (const extra of [{ id: 1 }, { id: 'abc' }, { rank_type: '6' }, { time: 'bad' }, { gacha_type: undefined }]) {
      expect(toMhyPull('genshin', 'x', raw('200', 1, extra), 8)).toBeNull()
    }
    expect(toMhyPull('genshin', 'x', null, 8)).toBeNull()
  })

  it('合并与顺序无关：接口优先，其次字段更全的', () => {
    const api = toMhyPull('genshin', 'x', raw('200', 1), 8)!
    const imported: MhyPull = { ...api, source: 'import', opGachaType: undefined }
    expect(pickMhyPull(api, imported)).toBe(api)
    expect(pickMhyPull(imported, api)).toBe(api)
    expect(pickMhyPull(api, { ...api })).toBe(api)
  })
})

describe('同步', () => {
  it('每个卡池翻到最后一页；301 同时带回 400；完成后让后端丢掉链接', async () => {
    const db = freshDb()
    const event = newestFirst('301', 100, 125).map((r, i) => (i % 3 ? r : { ...r, gacha_type: '400', op_gacha_type: '301' }))
    const { rpc, calls } = fakeBackend({ '200': newestFirst('200', 0, 45), '301': event })
    const progress: string[] = []
    const result = await syncMhy(rpc, 'genshin', { kind: 'cache' }, { db, now: () => 5, onProgress: (p) => progress.push(p.stage) })
    expect(result).toMatchObject({ added: 70, fetched: 70, skipped: 0, warnings: [] })
    expect(result.account).toMatchObject({ id: `genshin:${UID}`, region: 'cn_gf01', utcOffset: 8, gameBiz: 'hk4e_cn', lastSyncAt: 5, createdAt: 5 })
    expect(result.pools.map((p) => [p.type, p.fetched, p.complete])).toEqual([['301', 25, true], ['302', 0, true], ['200', 45, true], ['500', 0, true], ['100', 0, true]])
    const fetches = calls.filter((c) => c.method === 'mhy.fetchPage' && c.params.gachaType === '200')
    expect(fetches.map((c) => c.params.endId)).toEqual(['0', newestFirst('200', 0, 45)[19]!.id, newestFirst('200', 0, 45)[39]!.id])
    expect(calls.at(-1)).toEqual({ method: 'mhy.forget', params: { handle: 'h1' } })
    expect(await db.pulls.where('[accountId+pool]').equals([`genshin:${UID}`, '301']).count()).toBe(25)
    expect(progress[0]).toContain('缓存')
  })

  it('增量：遇到已有的记录就停；full 时全部重拉但不重复', async () => {
    const db = freshDb()
    await syncMhy(fakeBackend({ '200': newestFirst('200', 0, 45) }).rpc, 'genshin', { kind: 'cache' }, { db })
    const next = fakeBackend({ '200': newestFirst('200', 0, 50) })
    const result = await syncMhy(next.rpc, 'genshin', { kind: 'cache' }, { db })
    expect(result.added).toBe(5)
    expect(next.calls.filter((c) => c.method === 'mhy.fetchPage' && c.params.gachaType === '200')).toHaveLength(1)
    const full = await syncMhy(fakeBackend({ '200': newestFirst('200', 0, 50) }).rpc, 'genshin', { kind: 'cache' }, { db, full: true })
    expect(full).toMatchObject({ added: 0, fetched: 50 })
    expect(await db.pulls.count()).toBe(50)
  })

  it('校验时取不到 UID（常驻池没有记录）时，从其他卡池的记录取', async () => {
    const db = freshDb()
    const { rpc } = fakeBackend({ '301': newestFirst('301', 0, 3) }, { link: { uid: null } })
    const result = await syncMhy(rpc, 'genshin', { kind: 'url', url: 'https://example.invalid' }, { db })
    expect(result.account?.uid).toBe(UID)
    expect(result.added).toBe(3)
  })

  it('完全没有记录：不建账号', async () => {
    const db = freshDb()
    const result = await syncMhy(fakeBackend({}, { link: { uid: null } }).rpc, 'genshin', { kind: 'cache' }, { db })
    expect(result.account).toBeNull()
    expect(result.warnings).toEqual(['这个账号还没有任何抽卡记录'])
    expect(await db.accounts.count()).toBe(0)
  })

  it('中途链接过期：保存已经拉完的卡池，没拉完的整池不存，下次补齐', async () => {
    const db = freshDb()
    const pools = { '301': newestFirst('301', 100, 130), '200': newestFirst('200', 0, 45) }
    const failing = fakeBackend(pools, { failAt: { pool: '200', page: 2, kind: 'link_expired' } })
    const error = await syncMhy(failing.rpc, 'genshin', { kind: 'cache' }, { db, now: () => 7 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MhySyncError)
    const e = error as MhySyncError
    expect(e.kind).toBe('link_expired')
    expect(e.partial?.pools.map((p) => [p.type, p.complete])).toEqual([['301', true], ['302', true], ['200', false]])
    expect(e.partial?.added).toBe(30)
    expect(e.partial?.account?.lastSyncAt).toBeUndefined()
    expect(failing.calls.at(-1)?.method).toBe('mhy.forget')
    expect(await db.pulls.count()).toBe(30)
    const again = await syncMhy(fakeBackend(pools).rpc, 'genshin', { kind: 'cache' }, { db })
    expect(again.added).toBe(45)
  })

  it('读取链接失败：直接抛出后端的错误种类和说明', async () => {
    await expect(syncMhy(noLinkRpc, 'genshin', { kind: 'cache' }, { db: freshDb() })).rejects.toMatchObject({ kind: 'no_link', message: '缓存里没有抽卡链接' })
  })

  it('别的游戏的链接：不拉记录、不建账号，也让后端丢掉链接', async () => {
    const db = freshDb()
    const { rpc, calls } = fakeBackend({}, { link: { game: 'starrail', gameBiz: 'hkrpg_cn' } })
    await expect(syncMhy(rpc, 'genshin', { kind: 'url', url: 'x' }, { db })).rejects.toMatchObject({ kind: 'wrong_game' })
    expect(calls.map((c) => c.method)).toEqual(['mhy.useLink', 'mhy.forget'])
    expect(await db.accounts.count()).toBe(0)
  })

  it('接口翻页异常（id 不变小）时停下，不会无限翻页', async () => {
    const db = freshDb()
    // 第二页又返回同样的 20 条：都已经读过，id 不变小
    await expect(syncMhy(stuckRpc, 'genshin', { kind: 'cache' }, { db, full: true })).rejects.toMatchObject({ kind: 'bad_page' })
  })

  it('星铁：时间按接口给的 region_time_zone 换算', async () => {
    const db = freshDb()
    const result = await syncMhy(starrailRpc, 'starrail', { kind: 'cache' }, { db })
    expect(result.account).toMatchObject({ game: 'starrail', utcOffset: -5 })
    expect((await db.pulls.toArray())[0]!.ts).toBe(Date.UTC(2026, 9, 1, 13, 0, 0))
  })

  it('找目录和缓存时间：只取格式对的字段', async () => {
    const { rpc } = fakeBackend({})
    expect(await mhyLocate(rpc, 'genshin')).toEqual({ dataDirs: [{ path: 'D:/Game/YuanShen_Data', versions: ['5.0.0.0'] }], logs: ['C:/x/output_log.txt'] })
    expect(await mhyCacheStamp(rpc, 'genshin')).toBe(123.5)
  })
})

describe('统计', () => {
  it('每组卡池按从旧到新计数：5★ 用了多少抽、距离上一个 5★ / 4★ 多少抽；301 和 400 共用', () => {
    const pulls = [...newestFirst('301', 1, 26), raw('400', 30)].map((r) => toMhyPull('genshin', 'x', r, 8)!)
    const [character] = summarizeMhy('genshin', pulls)
    expect(character!.pool.type).toBe('301')
    expect(character!.total).toBe(26)
    // 第 10、20、30 抽是 5★（30 号在 400 池里，和 301 连续计数）
    expect(character!.fiveStars.map((f) => [f.pull.id.slice(-2), f.pity])).toEqual([['10', 10], ['20', 10], ['30', 6]])
    expect(character!.sinceFive).toBe(0)
    expect(character!.fourStars).toBe(3)
    expect(summarizeMhy('genshin', []).map((s) => s.total)).toEqual([0, 0, 0, 0, 0])
  })
})
