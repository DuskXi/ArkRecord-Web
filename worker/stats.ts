/**
 * 匿名使用人数统计（Durable Object + SQLite）。
 *
 * 为什么不用 KV：旧版用 KV 为每个浏览器存一个 ID，统计人数要列出全部键，用户越多越慢。
 * 这里只维护计数器：每次上报是几条 UPSERT，读取是几条按主键的查询，耗时与用户数无关；
 * 汇总结果还会在 Cloudflare 边缘缓存 5 分钟（见 proxy.ts 的 handleStats）。
 *
 * 不收集任何标识符：去重在浏览器本地完成（见 src/lib/usage.ts），上报的只有
 *   - first：这个浏览器是否第一次上报；
 *   - newMonth：本月是否第一次上报；
 *   - games / newGames：这个浏览器里有哪些游戏的账号（演示账号不算），以及其中第一次出现的。
 * 不保存 IP（IP 只由 Cloudflare 的限速绑定使用），不涉及账号、UID 或寻访记录。
 * 用户可以在网站的“关于”页关闭统计。
 */

import { initDesktopSchema, parseDesktopRecord, readDesktopSummary, recordDesktop, type DesktopSummary } from './desktop-stats'

export const STATS_PREFIX = '/api/stats/'
export const GAMES = ['arknights', 'endfield'] as const
type GameName = (typeof GAMES)[number]

export interface UsagePing {
  first: boolean
  newMonth: boolean
  games: GameName[]
  newGames: GameName[]
}

export interface UsageSummary {
  /** 累计参与统计的浏览器数 */
  users: number
  /** 累计有该游戏账号的浏览器数 */
  games: Record<GameName, number>
  today: number
  todayNew: number
  month: number
  /** 北京时间的日期，如 2026-10-16 */
  day: string
  /** 桌面版的统计（desktop-stats.ts） */
  desktop?: DesktopSummary
}

function gameList(value: unknown): GameName[] | null {
  return Array.isArray(value) && value.length <= GAMES.length && value.every((g) => (GAMES as readonly unknown[]).includes(g))
    ? [...new Set(value as GameName[])]
    : null
}

/** 只接受布尔值和白名单内的游戏名，其他内容一律拒绝 */
export function parsePing(body: unknown): UsagePing | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.first !== 'boolean' || typeof b.newMonth !== 'boolean') return null
  const games = gameList(b.games)
  const newGames = gameList(b.newGames)
  if (!games || !newGames || !newGames.every((g) => games.includes(g))) return null
  return { first: b.first, newMonth: b.newMonth, games, newGames }
}

const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
export const cnDay = (ms: number) => DAY.format(ms)

/** Durable Object 的 ctx.storage.sql 中用到的部分（测试时用 node:sqlite 实现） */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number)[]): { toArray(): Record<string, unknown>[] }
}

export function initSchema(sql: SqlLike): void {
  // scope：all（累计）/ day:YYYY-MM-DD / month:YYYY-MM
  sql.exec('CREATE TABLE IF NOT EXISTS counters (scope TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (scope, key))')
}

export function recordPing(sql: SqlLike, ping: UsagePing, now = Date.now()): void {
  const day = `day:${cnDay(now)}`
  const month = `month:${cnDay(now).slice(0, 7)}`
  const bump = (scope: string, key: string) =>
    sql.exec(
      'INSERT INTO counters (scope, key, value) VALUES (?, ?, 1) ON CONFLICT (scope, key) DO UPDATE SET value = value + 1',
      scope,
      key,
    )
  if (ping.first) {
    bump('all', 'users')
    bump(day, 'new')
  }
  for (const g of ping.newGames) bump('all', `users:${g}`)
  bump(day, 'active')
  for (const g of ping.games) bump(day, `active:${g}`)
  if (ping.newMonth) bump(month, 'active')
}

export function readSummary(sql: SqlLike, now = Date.now()): UsageSummary {
  const today = cnDay(now)
  const rows = sql
    .exec('SELECT scope, key, value FROM counters WHERE scope IN (?, ?, ?)', 'all', `day:${today}`, `month:${today.slice(0, 7)}`)
    .toArray()
  const get = (scope: string, key: string) => Number(rows.find((r) => r.scope === scope && r.key === key)?.value ?? 0)
  return {
    users: get('all', 'users'),
    games: { arknights: get('all', 'users:arknights'), endfield: get('all', 'users:endfield') },
    today: get(`day:${today}`, 'active'),
    todayNew: get(`day:${today}`, 'new'),
    month: get(`month:${today.slice(0, 7)}`, 'active'),
    day: today,
  }
}

/**
 * 全站共用一个实例（idFromName('global')）。Durable Object 单线程执行，计数不会互相覆盖；
 * SQLite 在实例本地，单次上报只需几微秒。
 */
export class UsageStats {
  private readonly sql: SqlLike

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql as unknown as SqlLike
    initSchema(this.sql)
    initDesktopSchema(this.sql)
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === 'POST' && pathname === '/ping') {
      const ping = parsePing(await request.json().catch(() => null))
      if (!ping) return new Response(null, { status: 400 })
      recordPing(this.sql, ping)
      return new Response(null, { status: 204 })
    }
    if (request.method === 'POST' && pathname === '/desktop') {
      const record = parseDesktopRecord(await request.json().catch(() => null))
      if (!record) return new Response(null, { status: 400 })
      recordDesktop(this.sql, record)
      return new Response(null, { status: 204 })
    }
    if (request.method === 'GET' && pathname === '/summary') {
      return Response.json({ ...readSummary(this.sql), desktop: readDesktopSummary(this.sql) })
    }
    return new Response(null, { status: 404 })
  }
}
