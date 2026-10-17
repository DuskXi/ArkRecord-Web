/**
 * 合并规则的代数性质（docs/rewrite/cloud-sync.md 10.1）：同键多个版本时保留哪一个，必须与顺序无关。
 * 用随机生成的版本验证幂等、交换、结合，再验证写入 IndexedDB 时，不论以什么顺序、分几批写入，结果都一样。
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { jcs } from './jcs'
import { mergeLedger, pickLedger } from './ledger'
import { pickAkPull, pickEfPool, pickEfPull } from './merge'
import { mergeAkPulls } from './sync/arknights'
import { mergeEfPulls } from './sync/endfield'
import type { AkLedgerEntry, AkPull, EfPoolInfo, EfPull } from './types'

/** 可复现的伪随机数 */
function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ACCOUNT = 'arknights:1'
const SOURCES: AkPull['source'][] = ['api', 'import', 'legacy']

/** 同一个键的随机版本：来源、类别有无、名字可能不同 */
function akVersion(r: () => number, key = 'P:char_1:1700000000000:0'): AkPull {
  const pull: AkPull = {
    accountId: ACCOUNT,
    key,
    poolId: 'P',
    poolName: r() < 0.5 ? '常驻标准寻访' : '标准寻访',
    charId: 'char_1',
    charName: r() < 0.5 ? '能天使' : '能天使 ',
    rarity: 5,
    isNew: r() < 0.5,
    gachaTs: 1_700_000_000_000,
    tsSec: 1_700_000_000,
    pos: 0,
    source: SOURCES[Math.floor(r() * 3)]!,
  }
  if (r() < 0.5) pull.category = 'normal'
  return pull
}

const canon = (x: object) => jcs(x)

function checkLaws<T extends object>(pick: (a: T, b: T) => T, make: (r: () => number) => T) {
  const r = rng(42)
  for (let i = 0; i < 500; i++) {
    const a = make(r)
    const b = make(r)
    const c = make(r)
    expect(canon(pick(a, a))).toBe(canon(a))
    expect(canon(pick(a, b))).toBe(canon(pick(b, a)))
    expect(canon(pick(pick(a, b), c))).toBe(canon(pick(a, pick(b, c))))
  }
}

describe('同键多个版本：保留哪一个与顺序无关', () => {
  it('明日方舟寻访：幂等、交换、结合；接口 > 导入 > 旧版', () => {
    checkLaws(pickAkPull, (r) => akVersion(r))
    const r = rng(1)
    const api = { ...akVersion(r), source: 'api' as const }
    const imported = { ...akVersion(r), source: 'import' as const, category: 'normal' }
    expect(pickAkPull(imported, api)).toBe(api)
    expect(pickAkPull(api, imported)).toBe(api)
  })

  it('同来源时字段更全的优先', () => {
    const r = rng(2)
    const base = { ...akVersion(r), source: 'import' as const }
    delete base.category
    const full = { ...base, category: 'normal' }
    expect(pickAkPull(base, full)).toBe(full)
    expect(pickAkPull(full, base)).toBe(full)
  })

  it('终末地寻访、卡池信息：幂等、交换、结合', () => {
    checkLaws<EfPull>(pickEfPull, (r) => ({
      accountId: 'endfield:1',
      key: 'char:P:1',
      type: 'char',
      poolId: 'P',
      poolName: r() < 0.5 ? 'A' : 'B',
      poolType: 'x',
      itemId: 'i',
      itemName: r() < 0.5 ? '甲' : '乙',
      rarity: 6,
      isNew: r() < 0.5,
      isFree: false,
      kind: 'draw',
      gachaTs: 1,
      seqId: '1',
      source: r() < 0.5 ? 'api' : 'import',
    }))
    checkLaws<EfPoolInfo>(pickEfPool, (r) => ({
      poolId: 'P',
      poolName: r() < 0.5 ? 'A' : 'B',
      poolType: 'x',
      gachaType: 'char',
      items: [],
      fetchedAt: Math.floor(r() * 3),
    }))
  })

  it('源石记录：新接口格式优先于旧版格式，幂等、交换、结合', () => {
    const legacy: AkLedgerEntry = {
      accountId: ACCOUNT,
      kind: 'stone',
      key: '1700000000:购买:10:5',
      ts: 1_700_000_000_000,
      raw: { timestamp: 1_700_000_000, operation: '购买', changes: [{ before: 10, after: 5 }] },
    }
    const api: AkLedgerEntry = { ...legacy, raw: { eventTs: 1_700_000_000, operation: '购买', changeNum: -5, after: 5 } }
    expect(pickLedger(legacy, api)).toBe(api)
    expect(pickLedger(api, legacy)).toBe(api)
    checkLaws<AkLedgerEntry>(pickLedger, (r) => (r() < 0.5 ? legacy : api))
  })
})

