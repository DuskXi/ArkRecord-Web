/**
 * 导入的幂等性与顺序无关性：同一批记录不论导入多少次、以什么顺序、从哪种来源（旧版存档、旧版导出、
 * 新版导出、接口同步）进来，最后的数据都应该完全一样——既不重复，也不丢失。
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildExport, type ExportFile, importExportFile, importLegacyAccounts } from './archive'
import { db } from './db'
import { type LegacyPoolEntry, readLegacyLocalStorage } from './legacy'
import type { AkMeta } from './meta'
import { mergeAkPulls, toAkPull } from './sync/arknights'

const meta: AkMeta = {
  version: 'test',
  generatedAt: '',
  upAvailable: false,
  chars: {
    char_103_angel: { n: '能天使', r: 6, p: 'SNIPER' },
    char_124_kroos: { n: '克洛丝', r: 3, p: 'SNIPER' },
    char_123_fang: { n: '芬', r: 3, p: 'PIONEER' },
  },
  pools: { NORM_1: { n: '常驻标准寻访', t: 'NORMAL', o: 1_600_000_000, e: 1_900_000_000 } },
  avatars: [],
}
const ACCOUNT = 'arknights:10001'
const T0 = 1_700_000_000 // 秒
const HOUR = 3600

/** 第 i 次十连：第一抽是能天使或克洛丝（随 i 变化），其余是芬 */
function names(i: number): string[] {
  return Array.from({ length: 10 }, (_, k) => (k === 0 ? (i % 3 === 0 ? '能天使' : '克洛丝') : '芬'))
}
const ids: Record<string, string> = { 能天使: 'char_103_angel', 克洛丝: 'char_124_kroos', 芬: 'char_123_fang' }
const rarity: Record<string, number> = { 能天使: 5, 克洛丝: 2, 芬: 2 }

/** 旧版存档中的十连（秒级时间戳） */
function legacyBatches(from: number, to: number): LegacyPoolEntry[] {
  return Array.from({ length: to - from }, (_, j) => {
    const i = from + j
    return { timestamp: T0 + i * HOUR, pool: '常驻标准寻访', result: names(i).map((name) => ({ name, rarity: rarity[name]!, isNew: false })) }
  })
}

function legacyAccounts(from: number, to: number) {
  const dataSet = {
    'O/10001': {
      userInfo: { type: 'official', token: 't', info: { uid: '10001', nickName: '博士' } },
      poolData: legacyBatches(from, to),
      stoneData: [{ timestamp: T0 + from * HOUR, operation: '购买', changes: [{ before: 10, after: 5 }] }],
      rechargeData: [{ timestamp: T0 + from * HOUR, orderId: `O${from}`, amount: 6 }],
    },
  }
  return readLegacyLocalStorage({ getItem: () => JSON.stringify(dataSet) })
}

/** 新接口返回的同一批十连（毫秒时间戳，可指定与旧版时间的偏差） */
function apiBatches(from: number, to: number, offsetMs = 123) {
  return Array.from({ length: to - from }, (_, j) => from + j).flatMap((i) =>
    names(i).map((name, pos) =>
      toAkPull(ACCOUNT, 'normal', {
        poolId: 'NORM_1',
        poolName: '常驻标准寻访',
        charId: ids[name]!,
        charName: name,
        rarity: rarity[name]!,
        isNew: false,
        gachaTs: String((T0 + i * HOUR) * 1000 + offsetMs),
        pos,
      }),
    ),
  )
}

/** 最终状态：按时间排序的（来源、时间秒、干员）列表 */
async function state() {
  const pulls = await db.akPulls.where('accountId').equals(ACCOUNT).toArray()
  return pulls.map((p) => `${p.source}|${p.tsSec}|${p.pos}|${p.charName}`).toSorted()
}

async function reset() {
  await db.delete()
  await db.open()
}

beforeEach(reset)

describe('两份时间段重叠的旧版数据', () => {
  it('先后导入、顺序颠倒，结果一致且没有重复', async () => {
    const a = legacyAccounts(0, 30) // 第 0–29 次十连
    const b = legacyAccounts(20, 50) // 第 20–49 次，与 a 重叠 10 次
    await importLegacyAccounts(a, meta)
    const second = await importLegacyAccounts(b, meta)
    expect(second.pulls).toBe(200) // 只新增不重叠的 20 次十连
    const ab = await state()
    expect(ab).toHaveLength(500)

    await reset()
    await importLegacyAccounts(b, meta)
    await importLegacyAccounts(a, meta)
    expect(await state()).toEqual(ab)
  })
})

