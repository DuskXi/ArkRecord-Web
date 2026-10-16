import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildExport, importExportFile, importLegacyAccounts } from './archive'
import { db } from './db'
import { isLegacyExport, parseLegacyExport, readLegacyLocalStorage } from './legacy'
import type { AkMeta } from './meta'
import { mergeAkPulls, toAkPull } from './sync/arknights'

const meta: AkMeta = {
  version: 'test',
  generatedAt: '',
  upAvailable: false,
  chars: {
    char_103_angel: { n: '能天使', r: 6, p: 'SNIPER' },
    char_512_aprot: { n: '暮落', r: 4, p: 'GUARD' },
    char_4025_aprot2: { n: '暮落', r: 5, p: 'SPECIAL' },
  },
  pools: {
    NORM_10_0_1: { n: '常驻标准寻访', t: 'NORMAL', o: 1_650_000_000, e: 1_660_000_000 },
  },
  avatars: [],
}

/** 旧版 localStorage 中 UserDataSet 的真实结构 */
const legacyDataSet = {
  'O/12345678': {
    userInfo: { type: 'official', token: 'acct-token', info: { uid: '12345678', nickName: '博士#1234' }, active: true },
    poolData: [
      {
        timestamp: 1_655_000_000,
        pool: '常驻标准寻访',
        result: [
          { name: '能天使', rarity: 5, isNew: true },
          { name: '暮落', rarity: 3, isNew: false },
        ],
      },
      { timestamp: 1_655_000_100, pool: '某个已结束的联动', result: [{ name: '不存在的干员', rarity: 2, isNew: false }] },
    ],
    stoneData: [{ timestamp: 1_655_000_000, operation: '购买时装', changes: [{ type: 'IOS', before: 30, after: 12 }] }],
    rechargeData: [{ timestamp: 1_655_000_000, amount: 600, orderId: 'O1', productName: '源石', platform: 1 }],
  },
  'B/87654321': {
    userInfo: { type: 'bilibili', token: 'b-token', info: { uid: 87654321, nickName: 'B服博士' } },
    poolData: [],
  },
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('读取旧版数据', () => {
  it('从 localStorage 读取 UserDataSet', () => {
    const accounts = readLegacyLocalStorage({ getItem: (k) => (k === 'UserDataSet' ? JSON.stringify(legacyDataSet) : null) })
    expect(accounts.map((a) => [a.uid, a.channel])).toEqual([
      ['12345678', 'official'],
      ['87654321', 'bilibili'],
    ])
    // 只有官服 token 是鹰角通行证账号 token，B 服的不能用于新流程
    expect(accounts[0]!.accountToken).toBe('acct-token')
    expect(accounts[1]!.accountToken).toBeUndefined()
  })

  it('localStorage 内容损坏时返回空列表', () => {
    expect(readLegacyLocalStorage({ getItem: () => '{broken' })).toEqual([])
  })

  it('识别两种旧版导出文件', () => {
    const v1 = { version: 1, dataBody: [{ pool: legacyDataSet['O/12345678'].poolData, userInfo: legacyDataSet['O/12345678'].userInfo }] }
    const v0 = { version: -1, poolsData: legacyDataSet['O/12345678'].poolData, officialStones: [] }
    expect(isLegacyExport(v1) && isLegacyExport(v0)).toBe(true)
    expect(parseLegacyExport(v1).accounts).toHaveLength(1)
    expect(parseLegacyExport(v0).anonymous.official?.pools).toHaveLength(2)
  })
})

describe('迁移与合并', () => {
  it('旧版十连拆成单抽，补全 charId 与 poolId', async () => {
    const legacy = readLegacyLocalStorage({ getItem: () => JSON.stringify(legacyDataSet) })
    const summary = await importLegacyAccounts(legacy, meta)
    expect(summary).toMatchObject({ accounts: 2, pulls: 3, ledger: 2 })
    const pulls = await db.akPulls.where('accountId').equals('arknights:12345678').sortBy('gachaTs')
    expect(pulls[0]).toMatchObject({ charId: 'char_103_angel', poolId: 'NORM_10_0_1', rarity: 5, isNew: true, pos: 0 })
    // 重名时取先出现的干员
    expect(pulls[1]!.charId).toBe('char_512_aprot')
    expect(pulls[2]).toMatchObject({ charId: null, poolId: null })
  })

  it('重复导入不会产生重复记录', async () => {
    const legacy = readLegacyLocalStorage({ getItem: () => JSON.stringify(legacyDataSet) })
    await importLegacyAccounts(legacy, meta)
    const again = await importLegacyAccounts(legacy, meta)
    expect(again.pulls).toBe(0)
    expect(await db.akPulls.count()).toBe(3)
  })

  it('同一秒的接口数据会替换旧版数据', async () => {
    const legacy = readLegacyLocalStorage({ getItem: () => JSON.stringify(legacyDataSet) })
    await importLegacyAccounts(legacy, meta)
    const api = [
      { poolId: 'NORM_10_0_1', poolName: '常驻标准寻访', charId: 'char_103_angel', charName: '能天使', rarity: 5, isNew: true, gachaTs: '1655000000123', pos: 0 },
      { poolId: 'NORM_10_0_1', poolName: '常驻标准寻访', charId: 'char_512_aprot', charName: '暮落', rarity: 3, isNew: false, gachaTs: '1655000000123', pos: 1 },
    ].map((r) => toAkPull('arknights:12345678', 'normal', r))
    await mergeAkPulls('arknights:12345678', api)
    const pulls = await db.akPulls.where('accountId').equals('arknights:12345678').toArray()
    expect(pulls).toHaveLength(3)
    expect(pulls.filter((p) => p.source === 'legacy').map((p) => p.tsSec)).toEqual([1_655_000_100])
  })
})

describe('导出与导入', () => {
  it('导出后再导入到空库，记录完全一致', async () => {
    const legacy = readLegacyLocalStorage({ getItem: () => JSON.stringify(legacyDataSet) })
    await importLegacyAccounts(legacy, meta)
    await mergeAkPulls('arknights:12345678', [
      toAkPull('arknights:12345678', 'normal', {
        poolId: 'NORM_10_0_1', poolName: '常驻标准寻访', charId: 'char_103_angel', charName: '能天使', rarity: 5, isNew: false, gachaTs: '1656000000000', pos: 0,
      }),
    ])
    const exported = await buildExport('test')
    const before = (await db.akPulls.toArray()).map((p) => p.key).toSorted()

    await db.delete()
    await db.open()
    const summary = await importExportFile(JSON.parse(JSON.stringify(exported)))
    expect(summary.pulls).toBe(before.length)
    expect((await db.akPulls.toArray()).map((p) => p.key).toSorted()).toEqual(before)
    expect(await db.akLedger.count()).toBe(2)
  })
})
