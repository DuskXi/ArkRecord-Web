/**
 * 云同步存储（worker/cloud-vault.ts）：核对通过之前什么都不给、按账号退避、双重验证、批次去重与合并、改密码、删除。
 */
import { describe, expect, it } from 'vitest'
import { ENVELOPE_HEADER_BYTES, toBase64Url, unframe } from '../shared/cloud-protocol'
import { PepperKeys, Vault, type VaultResult } from './cloud-vault'
import { memoryStorage } from './testing/fake-cloud'

const PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef'
const LOCATOR = 'L'.repeat(43)

function key(fill: number): string {
  return toBase64Url(new Uint8Array(32).fill(fill))
}
const GOOD = key(1)
const BAD = key(2)
const WRAPPED = toBase64Url(new Uint8Array(60).fill(7))

/** 一个最小的信封：只有信封头和 16 字节“标签”，Worker 只看信封头 */
function envelope(kind: 'delta' | 'snapshot', kid: number, id: number, size = 0): Uint8Array {
  const e = new Uint8Array(ENVELOPE_HEADER_BYTES + 16 + size)
  e[0] = 1
  e[1] = kid
  e[2] = kind === 'delta' ? 1 : 2
  e[3] = id & 0xff
  e[4] = id >> 8
  return e
}

async function setup() {
  const storage = memoryStorage()
  let now = Date.parse('2026-10-17T00:00:00Z')
  const keys = await PepperKeys.create(PEPPER)
  const vault = new Vault({
    sql: storage.sql,
    transaction: (fn) => storage.transactionSync(fn),
    wipe: () => storage.deleteAll(),
    keys,
    locator: LOCATOR,
    now: () => now,
  })
  return {
    storage,
    vault,
    keys,
    advance: (ms: number) => (now += ms),
    claim: (extra: Record<string, unknown> = {}) =>
      vault.claim({ authKey: GOOD, wrappedDek: WRAPPED, kid: 5, requireHg: false, ...extra }, envelope('snapshot', 5, 1), true),
  }
}

const code = (r: VaultResult) => (r.headers?.['x-arkrecord-cloud'] ?? null)
const bodyJson = (r: VaultResult) => JSON.parse(r.body as string) as Record<string, unknown>

describe('开通与核对', () => {
  it('开通必须有核实过的鹰角 token', async () => {
    const { vault } = await setup()
    const r = await vault.claim({ authKey: GOOD, wrappedDek: WRAPPED, kid: 5, requireHg: false }, envelope('snapshot', 5, 1), false)
    expect(r.status).toBe(403)
  })

  it('开通后用正确的 authKey 能下载；服务器只存 verifier 和再加密过的 DEK', async () => {
    const { vault, storage, claim } = await setup()
    expect((await claim()).status).toBe(200)
    const r = await vault.pull({ authKey: GOOD, afterSeq: 0 }, false)
    expect(r.status).toBe(200)
    const framed = unframe(r.body as Uint8Array)!
    expect(framed.header).toMatchObject({ kid: 5, requireHg: false, wrappedDek: WRAPPED, headSeq: 1, batches: [{ seq: 1, kind: 'snapshot' }] })
    const meta = storage.sql.exec('SELECT * FROM meta').toArray()[0]!
    // 存储里没有 authKey，也没有原样的被包裹的 DEK
    expect(JSON.stringify(meta)).not.toContain(GOOD)
    expect(toBase64Url(meta.sealed_dek as Uint8Array)).not.toBe(WRAPPED)
    expect(meta.verifier).toMatch(/^[0-9a-f]{64}$/)
  })

  it('账号不存在和密码错误返回完全相同的结果', async () => {
    const empty = await setup()
    const missing = await empty.vault.pull({ authKey: GOOD, afterSeq: 0 }, false)
    const claimed = await setup()
    await claimed.claim()
    const wrong = await claimed.vault.pull({ authKey: BAD, afterSeq: 0 }, false)
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(missing.body).toBe(wrong.body)
    expect(missing.headers).toEqual(wrong.headers)
  })
})

describe('查询状态', () => {
  it('只有核实过鹰角 token 才回答；只读，不计失败次数，不写入任何东西', async () => {
    const { vault, storage, claim } = await setup()
    expect(vault.status(false).status).toBe(403)
    expect(bodyJson(vault.status(true))).toEqual({ exists: false })
    // 查询不存在的账号不会建表
    expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray()).toEqual([])
    await claim({ requireHg: true })
    const before = JSON.stringify(storage.sql.exec('SELECT * FROM meta').toArray())
    expect(bodyJson(vault.status(true))).toEqual({ exists: true, mode: 'password', requireHg: true })
    expect(vault.status(false).status).toBe(403)
    expect(JSON.stringify(storage.sql.exec('SELECT * FROM meta').toArray())).toBe(before)
  })
})