describe('旧版数据与接口同步的数据重叠', () => {
  it('先同步再导入旧版、先导入旧版再同步，结果一致：重叠部分只保留接口数据', async () => {
    const legacy = legacyAccounts(0, 30)
    const api = apiBatches(20, 40)
    await mergeAkPulls(ACCOUNT, api)
    await importLegacyAccounts(legacy, meta)
    const syncFirst = await state()
    expect(syncFirst).toHaveLength(400)
    expect(syncFirst.filter((s) => s.startsWith('legacy|'))).toHaveLength(200)

    await reset()
    await importLegacyAccounts(legacy, meta)
    await mergeAkPulls(ACCOUNT, api)
    expect(await state()).toEqual(syncFirst)
  })

  it('旧版时间与接口时间差一两秒时，内容相同的十连视为同一次寻访', async () => {
    const legacy = legacyAccounts(0, 10)
    // 接口时间比旧版晚 1.5 秒（向下取整后相差 1 秒）
    const api = apiBatches(0, 10, 1500)
    await importLegacyAccounts(legacy, meta)
    await mergeAkPulls(ACCOUNT, api)
    const legacyFirst = await state()
    expect(legacyFirst).toHaveLength(100)
    expect(legacyFirst.every((s) => s.startsWith('api|'))).toBe(true)

    await reset()
    await mergeAkPulls(ACCOUNT, api)
    const added = await importLegacyAccounts(legacy, meta)
    expect(added.pulls).toBe(0)
    expect(await state()).toEqual(legacyFirst)
  })

  it('时间相近但内容不同的两次十连不会被合并', async () => {
    const legacy = legacyAccounts(0, 1) // 第一抽是能天使
    const other = apiBatches(1, 2).map((p) => ({ ...p, gachaTs: (T0 + 2) * 1000, tsSec: T0 + 2, key: `${p.key}:x` })) // 2 秒后的另一次十连（第一抽克洛丝）
    await importLegacyAccounts(legacy, meta)
    await mergeAkPulls(ACCOUNT, other)
    expect(await state()).toHaveLength(20)
  })
})

/** 在空库中准备数据并导出，然后清空 */
async function exportOf(setup: () => Promise<unknown>): Promise<ExportFile> {
  await reset()
  await setup()
  const file = JSON.parse(JSON.stringify(await buildExport('test'))) as ExportFile
  await reset()
  return file
}

/** 终末地导出文件中的一条记录 */
function efRecord(seq: number) {
  return {
  type: 'char',
  poolId: 'special_1',
  poolName: '特许寻访',
  poolType: 'E_CharacterGachaPoolType_Special',
  charId: 'chr_0016_laevat',
  charName: '莱万汀',
  rarity: 6,
  isNew: false,
  isFree: false,
  kind: 'draw',
  gachaTs: String(T0 * 1000 + seq),
  seqId: String(seq),
}
}

/** 终末地导出文件：第 from 到 to - 1 条记录 */
function efFile(from: number, to: number): ExportFile {
  return {
  info: { export_app: 'ArkRecord', export_app_version: 'test', export_timestamp: T0, version: 'v2.0' },
  arknights: [],
  endfield: [{ uid: '20001', nickName: '管理员', list: Array.from({ length: to - from }, (_, i) => efRecord(from + i)) }],
} as unknown as ExportFile
}

describe('新版导出文件', () => {
  it('两台设备各自的导出（时间段重叠，混有旧版与接口数据）先后导入，顺序无关', async () => {
    const x = await exportOf(async () => {
      await importLegacyAccounts(legacyAccounts(0, 30), meta)
    })
    const y = await exportOf(async () => {
      await db.accounts.put({ id: ACCOUNT, game: 'arknights', uid: '10001', nickName: '博士', createdAt: 0 })
      await mergeAkPulls(ACCOUNT, apiBatches(20, 40))
    })
    await importExportFile(x)
    await importExportFile(y)
    const xy = await state()
    expect(xy).toHaveLength(400)

    await reset()
    await importExportFile(y)
    await importExportFile(x)
    expect(await state()).toEqual(xy)

    // 再导入一遍任何一份都不会新增
    expect((await importExportFile(x)).pulls).toBe(0)
    expect((await importExportFile(y)).pulls).toBe(0)
    expect(await state()).toEqual(xy)
  })

  it('源石 / 充值记录重复导入不会重复，导入结果只统计新增的条数', async () => {
    const first = await importLegacyAccounts(legacyAccounts(0, 5), meta)
    expect(first.ledger).toBe(2)
    const again = await importLegacyAccounts(legacyAccounts(0, 5), meta)
    expect(again.ledger).toBe(0)
    expect(await db.akLedger.count()).toBe(2)
  })

  it('终末地记录重复导入不会重复', async () => {
    await importExportFile(efFile(0, 30))
    const second = await importExportFile(efFile(20, 50))
    expect(second.pulls).toBe(20)
    expect(await db.efPulls.count()).toBe(50)
  })
})
