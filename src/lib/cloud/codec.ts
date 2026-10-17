/**
 * 云同步的明文编码：一个账号的全部（或部分）记录 ⇄ 规范的 JSON 文本（docs/rewrite/cloud-sync.md 9.2、9.3）。
 *
 * 四个性质，全部由测试保证（codec.test.ts）：
 *   - 全覆盖（无损）：decode(encode(S)) 与 S 逐字段相同，区分“缺省 / null / 空字符串”。
 *     每种记录用一张穷举的字段表描述（FIELDS），字段表以外的字段、类型不对的值直接报错，绝不静默丢弃。
 *     可以推算的字段（tsSec、标准格式的 key）只在与推算结果完全相同时省略，否则写进例外列。
 *   - 无歧义：结构化编码，不用分隔符拼接字符串；可能缺省的字段用元组长度区分，数字与字符串用 JSON 类型区分。
 *   - 规范唯一：记录按全序排列，字典按首次出现的顺序，整数用最短写法，键的顺序固定、没有空白，
 *     任意 JSON（源石/充值的原始条目、卡池的 items）用 RFC 8785。解码后重新编码，必须与输入逐字节相同，否则拒绝。
 *   - 幂等：encode(decode(encode(S))) = encode(S)。
 *
 * 规范唯一性定义在这里的明文上；压缩、加密之后的字节不要求唯一（见 envelope.ts）。
 */
import { CanonicalError, isWellFormed, jcs } from '../jcs'
import type { AkLedgerEntry, AkPull, EfPoolInfo, EfPull, Game } from '../types'

export const FORMAT_VERSION = 1

export class CodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodecError'
  }
}

/** 账号信息（昵称、渠道），按 metaAt 新的优先合并 */
export interface CloudAccountInfo {
  nickName: string
  channelName?: string
  isOfficial?: boolean
  metaAt: number
}

export type AkRecord = Omit<AkPull, 'accountId'>
export type EfRecord = Omit<EfPull, 'accountId'>
export type LedgerRecord = Omit<AkLedgerEntry, 'accountId'>

export interface AkDataset {
  game: 'arknights'
  uid: string
  account: CloudAccountInfo
  pulls: AkRecord[]
  ledger: LedgerRecord[]
}

export interface EfDataset {
  game: 'endfield'
  uid: string
  account: CloudAccountInfo
  pulls: EfRecord[]
  pools: EfPoolInfo[]
}

export type CloudDataset = AkDataset | EfDataset

// ───────────── 字段表：每种记录的每个字段怎么校验（穷举，编译器检查） ─────────────

type FieldKind = 'string' | 'string?' | 'nullableString' | 'int' | 'int?' | 'boolean' | 'boolean?' | 'json' | 'stringList?' | readonly string[]

const AK_FIELDS = {
  key: 'string',
  poolId: 'nullableString',
  poolName: 'string',
  category: 'string?',
  charId: 'nullableString',
  charName: 'string',
  rarity: 'int',
  isNew: 'boolean',
  gachaTs: 'int',
  tsSec: 'int',
  pos: 'int',
  source: ['api', 'legacy', 'import'],
} as const satisfies Record<keyof AkRecord, FieldKind>

const EF_FIELDS = {
  key: 'string',
  type: ['char', 'weapon'],
  poolId: 'string',
  poolName: 'string',
  poolType: 'string',
  itemId: 'string',
  itemName: 'string',
  rarity: 'int',
  isNew: 'boolean',
  isFree: 'boolean',
  kind: 'string',
  gachaTs: 'int',
  seqId: 'string',
  source: ['api', 'import'],
} as const satisfies Record<keyof EfRecord, FieldKind>

const LEDGER_FIELDS = {
  kind: ['stone', 'recharge'],
  key: 'string',
  ts: 'int',
  raw: 'json',
} as const satisfies Record<keyof LedgerRecord, FieldKind>