/** 把一组记录随机打乱、随机分批 */
function shuffleChunks<T>(r: () => number, items: T[]): T[][] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  const chunks: T[][] = []
  while (copy.length) chunks.push(copy.splice(0, 1 + Math.floor(r() * 4)))
  return chunks
}

const efMake = (i: number, source: EfPull['source']): EfPull => ({
  accountId: 'endfield:1',
  key: `char:P:${i}`,
  type: 'char',
  poolId: 'P',
  poolName: 'A',
  poolType: 'x',
  itemId: 'i',
  itemName: '甲',
  rarity: 6,
  isNew: false,
  isFree: false,
  kind: 'draw',
  gachaTs: i,
  seqId: String(i),
  source,
})

async function akState() {
  const rows = await db.akPulls.where('accountId').equals(ACCOUNT).toArray()
  return rows.map((p) => canon(p)).toSorted()
}

describe('写入本地数据库：顺序和分批方式不影响结果', () => {
  beforeEach(async () => {
    await db.delete()
    await db.open()
  })

  it('明日方舟寻访：多个键、每个键多个版本，随机顺序写入多次，结果相同', async () => {
    const r = rng(7)
    const versions = Array.from({ length: 40 }, (_, i) => ({ ...akVersion(r, `P:char_1:${1_700_000_000_000 + (i % 8) * 1000}:0`), gachaTs: 1_700_000_000_000 + (i % 8) * 1000, tsSec: 1_700_000_000 + (i % 8) }))
      .filter((p) => p.source !== 'legacy')
    let expected: string[] | null = null
    for (let round = 0; round < 6; round++) {
      await db.akPulls.clear()
      for (const chunk of shuffleChunks(r, versions)) await mergeAkPulls(ACCOUNT, chunk)
      // 重复写入不改变结果
      await mergeAkPulls(ACCOUNT, versions)
      const state = await akState()
      expected ??= state
      expect(state).toEqual(expected)
    }
  })

  it('终末地寻访：随机顺序写入，结果相同；新增条数只算新键', async () => {
    const r = rng(9)
    const all = [...Array.from({ length: 10 }, (_, i) => efMake(i, 'import')), ...Array.from({ length: 10 }, (_, i) => efMake(i, 'api'))]
    expect(await mergeEfPulls('endfield:1', all.slice(0, 10))).toBe(10)
    expect(await mergeEfPulls('endfield:1', all.slice(10))).toBe(0)
    const first = (await db.efPulls.toArray()).map((p) => canon(p)).toSorted()
    await db.efPulls.clear()
    for (const chunk of shuffleChunks(r, all)) await mergeEfPulls('endfield:1', chunk)
    expect((await db.efPulls.toArray()).map((p) => canon(p)).toSorted()).toEqual(first)
    expect((await db.efPulls.toArray()).every((p) => p.source === 'api')).toBe(true)
  })

  it('源石记录：旧版格式和新接口格式以任意顺序写入，都保留新接口格式', async () => {
    const legacy: AkLedgerEntry = {
      accountId: ACCOUNT,
      kind: 'stone',
      key: '1700000000:购买:10:5',
      ts: 1_700_000_000_000,
      raw: { timestamp: 1_700_000_000, operation: '购买', changes: [{ before: 10, after: 5 }] },
    }
    const api: AkLedgerEntry = { ...legacy, raw: { eventTs: 1_700_000_000, operation: '购买', changeNum: -5, after: 5 } }
    expect(await mergeLedger([api])).toBe(1)
    expect(await mergeLedger([legacy])).toBe(0)
    expect((await db.akLedger.toArray())[0]!.raw).toEqual(api.raw)
    await db.akLedger.clear()
    expect(await mergeLedger([legacy])).toBe(1)
    expect(await mergeLedger([api])).toBe(0)
    expect((await db.akLedger.toArray())[0]!.raw).toEqual(api.raw)
  })
})
