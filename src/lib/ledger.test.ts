import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildExport, type ExportFile, importExportFile, importLegacyAccounts } from './archive'
import { db } from './db'
import { mergeLedger, parseRecharge, parseStone, summarizeRecharge, summarizeStone, toLedgerEntries } from './ledger'
import { readLegacyLocalStorage } from './legacy'
import type { AkMeta } from './meta'

const T = 1_760_000_000 // 秒
const at = (iso: string) => Date.parse(iso) / 1000

describe('解析源石记录', () => {
  it('旧版与新接口的同一条记录得到相同的主键', () => {
    const old = parseStone({ timestamp: T, operation: '购买', changes: [{ type: 'IOS', before: 30, after: 24 }] })
    const api = parseStone({ eventTs: T, operation: '购买', changeNum: -6, after: 24, pos: 3 })
    expect(old).toMatchObject({ ts: T * 1000, before: 30, after: 24, change: -6, platform: 'IOS', source: 'legacy' })
    expect(api).toMatchObject({ ts: T * 1000, before: 30, after: 24, change: -6, platform: null, source: 'api' })
    expect(api!.key).toBe(old!.key)
    // 与旧版迁移代码的主键格式一致
    expect(old!.key).toBe(`${T}:购买:30:24`)
  })

  it('字段是字符串或毫秒时间也能识别；无效条目跳过', () => {
    expect(parseStone({ eventTs: String(T * 1000), operation: '兑换', changeNum: '+5', after: '29' })).toMatchObject({ ts: T * 1000, before: 24, change: 5 })
    expect(parseStone({ operation: '购买' })).toBeNull()
    expect(parseStone(null)).toBeNull()
    expect(parseStone({ timestamp: T, operation: '购买' })!.key).toBe(`${T}:购买:undefined:undefined`)
  })
})

describe('解析充值记录', () => {
  it('旧版与新接口按订单号对应；金额从分换算成元', () => {
    const old = parseRecharge({ timestamp: T, orderId: 'O1', productName: '源石 6', amount: 600, platform: 1 })
    const api = parseRecharge({ payTime: T, orderId: 'O1', productName: '源石 6', amount: 600, platform: 0 })
    expect(old).toMatchObject({ key: 'O1', yuan: 6, platform: '安卓', source: 'legacy' })
    expect(api).toMatchObject({ key: 'O1', yuan: 6, platform: 'iOS', source: 'api', ts: T * 1000 })
  })
})

describe('汇总', () => {
  it('源石：获得、消耗、当前数量、按操作汇总', () => {
    const records = [
      parseStone({ eventTs: T, operation: '购买', changeNum: -6, after: 24 })!,
      parseStone({ eventTs: T + 60, operation: '兑换', changeNum: 10, after: 34 })!,
      parseStone({ eventTs: T + 120, operation: '购买', changeNum: -4, after: 30 })!,
    ]
    const s = summarizeStone(records)
    expect(s).toMatchObject({ count: 3, gained: 10, spent: 10, balance: 30 })
    expect(s.byOperation[0]).toEqual({ operation: '购买', count: 2, gained: 0, spent: 10 })
  })

  it('充值：按月汇总并补齐中间没有充值的月份', () => {
    const records = [
      parseRecharge({ payTime: at('2026-06-30T23:30:00+08:00'), orderId: 'a', productName: '月卡', amount: 3000 })!,
      parseRecharge({ payTime: at('2026-06-30T16:30:00Z'), orderId: 'b', productName: '源石', amount: 64_800 })!, // 北京时间 7 月 1 日
      parseRecharge({ payTime: at('2026-09-02T10:00:00+08:00'), orderId: 'c', productName: '月卡', amount: 3000 })!,
    ]
    const s = summarizeRecharge(records)
    expect(s.yuan).toBe(708)
    expect(s.byMonth).toEqual([
      { month: '2026-06', yuan: 30, count: 1 },
      { month: '2026-07', yuan: 648, count: 1 },
      { month: '2026-08', yuan: 0, count: 0 },
      { month: '2026-09', yuan: 30, count: 1 },
    ])
    expect(s.byProduct[0]).toEqual({ productName: '源石', yuan: 648, count: 1 })
  })
})

const meta: AkMeta = { version: 'test', generatedAt: '', upAvailable: false, chars: {}, pools: {}, avatars: [] }
const ACCOUNT = 'arknights:10001'

function legacy() {
  const dataSet = {
    'O/10001': {
      userInfo: { type: 'official', token: 't', info: { uid: '10001', nickName: '博士' } },
      poolData: [],
      stoneData: [{ timestamp: T, operation: '购买', changes: [{ type: 'IOS', before: 30, after: 24 }] }],
      rechargeData: [{ timestamp: T, orderId: 'O1', productName: '源石 6', amount: 600, platform: 1 }],
    },
  }
  return readLegacyLocalStorage({ getItem: () => JSON.stringify(dataSet) })
}

/** 新接口返回的记录：与旧版重叠一条源石、一条充值，另有各一条新的 */
function apiEntries() {
  return [
    ...toLedgerEntries(ACCOUNT, 'stone', [
      { eventTs: T, operation: '购买', changeNum: -6, after: 24, pos: 1 },
      { eventTs: T + 60, operation: '兑换', changeNum: 10, after: 34, pos: 2 },
    ]),
    ...toLedgerEntries(ACCOUNT, 'recharge', [
      { payTime: T, orderId: 'O1', productName: '源石 6', amount: 600, platform: 1 },
      { payTime: T + 60, orderId: 'O2', productName: '月卡', amount: 3000, platform: 1 },
    ]),
  ]
}

async function keys() {
  return (await db.akLedger.toArray()).map((e) => `${e.kind}|${e.key}`).toSorted()
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('源石 / 充值记录的幂等合并', () => {
  it('旧版数据与接口数据重叠时不重复，先后顺序无关', async () => {
    await importLegacyAccounts(legacy(), meta)
    expect(await mergeLedger(apiEntries())).toBe(2)
    const legacyFirst = await keys()
    expect(legacyFirst).toHaveLength(4)

    await db.delete()
    await db.open()
    expect(await mergeLedger(apiEntries())).toBe(4)
    expect((await importLegacyAccounts(legacy(), meta)).ledger).toBe(0)
    expect(await keys()).toEqual(legacyFirst)
  })

  it('接口来源的记录导出后再导入，主键不变、不会重复', async () => {
    await db.accounts.put({ id: ACCOUNT, game: 'arknights', uid: '10001', nickName: '博士', createdAt: 0 })
    await mergeLedger(apiEntries())
    const before = await keys()
    const file = JSON.parse(JSON.stringify(await buildExport('test'))) as ExportFile

    expect((await importExportFile(file)).ledger).toBe(0)
    await db.delete()
    await db.open()
    expect((await importExportFile(file)).ledger).toBe(4)
    expect(await keys()).toEqual(before)
  })
})