const POOL_FIELDS = {
  poolId: 'string',
  poolName: 'string',
  poolType: 'string',
  gachaType: ['char', 'weapon'],
  up6Name: 'string?',
  up6Image: 'string?',
  up6Avatar: 'string?',
  up5Names: 'stringList?',
  items: 'json',
  fetchedAt: 'int',
} as const satisfies Record<keyof EfPoolInfo, FieldKind>

const ACCOUNT_FIELDS = {
  nickName: 'string',
  channelName: 'string?',
  isOfficial: 'boolean?',
  metaAt: 'int',
} as const satisfies Record<keyof CloudAccountInfo, FieldKind>

function checkString(value: unknown): value is string {
  return typeof value === 'string' && isWellFormed(value)
}

function checkField(kind: FieldKind, value: unknown): boolean {
  if (Array.isArray(kind)) return kind.includes(value as string)
  switch (kind) {
    case 'string':
      return checkString(value)
    case 'string?':
      return value === undefined || checkString(value)
    case 'nullableString':
      return value === null || checkString(value)
    case 'int':
      return Number.isSafeInteger(value) && !Object.is(value, -0)
    case 'int?':
      return value === undefined || (Number.isSafeInteger(value) && !Object.is(value, -0))
    case 'boolean':
      return typeof value === 'boolean'
    case 'boolean?':
      return value === undefined || typeof value === 'boolean'
    case 'stringList?':
      return value === undefined || (Array.isArray(value) && value.every(checkString))
    case 'json':
      try {
        jcs(value)
        return value !== undefined
      } catch {
        return false
      }
  }
  return false
}

/** 按字段表校验一条记录：缺字段、多字段、类型不对都报错（值为 undefined 的键等同于缺省） */
function validate(record: unknown, fields: Record<string, FieldKind>, what: string): void {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new CodecError(`${what} 不是对象`)
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && !(key in fields)) throw new CodecError(`${what} 有字段表以外的字段 ${key}`)
  }
  for (const [key, kind] of Object.entries(fields)) {
    if (!checkField(kind, (record as Record<string, unknown>)[key])) throw new CodecError(`${what} 的字段 ${key} 不合法`)
  }
}

// ───────────── 规范写入的小工具 ─────────────

/** 字符串、整数、布尔、null 的规范写法（与 RFC 8785 一致） */
function lit(value: string | number | boolean | null): string {
  try {
    return jcs(value)
  } catch (error) {
    throw new CodecError(error instanceof CanonicalError ? error.message : String(error))
  }
}

const list = (items: readonly string[]) => `[${items.join(',')}]`

/** 字典：元组（已写成规范文本）按首次出现的顺序编号 */
class Dict {
  readonly entries: string[] = []
  private readonly index = new Map<string, number>()
  id(tuple: string): number {
    let i = this.index.get(tuple)
    if (i === undefined) {
      i = this.entries.length
      this.index.set(tuple, i)
      this.entries.push(tuple)
    }
    return i
  }
}

function safeDelta(value: number, prev: number): number {
  const delta = value - prev
  if (!Number.isSafeInteger(delta)) throw new CodecError('时间差超出安全整数范围')
  return delta
}

const bits = (values: readonly boolean[]) => lit(values.map((v) => (v ? '1' : '0')).join(''))
const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0)

function assertUniqueKeys(keys: readonly string[], what: string): void {
  if (new Set(keys).size !== keys.length) throw new CodecError(`${what} 有重复的键`)
}

// ───────────── 推算字段 ─────────────

export const derivedAkKey = (r: AkRecord) =>
  r.source === 'legacy' ? `legacy:${r.tsSec}:${r.pos}` : `${r.poolId}:${r.charId}:${r.gachaTs}:${r.pos}`
export const derivedTsSec = (gachaTs: number) => Math.floor(gachaTs / 1000)
export const derivedEfKey = (r: EfRecord) => `${r.type}:${r.poolId}:${r.seqId}`
/** 规范的十进制整数（无前导零、在安全整数范围内）才按数字差分存储 */
const isCanonicalDecimal = (s: string) => /^(0|[1-9]\d*)$/.test(s) && Number.isSafeInteger(Number(s))