describe('按账号退避', () => {
  it('连续失败 5 次后退避，退避期间连正确的密码也不核对；时间到了恢复，成功后清零', async () => {
    const { vault, claim, advance, storage } = await setup()
    await claim()
    for (let i = 0; i < 4; i++) expect((await vault.pull({ authKey: BAD, afterSeq: 0 }, false)).status).toBe(401)
    expect((await vault.pull({ authKey: BAD, afterSeq: 0 }, false)).status).toBe(401)
    // 第 5 次失败后锁 1 分钟
    const locked = await vault.pull({ authKey: GOOD, afterSeq: 0 }, false)
    expect(locked.status).toBe(429)
    expect(locked.headers?.['retry-after']).toBe('60')
    // 失败次数写进了存储
    expect(storage.sql.exec('SELECT fail_count FROM meta').toArray()[0]!.fail_count).toBe(5)
    advance(61_000)
    expect((await vault.pull({ authKey: GOOD, afterSeq: 0 }, false)).status).toBe(200)
    expect(storage.sql.exec('SELECT fail_count, locked_until FROM meta').toArray()[0]).toMatchObject({ fail_count: 0, locked_until: 0 })
  })

  it('退避时间指数增长，最长 1 小时', async () => {
    const { vault, claim, advance } = await setup()
    await claim()
    const waits: string[] = []
    for (let i = 0; i < 12; i++) {
      await vault.pull({ authKey: BAD, afterSeq: 0 }, false)
      const r = await vault.pull({ authKey: BAD, afterSeq: 0 }, false)
      if (r.status === 429) {
        waits.push(r.headers!['retry-after']!)
        advance(Number(r.headers!['retry-after']) * 1000 + 1)
      }
    }
    expect(waits.slice(0, 4)).toEqual(['60', '120', '240', '480'])
    expect(waits.at(-1)).toBe('3600')
  })

  it('不存在的账号也会进入同样的退避（只在内存里）；任何请求都不会在存储里留下东西', async () => {
    const { vault, storage } = await setup()
    for (let i = 0; i < 5; i++) await vault.pull({ authKey: BAD, afterSeq: 0 }, false)
    expect((await vault.pull({ authKey: BAD, afterSeq: 0 }, false)).status).toBe(429)
    await vault.push({ authKey: GOOD }, envelope('delta', 5, 2), false)
    await vault.rekey({ authKey: GOOD, newAuthKey: BAD, wrappedDek: WRAPPED }, false)
    await vault.twoFactor({ authKey: GOOD, requireHg: true }, true)
    await vault.remove({ authKey: GOOD }, false)
    expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray()).toEqual([])
  })
})

describe('上传', () => {
  it('kid 不对：云端已经换了钥匙；同一批次号重复上传不重复写入', async () => {
    const { vault, claim } = await setup()
    await claim()
    expect(code(await vault.push({ authKey: GOOD }, envelope('delta', 6, 2), false))).toBe('stale_key')
    const first = await vault.push({ authKey: GOOD }, envelope('delta', 5, 2), false)
    const again = await vault.push({ authKey: GOOD }, envelope('delta', 5, 2), false)
    expect(bodyJson(first)).toMatchObject({ seq: 2, headSeq: 2 })
    expect(bodyJson(again)).toMatchObject({ seq: 2, duplicate: true })
  })

  it('批次满了必须先合并；合并只替换 seq ≤ upToSeq 的批次，其他设备之后上传的保留', async () => {
    const { vault, claim } = await setup()
    await claim()
    for (let i = 2; i <= 32; i++) expect((await vault.push({ authKey: GOOD }, envelope('delta', 5, i), false)).status).toBe(200)
    expect(code(await vault.push({ authKey: GOOD }, envelope('delta', 5, 99), false))).toBe('compact_required')
    const snap = await vault.push({ authKey: GOOD, upToSeq: 30 }, envelope('snapshot', 5, 100), false)
    expect(snap.status).toBe(200)
    const pulled = unframe((await vault.pull({ authKey: GOOD, afterSeq: 0 }, false)).body as Uint8Array)!
    expect((pulled.header.batches as { seq: number }[]).map((b) => b.seq)).toEqual([31, 32, 33])
    // upToSeq 不能超过当前最大的批次号；delta 不能带 upToSeq
    expect(code(await vault.push({ authKey: GOOD, upToSeq: 999 }, envelope('snapshot', 5, 101), false))).toBe('bad_request')
    expect(code(await vault.push({ authKey: GOOD, upToSeq: 1 }, envelope('delta', 5, 102), false))).toBe('bad_request')
  })

  it('超过每个账号的总量上限时拒绝', async () => {
    const { vault, claim } = await setup()
    await claim()
    for (let i = 2; i < 6; i++) await vault.push({ authKey: GOOD }, envelope('delta', 5, i, 1024 * 1024 - 100), false)
    expect(code(await vault.push({ authKey: GOOD }, envelope('delta', 5, 9, 1024 * 1024 - 100), false))).toBe('quota_exceeded')
  })

  it('增量下载只返回 afterSeq 之后的批次', async () => {
    const { vault, claim } = await setup()
    await claim()
    await vault.push({ authKey: GOOD }, envelope('delta', 5, 2), false)
    await vault.push({ authKey: GOOD }, envelope('delta', 5, 3), false)
    const pulled = unframe((await vault.pull({ authKey: GOOD, afterSeq: 2 }, false)).body as Uint8Array)!
    expect(pulled.header.batches).toEqual([{ seq: 3, kind: 'delta' }])
    expect(pulled.header.headSeq).toBe(3)
  })
})

