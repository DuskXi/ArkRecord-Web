/**
 * 桌面版的使用人数统计（维护者 2026-10-19 决定）。网页版的匿名统计见 stats.ts，不受影响。
 *
 * 由桌面版的 Python 后端上报（desktop/backend/arkrecord_backend/stats.py），默认开启，可以在“关于”页关闭。
 * 三种计数，互相不关联：
 *   - 设备：安装时随机生成的设备 ID（不读任何硬件信息），上报它的 SHA-256；附带“有没有登录账号”，用来数没登录的设备；
 *   - UID：每个游戏账号单独一次请求，上报 SHA-256("arkrecord-uid-v1:<游戏>:<UID>")。
 * 设备和 UID 分开请求、间隔随机时间，请求里没有共同字段，服务器无法把账号和设备对上。
 *
 * 服务器收到后，再用只有服务器知道的密钥 STATS_UID_SALT 做 HMAC，只保存 HMAC：
 * UID 只有 9 位左右，单纯哈希（即使加了公开的前缀）可以穷举反查；加了服务器密钥后，存下来的值没有密钥就反查不出。
 * 不保存 IP（IP 只由 Cloudflare 的限速绑定使用）。按天的记录保留 35 天，按月的保留 13 个月；累计去重的记录一直保留。
 */

import { cnDay, type SqlLike } from './stats'

export const DESKTOP_GAMES = ['arknights', 'endfield', 'genshin', 'starrail'] as const
export type DesktopGame = (typeof DESKTOP_GAMES)[number]

export type DesktopPing = { kind: 'device'; hash: string; loggedIn: boolean } | { kind: 'uid'; game: DesktopGame; hash: string }

const SHA256_HEX = /^[0-9a-f]{64}$/
const DAY_RETENTION = 35
const MONTH_RETENTION = 13
/** 计数器种类：device、device_nologin、uid:<游戏> */
const KINDS = new Set(['device', 'device_nologin', ...DESKTOP_GAMES.map((g) => `uid:${g}`)])

/** 只接受规定的字段和格式，其他内容一律拒绝 */
export function parseDesktopPing(kind: string, body: unknown): DesktopPing | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (typeof b.hash !== 'string' || !SHA256_HEX.test(b.hash)) return null
  if (kind === 'device') {
    if (Object.keys(b).some((k) => k !== 'hash' && k !== 'loggedIn') || typeof b.loggedIn !== 'boolean') return null
    return { kind, hash: b.hash, loggedIn: b.loggedIn }
  }
  if (kind === 'uid') {
    if (Object.keys(b).some((k) => k !== 'hash' && k !== 'game')) return null
    if (!(DESKTOP_GAMES as readonly unknown[]).includes(b.game)) return null
    return { kind, game: b.game as DesktopGame, hash: b.hash }
  }
  return null
}

/** 这次上报要计入的计数器 */
export function kindsFor(ping: DesktopPing): string[] {
  if (ping.kind === 'uid') return [`uid:${ping.game}`]
  return ping.loggedIn ? ['device'] : ['device', 'device_nologin']
}

/** 服务器密钥做的 HMAC-SHA256（十六进制）。设备和 UID 用不同的前缀，同一个值在两种计数里也对不上 */
export async function saltedKey(secret: string, ping: DesktopPing): Promise<string> {
  const message = ping.kind === 'uid' ? `uid:${ping.game}:${ping.hash}` : `device:${ping.hash}`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function initDesktopSchema(sql: SqlLike): void {
  // scope：all（累计）/ day:YYYY-MM-DD / month:YYYY-MM；key 是服务器密钥做的 HMAC
  sql.exec('CREATE TABLE IF NOT EXISTS desktop_seen (kind TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (kind, scope, key))')
}

/** Durable Object 收到的内容：计数器种类和 HMAC，校验后才记录 */
export function parseDesktopRecord(body: unknown): { kinds: string[]; key: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const { kinds, key } = body as { kinds?: unknown; key?: unknown }
  if (typeof key !== 'string' || !SHA256_HEX.test(key)) return null
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > 2 || !kinds.every((k) => typeof k === 'string' && KINDS.has(k))) return null
  return { kinds: kinds as string[], key }
}

function monthsAgo(day: string, months: number): string {
  const [y, m] = day.split('-').map(Number) as [number, number]
  const index = y * 12 + (m - 1) - months
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

export function recordDesktop(sql: SqlLike, record: { kinds: string[]; key: string }, now = Date.now()): void {
  const today = cnDay(now)
  const scopes = ['all', `day:${today}`, `month:${today.slice(0, 7)}`]
  for (const kind of record.kinds) {
    for (const scope of scopes) sql.exec('INSERT OR IGNORE INTO desktop_seen (kind, scope, key) VALUES (?, ?, ?)', kind, scope, record.key)
  }
  // 过期的按天、按月记录删掉（scope 是固定格式的字符串，可以直接比较）
  sql.exec("DELETE FROM desktop_seen WHERE scope LIKE 'day:%' AND scope < ?", `day:${cnDay(now - DAY_RETENTION * 86_400_000)}`)
  sql.exec("DELETE FROM desktop_seen WHERE scope LIKE 'month:%' AND scope < ?", `month:${monthsAgo(today, MONTH_RETENTION)}`)
}

export interface DesktopCounts {
  /** 累计 */
  all: number
  month: number
  today: number
}

export interface DesktopSummary {
  devices: DesktopCounts
  /** 没登录任何账号的设备 */
  devicesNoLogin: DesktopCounts
  uids: Record<DesktopGame, DesktopCounts>
}

export function readDesktopSummary(sql: SqlLike, now = Date.now()): DesktopSummary {
  const today = cnDay(now)
  const rows = sql
    .exec(
      'SELECT kind, scope, COUNT(*) AS n FROM desktop_seen WHERE scope IN (?, ?, ?) GROUP BY kind, scope',
      'all',
      `day:${today}`,
      `month:${today.slice(0, 7)}`,
    )
    .toArray()
  const count = (kind: string): DesktopCounts => {
    const get = (scope: string) => Number(rows.find((r) => r.kind === kind && r.scope === scope)?.n ?? 0)
    return { all: get('all'), month: get(`month:${today.slice(0, 7)}`), today: get(`day:${today}`) }
  }
  return {
    devices: count('device'),
    devicesNoLogin: count('device_nologin'),
    uids: Object.fromEntries(DESKTOP_GAMES.map((g) => [g, count(`uid:${g}`)])) as Record<DesktopGame, DesktopCounts>,
  }
}