const AK_SOURCE_CODE: Record<AkRecord['source'], string> = { api: 'a', import: 'i', legacy: 'l' }
const EF_SOURCE_CODE: Record<EfRecord['source'], string> = { api: 'a', import: 'i' }
const LEDGER_KIND_CODE: Record<LedgerRecord['kind'], string> = { stone: 's', recharge: 'r' }

// ───────────── 编码 ─────────────

function encodeAccount(account: CloudAccountInfo): string {
  validate(account, ACCOUNT_FIELDS, '账号信息')
  return jcs(account)
}

function encodeAkPulls(pulls: readonly AkRecord[]): string {
  pulls.forEach((p, i) => validate(p, AK_FIELDS, `第 ${i + 1} 条明日方舟寻访`))
  assertUniqueKeys(
    pulls.map((p) => p.key),
    '明日方舟寻访',
  )
  const sorted = pulls.toSorted((a, b) => compare(a.gachaTs, b.gachaTs) || compare(a.pos, b.pos) || compare(a.key, b.key))
  const pools = new Dict()
  const chars = new Dict()
  const pool: number[] = []
  const char: number[] = []
  const ts: number[] = []
  const pos: number[] = []
  const tsx: string[] = []
  const keyx: string[] = []
  let src = ''
  let prev = 0
  sorted.forEach((r, i) => {
    pool.push(pools.id(list(r.category === undefined ? [lit(r.poolId), lit(r.poolName)] : [lit(r.poolId), lit(r.poolName), lit(r.category)])))
    char.push(chars.id(list([lit(r.charId), lit(r.charName), lit(r.rarity)])))
    ts.push(safeDelta(r.gachaTs, prev))
    prev = r.gachaTs
    pos.push(r.pos)
    src += AK_SOURCE_CODE[r.source]
    if (r.tsSec !== derivedTsSec(r.gachaTs)) tsx.push(list([lit(i), lit(r.tsSec)]))
    if (r.key !== derivedAkKey(r)) keyx.push(list([lit(i), lit(r.key)]))
  })
  return (
    `{"pools":${list(pools.entries)},"chars":${list(chars.entries)},"pool":${list(pool.map(lit))},"char":${list(char.map(lit))}` +
    `,"ts":${list(ts.map(lit))},"pos":${list(pos.map(lit))},"new":${bits(sorted.map((r) => r.isNew))},"src":${lit(src)}` +
    `,"tsx":${list(tsx)},"keyx":${list(keyx)}}`
  )
}

function encodeEfPulls(pulls: readonly EfRecord[]): string {
  pulls.forEach((p, i) => validate(p, EF_FIELDS, `第 ${i + 1} 条终末地寻访`))
  assertUniqueKeys(
    pulls.map((p) => p.key),
    '终末地寻访',
  )
  const sorted = pulls.toSorted((a, b) => compare(a.gachaTs, b.gachaTs) || compare(a.key, b.key))
  const pools = new Dict()
  const items = new Dict()
  const kinds = new Dict()
  const pool: number[] = []
  const item: number[] = []
  const kind: number[] = []
  const ts: number[] = []
  const seq: string[] = []
  const keyx: string[] = []
  let src = ''
  let prevTs = 0
  let prevSeq = 0
  sorted.forEach((r, i) => {
    pool.push(pools.id(list([lit(r.poolId), lit(r.poolName), lit(r.poolType), lit(r.type)])))
    item.push(items.id(list([lit(r.itemId), lit(r.itemName), lit(r.rarity)])))
    kind.push(kinds.id(lit(r.kind)))
    ts.push(safeDelta(r.gachaTs, prevTs))
    prevTs = r.gachaTs
    if (isCanonicalDecimal(r.seqId)) {
      const n = Number(r.seqId)
      seq.push(lit(safeDelta(n, prevSeq)))
      prevSeq = n
    } else {
      seq.push(lit(r.seqId))
    }
    src += EF_SOURCE_CODE[r.source]
    if (r.key !== derivedEfKey(r)) keyx.push(list([lit(i), lit(r.key)]))
  })
  return (
    `{"pools":${list(pools.entries)},"items":${list(items.entries)},"kinds":${list(kinds.entries)}` +
    `,"pool":${list(pool.map(lit))},"item":${list(item.map(lit))},"kind":${list(kind.map(lit))},"ts":${list(ts.map(lit))}` +
    `,"seq":${list(seq)},"new":${bits(sorted.map((r) => r.isNew))},"free":${bits(sorted.map((r) => r.isFree))},"src":${lit(src)}` +
    `,"keyx":${list(keyx)}}`
  )
}

