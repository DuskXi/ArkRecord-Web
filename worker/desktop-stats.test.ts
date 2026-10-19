import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  initDesktopSchema,
  kindsFor,
  parseDesktopPing,
  parseDesktopRecord,
  readDesktopSummary,
  recordDesktop,
  saltedKey,
} from './desktop-stats'
import worker from './index'
import type { Env } from './proxy'
import type { SqlLike } from './stats'

// 下面的哈希都是随便写的假值

function memorySql(): SqlLike {
  const db = new DatabaseSync(':memory:')
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query)
      if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...bindings) }
      statement.run(...bindings)
      return { toArray: () => [] }
    },
  }
}

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const H3 = 'c'.repeat(64)
const NOON = Date.parse('2026-10-16T12:00:00+08:00')
const DAY = 86_400_000
const SALT = 'test-salt-0123456789abcdef0123456789abcdef'

describe('上报内容校验', () => {
  it('设备：只有 hash 和 loggedIn', () => {
    expect(parseDesktopPing('device', { hash: H1, loggedIn: false })).toEqual({ kind: 'device', hash: H1, loggedIn: false })
    expect(parseDesktopPing('device', { hash: H1 })).toBeNull()
    expect(parseDesktopPing('device', { hash: H1, loggedIn: true, uid: '1' })).toBeNull()
    expect(parseDesktopPing('device', { hash: 'A'.repeat(64), loggedIn: true })).toBeNull()
    expect(parseDesktopPing('device', { hash: H1.slice(1), loggedIn: true })).toBeNull()
  })

  it('UID：只有 hash 和白名单内的游戏，不接受原始 UID', () => {
    expect(parseDesktopPing('uid', { hash: H1, game: 'genshin' })).toEqual({ kind: 'uid', game: 'genshin', hash: H1 })
    expect(parseDesktopPing('uid', { hash: H1, game: 'zzz' })).toBeNull()
    expect(parseDesktopPing('uid', { hash: '123456789', game: 'arknights' })).toBeNull()
    expect(parseDesktopPing('uid', { hash: H1, game: 'arknights', loggedIn: true })).toBeNull()
    expect(parseDesktopPing('other', { hash: H1 })).toBeNull()
    expect(parseDesktopPing('uid', [H1])).toBeNull()
  })

  it('没登录的设备同时计入设备总数', () => {
    expect(kindsFor({ kind: 'device', hash: H1, loggedIn: false })).toEqual(['device', 'device_nologin'])
    expect(kindsFor({ kind: 'device', hash: H1, loggedIn: true })).toEqual(['device'])
    expect(kindsFor({ kind: 'uid', game: 'endfield', hash: H1 })).toEqual(['uid:endfield'])
  })

  it('Durable Object 只接受规定的计数器和 HMAC', () => {
    expect(parseDesktopRecord({ kinds: ['device'], key: H1 })).toEqual({ kinds: ['device'], key: H1 })
    expect(parseDesktopRecord({ kinds: ['users'], key: H1 })).toBeNull()
    expect(parseDesktopRecord({ kinds: [], key: H1 })).toBeNull()
    expect(parseDesktopRecord({ kinds: ['device'], key: 'x' })).toBeNull()
  })
})

describe('加盐的 HMAC', () => {
  it('同一个值、同一个密钥结果相同；换密钥、换种类都不同', async () => {
    const uid = { kind: 'uid', game: 'arknights', hash: H1 } as const
    const a = await saltedKey(SALT, uid)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await saltedKey(SALT, uid)).toBe(a)
    expect(await saltedKey(`${SALT}x`, uid)).not.toBe(a)
    expect(await saltedKey(SALT, { ...uid, game: 'endfield' })).not.toBe(a)
    expect(await saltedKey(SALT, { kind: 'device', hash: H1, loggedIn: true })).not.toBe(a)
    // 不是原值
    expect(a).not.toBe(H1)
  })
})

