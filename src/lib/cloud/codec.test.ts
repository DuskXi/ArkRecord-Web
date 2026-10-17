/**
 * 云同步编码的四个性质（docs/rewrite/cloud-sync.md 9.3）：全覆盖（无损）、无歧义、规范唯一、幂等。
 * 用随机生成、覆盖各种边界值的记录反复验证，再对合法编码做各种“不规范的改写”，确认全部被拒绝。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generateDemoPulls } from '../demo'
import type { AkMeta } from '../meta'
import type { EfPoolInfo } from '../types'
import {
  type AkDataset,
  type AkRecord,
  type CloudDataset,
  CodecError,
  decodeDataset,
  decodeDatasetBytes,
  type EfDataset,
  type EfRecord,
  encodeDataset,
  encodeDatasetBytes,
  fingerprint,
  type LedgerRecord,
  UnsupportedVersionError,
} from './codec'

function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NAMES = ['能天使', '', 'W', '𠮷野家', '🐱‍👤', 'a"b\\c', '\n\t\u0001', 'Ünïcödé', '  空格  ', 'null', '0']
const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!

function shuffle<T>(r: () => number, items: readonly T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

function akRecord(r: () => number, i: number): AkRecord {
  const source = pick(r, ['api', 'import', 'legacy'] as const)
  const gachaTs = r() < 0.05 ? Number.MAX_SAFE_INTEGER - i : 1_600_000_000_000 + Math.floor(r() * 5) * 1000 + Math.floor(r() * 1000) * (r() < 0.5 ? 0 : 1)
  const pos = Math.floor(r() * 10)
  const poolId = r() < 0.1 ? null : pick(r, ['NORM_1', 'LIMITED_2', '', '池:3'])
  const charId = r() < 0.1 ? null : pick(r, ['char_103_angel', 'char_124_kroos', ''])
  const rec: AkRecord = {
    key: '',
    poolId,
    poolName: pick(r, NAMES),
    charId,
    charName: pick(r, NAMES),
    rarity: Math.floor(r() * 6),
    isNew: r() < 0.3,
    gachaTs,
    tsSec: r() < 0.1 ? Math.floor(r() * 1e9) : Math.floor(gachaTs / 1000),
    pos,
    source,
  }
  const c = r()
  if (c < 0.3) rec.category = 'normal'
  else if (c < 0.4) rec.category = ''
  // 大多数键符合标准格式，少数不符合
  rec.key =
    r() < 0.15
      ? `custom:${i}:${pick(r, NAMES)}`
      : source === 'legacy'
        ? `legacy:${rec.tsSec}:${pos}`
        : `${poolId}:${charId}:${gachaTs}:${pos}`
  // 保证键唯一
  if (r() < 0.5) rec.key += `#${i}`
  return rec
}

function ledgerRecord(r: () => number, i: number): LedgerRecord {
  const kind = r() < 0.5 ? 'stone' : 'recharge'
  const raw =
    r() < 0.5
      ? { timestamp: 1_600_000_000 + i, operation: pick(r, NAMES), changes: [{ type: 'IOS', before: i, after: i + 1 }] }
      : { eventTs: 1_600_000_000 + i, operation: '购买', changeNum: -5, after: 1.5, nested: { 'ü': [null, true, false, 0.1, -2] } }
  return { kind, key: `${i}:${pick(r, NAMES)}`, ts: (1_600_000_000 + Math.floor(r() * 100)) * 1000, raw }
}

function efRecord(r: () => number, i: number): EfRecord {
  const type = r() < 0.7 ? 'char' : 'weapon'
  const poolId = pick(r, ['special_1_0_1', 'standard', 'weapon_box'])
  const seqId = pick(r, [String(1000 + i), String(i), `00${i}`, `x${i}`, '9007199254740993', String(Number.MAX_SAFE_INTEGER - i)])
  const rec: EfRecord = {
    key: `${type}:${poolId}:${seqId}`,
    type,
    poolId,
    poolName: pick(r, NAMES),
    poolType: pick(r, ['E_CharacterGachaPoolType_Special', 'normal', '']),
    itemId: pick(r, ['chr_0025_ardelia', 'wpn_1', '']),
    itemName: pick(r, NAMES),
    rarity: 4 + Math.floor(r() * 3),
    isNew: r() < 0.3,
    isFree: r() < 0.2,
    kind: pick(r, ['draw', 'gift_1', '']),
    gachaTs: 1_700_000_000_000 + Math.floor(r() * 20) * 1000,
    seqId,
    source: r() < 0.5 ? 'api' : 'import',
  }
  if (r() < 0.1) rec.key = `odd:${i}`
  return rec
}

function pool(r: () => number, poolId: string): EfPoolInfo {
  const p: EfPoolInfo = {
    poolId,
    poolName: pick(r, NAMES),
    poolType: 'x',
    gachaType: r() < 0.5 ? 'char' : 'weapon',
    items: [{ id: 'chr_1', name: '艾尔黛拉', rarity: 6 }],
    fetchedAt: Math.floor(r() * 1e12),
  }
  if (r() < 0.5) p.up6Name = pick(r, NAMES)
  if (r() < 0.5) p.up5Names = ['甲', '乙']
  return p
}

function akDataset(seed: number, n = 60): AkDataset {
  const r = rng(seed)
  const pulls = new Map<string, AkRecord>()
  for (let i = 0; i < n; i++) {
    const rec = akRecord(r, i)
    pulls.set(rec.key, rec)
  }
  const ledger = new Map<string, LedgerRecord>()
  for (let i = 0; i < n / 4; i++) {
    const e = ledgerRecord(r, i)
    ledger.set(`${e.kind}:${e.key}`, e)
  }
  const account = r() < 0.5 ? { nickName: pick(r, NAMES), metaAt: 0 } : { nickName: '博士', channelName: '官服', isOfficial: true, metaAt: 1_700_000_000_000 }
  return { game: 'arknights', uid: '12345678', account, pulls: [...pulls.values()], ledger: [...ledger.values()] }
}

function efDataset(seed: number, n = 60): EfDataset {
  const r = rng(seed)
  const pulls = new Map<string, EfRecord>()
  for (let i = 0; i < n; i++) {
    const rec = efRecord(r, i)
    pulls.set(rec.key, rec)
  }
  return {
    game: 'endfield',
    uid: '3141592653',
    account: { nickName: '管理员', channelName: '官服', metaAt: 5 },
    pulls: [...pulls.values()],
    pools: ['special_1_0_1', 'standard'].map((id) => pool(r, id)),
  }
}

/** 按键排序后比较，区分缺省与 undefined 之外的一切差异 */
const byKey = <T extends { key: string }>(list: readonly T[]) => list.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