function encodeLedger(entries: readonly LedgerRecord[]): string {
  entries.forEach((e, i) => validate(e, LEDGER_FIELDS, `第 ${i + 1} 条源石/充值记录`))
  assertUniqueKeys(
    entries.map((e) => `${e.kind}\u0000${e.key}`),
    '源石/充值记录',
  )
  const sorted = entries.toSorted((a, b) => compare(a.ts, b.ts) || compare(a.kind, b.kind) || compare(a.key, b.key))
  const ts: number[] = []
  let prev = 0
  for (const e of sorted) {
    ts.push(safeDelta(e.ts, prev))
    prev = e.ts
  }
  return (
    `{"kind":${lit(sorted.map((e) => LEDGER_KIND_CODE[e.kind]).join(''))},"ts":${list(ts.map(lit))}` +
    `,"key":${list(sorted.map((e) => lit(e.key)))},"raw":${list(sorted.map((e) => jcs(e.raw)))}}`
  )
}

function encodePools(pools: readonly EfPoolInfo[]): string {
  pools.forEach((p, i) => validate(p, POOL_FIELDS, `第 ${i + 1} 条卡池信息`))
  assertUniqueKeys(
    pools.map((p) => p.poolId),
    '卡池信息',
  )
  return list(pools.toSorted((a, b) => compare(a.poolId, b.poolId)).map((p) => jcs(p)))
}

/** 把一个账号的记录编码成规范的 JSON 文本 */
export function encodeDataset(ds: CloudDataset): string {
  if (!checkString(ds.uid) || !ds.uid || ds.uid.length > 64) throw new CodecError('UID 不合法')
  const head = `{"v":${FORMAT_VERSION},"game":${lit(ds.game)},"uid":${lit(ds.uid)},"account":${encodeAccount(ds.account)}`
  if (ds.game === 'arknights') return `${head},"pulls":${encodeAkPulls(ds.pulls)},"ledger":${encodeLedger(ds.ledger)}}`
  if (ds.game === 'endfield') return `${head},"pulls":${encodeEfPulls(ds.pulls)},"pools":${encodePools(ds.pools)}}`
  throw new CodecError('不认识的游戏')
}

// ───────────── 解码（严格校验，最后重新编码比对） ─────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function obj(value: Json | undefined, what: string): Record<string, Json> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CodecError(`${what} 格式不对`)
  return value
}
function arr(value: Json | undefined, what: string, length?: number): Json[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) throw new CodecError(`${what} 格式不对`)
  return value
}
function str(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new CodecError(`${what} 格式不对`)
  return value
}
function int(value: Json | undefined, what: string): number {
  if (!Number.isSafeInteger(value)) throw new CodecError(`${what} 格式不对`)
  return value as number
}
function index(value: Json | undefined, size: number, what: string): number {
  const i = int(value, what)
  if (i < 0 || i >= size) throw new CodecError(`${what} 超出范围`)
  return i
}
function bitList(value: Json | undefined, n: number, what: string): boolean[] {
  const s = str(value, what)
  if (s.length !== n || !/^[01]*$/.test(s)) throw new CodecError(`${what} 格式不对`)
  return [...s].map((c) => c === '1')
}
function codes<T extends string>(value: Json | undefined, n: number, table: Record<T, string>, what: string): T[] {
  const s = str(value, what)
  const reverse = new Map(Object.entries(table).map(([k, v]) => [v as string, k as T]))
  if (s.length !== n) throw new CodecError(`${what} 格式不对`)
  return [...s].map((c) => {
    const v = reverse.get(c)
    if (v === undefined) throw new CodecError(`${what} 格式不对`)
    return v
  })
}
/** 例外列：[[序号, 值], ...]，序号严格递增 */
function exceptions(value: Json | undefined, n: number, what: string): Map<number, Json> {
  const out = new Map<number, Json>()
  let last = -1
  for (const entry of arr(value, what)) {
    const [i, v] = arr(entry, what, 2)
    const at = index(i, n, what)
    if (at <= last) throw new CodecError(`${what} 顺序不对`)
    last = at
    out.set(at, v!)
  }
  return out
}
function addDelta(prev: number, delta: number, what: string): number {
  const value = prev + delta
  if (!Number.isSafeInteger(value)) throw new CodecError(`${what} 超出安全整数范围`)
  return value
}

