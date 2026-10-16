/**
 * 站内反馈（Durable Object + SQLite），给不方便使用 GitHub Issues 的用户。网站会先引导用户去 GitHub。
 *
 * 目前只做收集：
 *   - 用户提交后得到反馈编号（id）和凭证（token），两者只保存在用户自己的浏览器里，不同步；
 *   - 服务端只保存 token 的 SHA-256，用来以后核对查询的人是不是提交者本人；
 *   - 只保存用户填写的内容（类型、正文、可选的联系方式）和网站版本、当前游戏，不保存 IP、UA、账号或 UID。
 *
 * 已经预留、还没有实现的部分（以后补上即可，表结构不用改）：
 *   - 用户查看处理状态和回复：GET /api/feedback/{id}，请求头 x-feedback-token，核对 token_hash 后返回 status / reply；
 *   - 作者查看和回复：另设管理员密钥（wrangler secret），按 status 列出反馈，写入 status / reply / replied_at。
 */

export const FEEDBACK_PREFIX = '/api/feedback'
export const FEEDBACK_CATEGORIES = ['bug', 'suggestion', 'data', 'other'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
const GAMES = ['arknights', 'endfield'] as const

export const MAX_MESSAGE_LENGTH = 2000
export const MAX_CONTACT_LENGTH = 200
const MIN_MESSAGE_LENGTH = 4

export interface FeedbackInput {
  category: FeedbackCategory
  message: string
  contact: string | null
  appVersion: string | null
  game: (typeof GAMES)[number] | null
}

/** 只接受白名单内的字段和取值，其他内容一律丢弃 */
export function parseFeedback(body: unknown): FeedbackInput | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (!(FEEDBACK_CATEGORIES as readonly unknown[]).includes(b.category)) return null
  if (typeof b.message !== 'string') return null
  const message = b.message.trim()
  if (message.length < MIN_MESSAGE_LENGTH || message.length > MAX_MESSAGE_LENGTH) return null
  let contact: string | null = null
  if (b.contact !== undefined && b.contact !== null) {
    if (typeof b.contact !== 'string' || b.contact.length > MAX_CONTACT_LENGTH) return null
    contact = b.contact.trim() || null
  }
  const appVersion = typeof b.appVersion === 'string' && /^[\w.+-]{1,32}$/.test(b.appVersion) ? b.appVersion : null
  const game = (GAMES as readonly unknown[]).includes(b.game) ? (b.game as FeedbackInput['game']) : null
  return { category: b.category as FeedbackCategory, message, contact, appVersion, game }
}

// ───────────── 编号与凭证 ─────────────

/** Crockford Base32，去掉了容易看错的 I、L、O、U */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 反馈编号，例如 FB-7K2MQ-9QXD4（50 位随机数），方便用户抄写 */
export function newFeedbackId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('')
  return `FB-${chars.slice(0, 5)}-${chars.slice(5)}`
}

/** 凭证：32 字节随机数，base64url */
export function newFeedbackToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ───────────── 存储 ─────────────

/** Durable Object 的 ctx.storage.sql 中用到的部分（测试时用 node:sqlite 实现） */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] }
}

export function initFeedbackSchema(sql: SqlLike): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    contact TEXT,
    app_version TEXT,
    game TEXT,
    -- 以下为作者端预留：处理状态（new / read / replied / closed）与回复
    status TEXT NOT NULL DEFAULT 'new',
    reply TEXT,
    replied_at INTEGER
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS feedback_status ON feedback (status, created_at)')
}

export interface FeedbackRecord extends FeedbackInput {
  id: string
  tokenHash: string
  createdAt: number
}

/** 写入一条反馈；编号已存在时返回 false（调用方换一个编号重试） */
export function insertFeedback(sql: SqlLike, record: FeedbackRecord): boolean {
  if (sql.exec('SELECT 1 FROM feedback WHERE id = ?', record.id).toArray().length) return false
  sql.exec(
    'INSERT INTO feedback (id, token_hash, created_at, category, message, contact, app_version, game) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    record.id,
    record.tokenHash,
    record.createdAt,
    record.category,
    record.message,
    record.contact,
    record.appVersion,
    record.game,
  )
  return true
}

function isRecord(value: unknown): value is FeedbackRecord {
  const r = value as FeedbackRecord | null
  return Boolean(
    r && typeof r.id === 'string' && /^FB-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(r.id) && typeof r.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(r.tokenHash),
  )
}

/** 全站共用一个实例（idFromName('global')），反馈量很小，单个 SQLite 足够 */
export class FeedbackStore {
  private readonly sql: SqlLike

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql as unknown as SqlLike
    initFeedbackSchema(this.sql)
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === 'POST' && pathname === '/submit') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      const input = parseFeedback(body)
      if (!input || !isRecord(body)) return new Response(null, { status: 400 })
      const record: FeedbackRecord = { ...input, id: body.id, tokenHash: body.tokenHash, createdAt: Date.now() }
      return new Response(null, { status: insertFeedback(this.sql, record) ? 201 : 409 })
    }
    // 预留：GET /status（用户查看回复）、GET /list 与 POST /reply（作者端），见文件开头的说明
    return new Response(null, { status: 404 })
  }
}