function normalize(ds: CloudDataset) {
  if (ds.game === 'arknights') {
    return { ...ds, pulls: byKey(ds.pulls), ledger: ds.ledger.toSorted((a, b) => (`${a.kind}:${a.key}` < `${b.kind}:${b.key}` ? -1 : 1)) }
  }
  return { ...ds, pulls: byKey(ds.pulls), pools: ds.pools.toSorted((a, b) => (a.poolId < b.poolId ? -1 : 1)) }
}

const datasets = (): CloudDataset[] => [
  ...Array.from({ length: 30 }, (_, i) => akDataset(i + 1)),
  ...Array.from({ length: 30 }, (_, i) => efDataset(i + 100)),
  akDataset(999, 0),
  efDataset(998, 0),
]

describe('全覆盖（无损）', () => {
  it('decode(encode(S)) 与 S 逐字段相同，包括 null、空字符串、缺省、生僻字、emoji、最大安全整数', () => {
    for (const ds of datasets()) {
      expect(normalize(decodeDataset(encodeDataset(ds)))).toStrictEqual(normalize(ds))
      expect(normalize(decodeDatasetBytes(encodeDatasetBytes(ds)))).toStrictEqual(normalize(ds))
    }
  })

  it('真实形态的数据：演示数据生成器生成的明日方舟寻访', () => {
    const meta = JSON.parse(readFileSync('public/gamedata/ak-meta.json', 'utf8')) as AkMeta
    const pulls = generateDemoPulls(meta, Date.parse('2026-10-17T00:00:00Z')).map((p) => {
      const { accountId: _, ...rest } = p
      return rest
    })
    const ds: AkDataset = { game: 'arknights', uid: '1', account: { nickName: '博士', metaAt: 1 }, pulls, ledger: [] }
    const text = encodeDataset(ds)
    expect(normalize(decodeDataset(text))).toStrictEqual(normalize(ds))
    // 标准格式的键、可推算的 tsSec 都不需要单独存
    expect(text).toContain('"tsx":[],"keyx":[]}')
  })

  it('字段表以外的字段、类型不对的值、无法无损表示的值，都直接报错而不是静默丢弃', () => {
    const base = akDataset(5, 3)
    const bad = (patch: Record<string, unknown>) => ({ ...base, pulls: [{ ...base.pulls[0]!, ...patch } as AkRecord] })
    expect(() => encodeDataset(bad({ star: 6 }))).toThrow(CodecError)
    expect(() => encodeDataset(bad({ accountId: 'x' }))).toThrow(CodecError)
    expect(() => encodeDataset(bad({ rarity: 1.5 }))).toThrow(CodecError)
    expect(() => encodeDataset(bad({ rarity: -0 }))).toThrow(CodecError)
    expect(() => encodeDataset(bad({ category: null }))).toThrow(CodecError)
    expect(() => encodeDataset(bad({ poolName: '\uD800' }))).toThrow(CodecError)
    expect(() => encodeDataset(bad({ gachaTs: 2 ** 60 }))).toThrow(CodecError)
    expect(() => encodeDataset(bad({ source: 'web' }))).toThrow(CodecError)
    const ledger = { ...base, ledger: [{ kind: 'stone' as const, key: 'k', ts: 1, raw: { a: Number.NaN } }] }
    expect(() => encodeDataset(ledger)).toThrow(CodecError)
    const dup = { ...base, pulls: [base.pulls[0]!, { ...base.pulls[0]! }] }
    expect(() => encodeDataset(dup)).toThrow(CodecError)
  })

  it('值为 undefined 的字段等同于缺省（唯一的归一化规则）', () => {
    const base = akDataset(6, 5)
    const withUndefined = { ...base, pulls: base.pulls.map((p) => ({ category: undefined, ...p })) }
    expect(encodeDataset(withUndefined)).toBe(encodeDataset(base))
  })
})