function decodeAkPulls(value: Json | undefined): AkRecord[] {
  const o = obj(value, '明日方舟寻访')
  const pools = arr(o.pools, '卡池字典').map((t) => {
    const tuple = arr(t, '卡池字典')
    if (tuple.length !== 2 && tuple.length !== 3) throw new CodecError('卡池字典格式不对')
    return tuple
  })
  const chars = arr(o.chars, '干员字典').map((t) => arr(t, '干员字典', 3))
  const pool = arr(o.pool, '卡池列')
  const n = pool.length
  const char = arr(o.char, '干员列', n)
  const ts = arr(o.ts, '时间列', n)
  const pos = arr(o.pos, '位置列', n)
  const isNew = bitList(o.new, n, 'NEW 列')
  const src = codes(o.src, n, AK_SOURCE_CODE, '来源列')
  const tsx = exceptions(o.tsx, n, 'tsSec 例外列')
  const keyx = exceptions(o.keyx, n, 'key 例外列')
  let prev = 0
  return pool.map((pi, i) => {
    const [poolId, poolName, category] = pools[index(pi, pools.length, '卡池序号')]!
    const [charId, charName, rarity] = chars[index(char[i], chars.length, '干员序号')]!
    const gachaTs = addDelta(prev, int(ts[i], '时间差'), '时间')
    prev = gachaTs
    const record = {
      poolId,
      poolName,
      ...(category === undefined ? {} : { category }),
      charId,
      charName,
      rarity,
      isNew: isNew[i],
      gachaTs,
      pos: pos[i],
      source: src[i],
    } as Record<string, unknown>
    record.tsSec = tsx.has(i) ? tsx.get(i) : derivedTsSec(gachaTs)
    validate({ ...record, key: '' }, AK_FIELDS, `第 ${i + 1} 条明日方舟寻访`)
    record.key = keyx.has(i) ? keyx.get(i) : derivedAkKey(record as AkRecord)
    return record as AkRecord
  })
}

function decodeEfPulls(value: Json | undefined): EfRecord[] {
  const o = obj(value, '终末地寻访')
  const pools = arr(o.pools, '卡池字典').map((t) => arr(t, '卡池字典', 4))
  const items = arr(o.items, '物品字典').map((t) => arr(t, '物品字典', 3))
  const kinds = arr(o.kinds, '类型字典')
  const pool = arr(o.pool, '卡池列')
  const n = pool.length
  const item = arr(o.item, '物品列', n)
  const kind = arr(o.kind, '类型列', n)
  const ts = arr(o.ts, '时间列', n)
  const seq = arr(o.seq, '序号列', n)
  const isNew = bitList(o.new, n, 'NEW 列')
  const isFree = bitList(o.free, n, '免费列')
  const src = codes(o.src, n, EF_SOURCE_CODE, '来源列')
  const keyx = exceptions(o.keyx, n, 'key 例外列')
  let prevTs = 0
  let prevSeq = 0
  return pool.map((pi, i) => {
    const [poolId, poolName, poolType, type] = pools[index(pi, pools.length, '卡池序号')]!
    const [itemId, itemName, rarity] = items[index(item[i], items.length, '物品序号')]!
    const gachaTs = addDelta(prevTs, int(ts[i], '时间差'), '时间')
    prevTs = gachaTs
    let seqId: string
    const s = seq[i]
    if (typeof s === 'number') {
      prevSeq = addDelta(prevSeq, int(s, '序号差'), '序号')
      if (prevSeq < 0) throw new CodecError('序号格式不对')
      seqId = String(prevSeq)
    } else {
      seqId = str(s, '序号')
    }
    const record = {
      type,
      poolId,
      poolName,
      poolType,
      itemId,
      itemName,
      rarity,
      isNew: isNew[i],
      isFree: isFree[i],
      kind: kinds[index(kind[i], kinds.length, '类型序号')],
      gachaTs,
      seqId,
      source: src[i],
    } as Record<string, unknown>
    validate({ ...record, key: '' }, EF_FIELDS, `第 ${i + 1} 条终末地寻访`)
    record.key = keyx.has(i) ? keyx.get(i) : derivedEfKey(record as EfRecord)
    return record as EfRecord
  })
}

