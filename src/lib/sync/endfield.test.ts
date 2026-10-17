/**
 * 终末地记录的星级：接口个别条目给的不是整数时，按游戏数据表补上；本地已有的旧记录在上传云端前修正。
 */
import { Dexie } from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EfPull } from '../types'

const META = { generatedAt: '', pools: {}, items: { wpn_0001: { n: '武器', r: 5 }, chr_0004_pelica: { n: '佩丽卡', r: 5 } } }

async function fresh() {
  vi.resetModules()
  const deps = (Dexie as unknown as { dependencies: { indexedDB: unknown; IDBKeyRange: unknown } }).dependencies
  deps.indexedDB = new IDBFactory()
  deps.IDBKeyRange = IDBKeyRange
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(META)))
  return {
    sync: await import('./endfield'),
    db: (await import('../db')).db,
    dataset: await import('../cloud/dataset'),
    codec: await import('../cloud/codec'),
  }
}

afterEach(() => vi.unstubAllGlobals())

const pull = (key: string, rarity: unknown, itemId = 'wpn_0001'): EfPull =>
  ({
    accountId: 'endfield:1',
    key,
    type: 'weapon',
    poolId: 'p',
    poolName: '武器池',
    poolType: 'w',
    itemId,
    itemName: '武器',
    rarity,
    isNew: false,
    isFree: false,
    kind: 'gift_x',
    gachaTs: 1_700_000_000_000,
    seqId: key,
    source: 'api',
  }) as EfPull

describe('终末地记录的星级', () => {
  it('整数原样保留；数字字符串转成整数；其他按游戏数据表补上，查不到时为 0', async () => {
    const { sync } = await fresh()
    expect(sync.efRarity(6, 'x', META)).toBe(6)
    expect(sync.efRarity(-0, 'x', META)).toBe(0)
    expect(Object.is(sync.efRarity(-0, 'x', META), -0)).toBe(false)
    expect(sync.efRarity('5', 'x', META)).toBe(5)
    expect(sync.efRarity(null, 'wpn_0001', META)).toBe(5)
    expect(sync.efRarity(undefined, 'wpn_0001', META)).toBe(5)
    expect(sync.efRarity(Number.NaN, 'wpn_0001', META)).toBe(5)
    expect(sync.efRarity(4.5, 'unknown', META)).toBe(0)
    expect(sync.efRarity(null, '', META)).toBe(0)
  })

  it('接口记录换算时修正星级', async () => {
    const { sync } = await fresh()
    const p = sync.toEfPull('endfield:1', 'weapon', 'w', { poolId: 'p', poolName: 'n', weaponId: 'wpn_0001', weaponName: '武器', rarity: null as never, isNew: false, gachaTs: '1', seqId: '9' }, META)
    expect(p.rarity).toBe(5)
  })

  it('上传云端前修正本地已有的旧记录，修正后能正常编码', async () => {
    const { db, dataset, codec } = await fresh()
    await db.accounts.put({ id: 'endfield:1', game: 'endfield', uid: '1', nickName: '管理员', createdAt: 1 })
    await db.efPulls.bulkPut([pull('1', 6, 'chr_0004_pelica'), pull('2', null), pull('3', '4'), pull('4', undefined, 'nope')])
    const account = (await db.accounts.get('endfield:1'))!
    const ds = await dataset.readLocalDataset(account)
    expect(() => codec.encodeDatasetBytes(ds)).not.toThrow()
    const stored = await db.efPulls.where('accountId').equals('endfield:1').toArray()
    expect(Object.fromEntries(stored.map((p) => [p.key, p.rarity]))).toEqual({ '1': 6, '2': 5, '3': 4, '4': 0 })
  })

  it('编码失败时错误信息带上不合法的值', async () => {
    const { codec } = await fresh()
    const ds = { game: 'endfield', uid: '1', account: { nickName: 'a', metaAt: 0 }, pulls: [{ ...pull('1', null), accountId: undefined }], pools: [] }
    expect(() => codec.encodeDatasetBytes(ds as never)).toThrow(/rarity 不合法（null）/)
  })
})