describe('改密码、覆盖、双重验证、删除', () => {
  it('改密码后旧的 authKey 失效，新的可用；数据不变', async () => {
    const { vault, claim } = await setup()
    await claim()
    const NEW = key(9)
    expect((await vault.rekey({ authKey: GOOD, newAuthKey: NEW, wrappedDek: WRAPPED }, false)).status).toBe(200)
    expect((await vault.pull({ authKey: GOOD, afterSeq: 0 }, false)).status).toBe(401)
    const r = await vault.pull({ authKey: NEW, afterSeq: 0 }, false)
    expect(r.status).toBe(200)
    expect(unframe(r.body as Uint8Array)!.header.headSeq).toBe(1)
  })

  it('覆盖（忘记密码）：删除旧的全部批次，换上新钥匙；批次号继续增长不复用', async () => {
    const { vault, claim } = await setup()
    await claim()
    await vault.push({ authKey: GOOD }, envelope('delta', 5, 2), false)
    const NEW = key(9)
    const r = await vault.claim({ authKey: NEW, wrappedDek: WRAPPED, kid: 8, requireHg: false }, envelope('snapshot', 8, 3), true)
    expect(bodyJson(r)).toMatchObject({ seq: 3 })
    expect((await vault.pull({ authKey: GOOD, afterSeq: 0 }, false)).status).toBe(401)
    const pulled = unframe((await vault.pull({ authKey: NEW, afterSeq: 0 }, false)).body as Uint8Array)!
    expect(pulled.header).toMatchObject({ kid: 8, batches: [{ seq: 3, kind: 'snapshot' }] })
  })

  it('双重验证：开关都需要两样证明；开启后没有鹰角核实的请求不核对密码、不计失败次数', async () => {
    const { vault, claim, storage } = await setup()
    await claim()
    expect((await vault.twoFactor({ authKey: GOOD, requireHg: true }, false)).status).toBe(403)
    expect((await vault.twoFactor({ authKey: BAD, requireHg: true }, true)).status).toBe(401)
    expect((await vault.twoFactor({ authKey: GOOD, requireHg: true }, true)).status).toBe(200)
    for (let i = 0; i < 10; i++) expect((await vault.pull({ authKey: BAD, afterSeq: 0 }, false)).status).toBe(401)
    expect((await vault.pull({ authKey: GOOD, afterSeq: 0 }, false)).status).toBe(401)
    expect(storage.sql.exec('SELECT fail_count FROM meta').toArray()[0]!.fail_count).toBe(0)
    const ok = await vault.pull({ authKey: GOOD, afterSeq: 0 }, true)
    expect(ok.status).toBe(200)
    expect(unframe(ok.body as Uint8Array)!.header.requireHg).toBe(true)
    // 关闭也要两样证明
    expect((await vault.twoFactor({ authKey: GOOD, requireHg: false }, false)).status).toBe(403)
  })

  it('删除：需要 authKey，或者只用核实过的鹰角 token（忘记密码）；删除后什么都不剩', async () => {
    const a = await setup()
    await a.claim()
    expect((await a.vault.remove({ authKey: BAD }, false)).status).toBe(401)
    expect((await a.vault.remove({ authKey: GOOD }, false)).status).toBe(204)
    expect((await a.vault.pull({ authKey: GOOD, afterSeq: 0 }, false)).status).toBe(401)
    const b = await setup()
    await b.claim()
    expect((await b.vault.remove({}, true)).status).toBe(204)
    // 删除后连表都不剩
    expect(b.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray()).toEqual([])
  })
})