describe('计数', () => {
  it('按种类分别去重：累计、本月、今天', () => {
    const sql = memorySql()
    initDesktopSchema(sql)
    recordDesktop(sql, { kinds: ['device', 'device_nologin'], key: H1 }, NOON)
    recordDesktop(sql, { kinds: ['device'], key: H1 }, NOON)
    recordDesktop(sql, { kinds: ['device'], key: H2 }, NOON)
    recordDesktop(sql, { kinds: ['uid:arknights'], key: H3 }, NOON)
    recordDesktop(sql, { kinds: ['uid:arknights'], key: H3 }, NOON + 1000)
    const summary = readDesktopSummary(sql, NOON)
    expect(summary.devices).toEqual({ all: 2, month: 2, today: 2 })
    expect(summary.devicesNoLogin).toEqual({ all: 1, month: 1, today: 1 })
    expect(summary.uids.arknights).toEqual({ all: 1, month: 1, today: 1 })
    expect(summary.uids.genshin).toEqual({ all: 0, month: 0, today: 0 })
  })

  it('第二天的“今天”重新计数，累计和本月保留', () => {
    const sql = memorySql()
    initDesktopSchema(sql)
    recordDesktop(sql, { kinds: ['device'], key: H1 }, NOON)
    recordDesktop(sql, { kinds: ['device'], key: H2 }, NOON + DAY)
    expect(readDesktopSummary(sql, NOON + DAY).devices).toEqual({ all: 2, month: 2, today: 1 })
  })

  it('按天的记录 35 天后删掉，按月的 13 个月后删掉，累计的保留', () => {
    const sql = memorySql()
    initDesktopSchema(sql)
    recordDesktop(sql, { kinds: ['device'], key: H1 }, NOON)
    recordDesktop(sql, { kinds: ['device'], key: H2 }, NOON + 40 * DAY)
    const scopes = () =>
      sql
        .exec('SELECT scope FROM desktop_seen WHERE key = ?', H1)
        .toArray()
        .map((r) => r.scope)
    expect(scopes()).toEqual(expect.arrayContaining(['all', 'month:2026-10']))
    expect(scopes()).not.toContain('day:2026-10-16')
    recordDesktop(sql, { kinds: ['device'], key: H2 }, Date.parse('2027-12-01T12:00:00+08:00'))
    expect(scopes()).toEqual(['all'])
  })

  it('建表可以重复执行', () => {
    const sql = memorySql()
    initDesktopSchema(sql)
    initDesktopSchema(sql)
  })
})

const SELF = 'https://ark-next.kaltsit.dev'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never

function desktopHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-arkrecord-client': 'desktop', 'content-type': 'application/json', ...extra }
}

/** 模拟统计用的 Durable Object，记录收到的内容 */
function fakeStats() {
  const bodies: unknown[] = []
  const stub = {
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }),
  }
  const env = { STATS: { idFromName: () => 'id', get: () => stub }, STATS_UID_SALT: SALT } as unknown as Env
  return { env, bodies }
}

function post(path: string, body: unknown, env: Env, extra: Record<string, string> = {}): Promise<Response> {
  const request = new Request(`${SELF}/api/stats/desktop/${path}`, { method: 'POST', headers: desktopHeaders(extra), body: JSON.stringify(body) })
  return worker.fetch(request as never, env, ctx) as Promise<Response>
}

describe('上报接口', () => {
  it('只保存加盐后的 HMAC，不保存上报的哈希', async () => {
    const { env, bodies } = fakeStats()
    const res = await post('uid', { hash: H1, game: 'arknights' }, env)
    expect(res.status).toBe(204)
    const record = bodies[0] as { kinds: string[]; key: string }
    expect(record.kinds).toEqual(['uid:arknights'])
    expect(record.key).toBe(await saltedKey(SALT, { kind: 'uid', game: 'arknights', hash: H1 }))
    expect(JSON.stringify(bodies)).not.toContain(H1)
  })

  it('设备上报带上是否登录', async () => {
    const { env, bodies } = fakeStats()
    expect((await post('device', { hash: H2, loggedIn: false }, env)).status).toBe(204)
    expect((bodies[0] as { kinds: string[] }).kinds).toEqual(['device', 'device_nologin'])
  })

  it('拒绝浏览器里其他网站发来的请求，以及没有桌面版标记的请求', async () => {
    const { env, bodies } = fakeStats()
    const crossSite = await post('device', { hash: H1, loggedIn: true }, env, { 'sec-fetch-site': 'cross-site' })
    const otherOrigin = await post('device', { hash: H1, loggedIn: true }, env, { origin: 'https://evil.example' })
    const noHeader = await post('device', { hash: H1, loggedIn: true }, env, { 'x-arkrecord-client': '1' })
    expect([crossSite.status, otherOrigin.status, noHeader.status]).toEqual([403, 403, 403])
    expect(bodies).toHaveLength(0)
  })

  it('内容不对返回 400；没有配置密钥时返回 503，不保存没加盐的值', async () => {
    const { env, bodies } = fakeStats()
    expect((await post('uid', { hash: H1, game: 'arknights', uid: '123' }, env)).status).toBe(400)
    const noSalt = { ...env, STATS_UID_SALT: undefined } as unknown as Env
    expect((await post('uid', { hash: H1, game: 'arknights' }, noSalt)).status).toBe(503)
    const shortSalt = { ...env, STATS_UID_SALT: 'short' } as unknown as Env
    expect((await post('uid', { hash: H1, game: 'arknights' }, shortSalt)).status).toBe(503)
    expect(bodies).toHaveLength(0)
  })

  it('受限速保护', async () => {
    const { env, bodies } = fakeStats()
    const limited = { ...env, RL_DATA: { limit: vi.fn(async () => ({ success: false })) } } as unknown as Env
    expect((await post('device', { hash: H1, loggedIn: true }, limited)).status).toBe(429)
    expect(bodies).toHaveLength(0)
  })
})