function decodeLedger(value: Json | undefined): LedgerRecord[] {
  const o = obj(value, '源石/充值记录')
  const kind = str(o.kind, '类型列')
  const n = kind.length
  const kinds = codes(o.kind, n, LEDGER_KIND_CODE, '类型列')
  const ts = arr(o.ts, '时间列', n)
  const key = arr(o.key, '键列', n)
  const raw = arr(o.raw, '原始条目列', n)
  let prev = 0
  return kinds.map((k, i) => {
    prev = addDelta(prev, int(ts[i], '时间差'), '时间')
    return { kind: k, key: str(key[i], '键'), ts: prev, raw: raw[i] }
  })
}

/** 解码规范文本；任何不合规范的输入（包括格式正确但不是规范写法的）都抛出 CodecError */
export function decodeDataset(text: string): CloudDataset {
  let parsed: Json
  try {
    parsed = JSON.parse(text) as Json
  } catch {
    throw new CodecError('不是合法的 JSON')
  }
  const o = obj(parsed, '数据')
  if (o.v !== FORMAT_VERSION) throw new UnsupportedVersionError(typeof o.v === 'number' ? o.v : NaN)
  const game = o.game as Game
  const uid = str(o.uid, 'UID')
  const account = obj(o.account, '账号信息') as unknown as CloudAccountInfo
  let ds: CloudDataset
  if (game === 'arknights') {
    ds = { game, uid, account, pulls: decodeAkPulls(o.pulls), ledger: decodeLedger(o.ledger) }
  } else if (game === 'endfield') {
    ds = { game, uid, account, pulls: decodeEfPulls(o.pulls), pools: arr(o.pools, '卡池信息') as unknown as EfPoolInfo[] }
  } else {
    throw new CodecError('不认识的游戏')
  }
  // 规范唯一：只接受与重新编码逐字节相同的输入
  let again: string
  try {
    again = encodeDataset(ds)
  } catch (error) {
    throw error instanceof CodecError ? error : new CodecError(String(error))
  }
  if (again !== text) throw new CodecError('不是规范编码')
  return ds
}

/** 遇到比自己新的格式版本：只读不写，提示刷新网页（见 cloud-sync.md 9.3 的版本门槛） */
export class UnsupportedVersionError extends CodecError {
  constructor(readonly version: number) {
    super(`云端数据的格式版本（${version}）比这个网页新，请刷新网页后再试`)
    this.name = 'UnsupportedVersionError'
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeDatasetBytes(ds: CloudDataset): Uint8Array {
  return encoder.encode(encodeDataset(ds))
}

export function decodeDatasetBytes(bytes: Uint8Array): CloudDataset {
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    throw new CodecError('不是合法的 UTF-8')
  }
  return decodeDataset(text)
}

/** 数据指纹：规范明文的 SHA-256（十六进制）。两台设备指纹相同，数据就完全一致 */
export async function fingerprint(ds: CloudDataset): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encodeDatasetBytes(ds) as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