describe('规范唯一与幂等', () => {
  it('记录顺序不影响编码；encode(decode(encode(S))) = encode(S)；指纹与顺序无关', async () => {
    const r = rng(77)
    for (const ds of datasets()) {
      const text = encodeDataset(ds)
      const shuffled =
        ds.game === 'arknights'
          ? { ...ds, pulls: shuffle(r, ds.pulls), ledger: shuffle(r, ds.ledger) }
          : { ...ds, pulls: shuffle(r, ds.pulls), pools: shuffle(r, ds.pools) }
      expect(encodeDataset(shuffled)).toBe(text)
      expect(encodeDataset(decodeDataset(text))).toBe(text)
      expect(await fingerprint(shuffled)).toBe(await fingerprint(ds))
    }
  })

  it('不同的数据，编码一定不同（缺省、空字符串、有值三者也不同）', () => {
    const raw = akDataset(8, 10)
    const { category: _, ...first } = raw.pulls[0]!
    const base = { ...raw, pulls: [first as AkRecord, ...raw.pulls.slice(1)] }
    const withCategory = (value: string) => ({ ...base, pulls: base.pulls.map((p, i) => (i === 0 ? { ...p, category: value } : p)) })
    const texts = new Set([
      encodeDataset(base),
      encodeDataset({ ...base, pulls: base.pulls.slice(1) }),
      encodeDataset({ ...base, pulls: base.pulls.map((p, i) => (i === 0 ? { ...p, isNew: !p.isNew } : p)) }),
      encodeDataset(withCategory('')),
      encodeDataset(withCategory('normal')),
      encodeDataset({ ...base, account: { ...base.account, metaAt: base.account.metaAt + 1 } }),
    ])
    expect(texts.size).toBe(6)
  })
})

describe('无歧义：不规范的写法一律拒绝', () => {
  const ak = encodeDataset(akDataset(11, 20))
  const ef = encodeDataset(efDataset(12, 20))

  const variants: [string, (t: string) => string][] = [
    ['多余空白', (t) => t.replace('{"v"', '{ "v"')],
    ['末尾多余换行', (t) => `${t}\n`],
    ['BOM', (t) => `﻿${t}`],
    ['数字写成 1.0', (t) => t.replace('"v":1', '"v":1.0')],
    ['数字带前导零', (t) => t.replace(/"pos":\[(\d)/, '"pos":[0$1')],
    ['数字写成指数', (t) => t.replace(/"ts":\[(\d+)/, (_, d: string) => `"ts":[${Number(d).toExponential()}`)],
    ['键的顺序不同', (t) => t.replace(/"game":("\w+"),"uid":("\d+")/, '"uid":$2,"game":$1')],
    ['重复的键', (t) => t.replace('{"v":1,', '{"v":1,"v":1,')],
    ['多一个没用到的字典项', (t) => t.replace('"pools":[[', '"pools":[["unused","x"],[').replace(/"pool":\[([\d,]*)\]/, (_, xs: string) => `"pool":[${xs.split(',').map((x) => Number(x) + 1).join(',')}]`)],
    ['字符串里不必要的转义', (t) => t.replace('"game":"arknights"', '"game":"\\u0061rknights"').replace('"game":"endfield"', '"game":"\\u0065ndfield"')],
  ]

  it.each(variants)('%s', (name, mutate) => {
    let tried = 0
    for (const text of [ak, ef]) {
      const changed = mutate(text)
      if (changed === text) continue
      tried++
      expect(() => decodeDataset(changed)).toThrow(CodecError)
    }
    // 防止改写没生效、测试形同虚设
    expect(tried, name).toBeGreaterThan(0)
  })

  it('调换两条记录的位置（不再按全序排列）', () => {
    const ds = akDataset(13, 5)
    const text = encodeDataset(ds)
    const o = JSON.parse(text) as { pulls: Record<string, unknown[] | string> }
    for (const col of ['pool', 'char', 'pos'] as const) {
      const c = o.pulls[col] as unknown[]
      ;[c[0], c[1]] = [c[1], c[0]]
    }
    const swapped = JSON.stringify(o)
    if (swapped !== text) expect(() => decodeDataset(swapped)).toThrow(CodecError)
  })

  it('多余的例外项会被拒绝：与推算结果相同的值不允许单独存', () => {
    const ds = akDataset(14, 5)
    const text = encodeDataset(ds)
    const o = JSON.parse(text) as { pulls: { keyx: [number, string][]; tsx: [number, number][] } }
    const first = decodeDataset(text) as AkDataset
    // 找到一条 tsSec 可推算的记录，人为写进例外列
    const sorted = (JSON.parse(text) as { pulls: { ts: number[] } }).pulls.ts
    expect(sorted.length).toBeGreaterThan(0)
    o.pulls.tsx = [[0, Math.floor(sorted[0]! / 1000)]]
    const mutated = JSON.stringify(o)
    if (first.pulls.length && mutated !== text) expect(() => decodeDataset(mutated)).toThrow(CodecError)
  })

  it('不认识的更高版本：提示刷新网页，而不是当成错误数据', () => {
    expect(() => decodeDataset(ak.replace('"v":1', '"v":3'))).toThrow(UnsupportedVersionError)
  })

  it('不是合法 UTF-8 的字节被拒绝', () => {
    expect(() => decodeDatasetBytes(new Uint8Array([0x7b, 0xff, 0x7d]))).toThrow(CodecError)
  })

  it('随机截断、随机删掉一个字符：要么拒绝，要么恰好是另一份合法的规范编码', () => {
    const r = rng(15)
    for (let i = 0; i < 300; i++) {
      const text = r() < 0.5 ? ak : ef
      const at = Math.floor(r() * text.length)
      const mutated = r() < 0.5 ? text.slice(0, at) : text.slice(0, at) + text.slice(at + 1)
      try {
        const ds = decodeDataset(mutated)
        // 如果解码成功，它必须是规范的：重新编码与输入相同
        expect(encodeDataset(ds)).toBe(mutated)
      } catch (error) {
        expect(error).toBeInstanceOf(CodecError)
      }
    }
  })
})

const roster = (r: () => number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    itemId: `chr_${String(i).padStart(4, '0')}_${pick(r, ['a', 'b', 'c'])}`,
    name: pick(r, NAMES),
    copies: r() < 0.3 ? null : Math.floor(r() * 7),
    potential: r() < 0.3 ? null : Math.floor(r() * 6),
    observedAt: 1_700_000_000_000 + Math.floor(r() * 1e9),
    importedAt: 1_700_000_000_000 + Math.floor(r() * 1e9),
    source: pick(r, ['screenshot', 'manual'] as const),
  }))

describe('截图识别的已拥有干员（格式版本 2）', () => {
  it('没有已拥有干员时仍然写成版本 1（以前的网页也能读）；有的时候写成版本 2，无损往返', () => {
    const plain = efDataset(31, 10)
    expect(encodeDataset(plain).startsWith('{"v":1,')).toBe(true)
    expect(encodeDataset({ ...plain, roster: [] })).toBe(encodeDataset(plain))
    const r = rng(32)
    const withRoster = { ...akDataset(33, 10), roster: roster(r, 12) }
    const text = encodeDataset(withRoster)
    expect(text.startsWith('{"v":2,')).toBe(true)
    const back = decodeDataset(text)
    expect(back.roster?.toSorted((a, b) => (a.itemId < b.itemId ? -1 : 1))).toEqual(withRoster.roster.toSorted((a, b) => (a.itemId < b.itemId ? -1 : 1)))
    // 顺序不影响编码
    expect(encodeDataset({ ...withRoster, roster: shuffle(r, withRoster.roster) })).toBe(text)
  })

  it('不规范的写法一律拒绝：版本 2 却没有干员、版本 1 却带着干员、顺序不对、多余字段、重复的干员', () => {
    const r = rng(34)
    const ds = { ...efDataset(35, 5), roster: roster(r, 3) }
    const text = encodeDataset(ds)
    const plain = encodeDataset(efDataset(35, 5))
    expect(() => decodeDataset(plain.replace('{"v":1,', '{"v":2,'))).toThrow(CodecError)
    expect(() => decodeDataset(text.replace('{"v":2,', '{"v":1,'))).toThrow(CodecError)
    const o = JSON.parse(text) as { roster: Record<string, unknown>[] }
    expect(() => decodeDataset(JSON.stringify({ ...o, roster: o.roster.toReversed() }))).toThrow(CodecError)
    expect(() => decodeDataset(text.replace('"itemId":', '"extra":1,"itemId":'))).toThrow(CodecError)
    expect(() => encodeDataset({ ...ds, roster: [...ds.roster, ds.roster[0]!] })).toThrow(CodecError)
    expect(() => encodeDataset({ ...ds, roster: [{ ...ds.roster[0]!, copies: 1.5 }] })).toThrow(CodecError)
  })
})
