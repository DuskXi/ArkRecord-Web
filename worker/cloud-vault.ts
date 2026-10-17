/**
 * 云同步的存储（docs/rewrite/cloud-sync.md 7.3–7.5、7.9–7.11、9.6）：每个账号（locator）一个 Durable Object，SQLite 存储。
 *
 * 只保存：
 *   - verifier = HMAC-SHA256(SYNC_PEPPER, authKey)，用来核对密码派生的 authKey；
 *   - 被用户的 kek 包裹的 DEK，外面再用 SYNC_PEPPER 派生的钥匙加密一层；
 *   - 密文批次（Worker 解不开，只读信封头里的批次号、类型、kid）。
 * 不保存密码、authKey、kek、DEK 明文，也不保存 UID（只有 locator）、IP 或任何鹰角 token。
 *
 * 核对通过之前什么都不给：账号不存在和密码错误返回同样的 401；连续失败 5 次后按账号指数退避，
 * 退避期间不核对密码；失败次数每次都写入存储。开启双重验证的账号，没有核实过鹰角 token 的请求
 * 直接返回 401，不核对密码，也不计失败次数。
 *
 * 表只在开通时才创建：对不存在的账号的请求（例如有人随便试 locator）不写入任何东西，不会留下空的存储。
 *
 * 只能通过 Worker（worker/cloud.ts）访问：Worker 先做同源检查、限速、格式校验和鹰角核实，
 * 再把整理过的内部请求转过来。x-vault-* 内部请求头只由 Worker 生成。
 */
import {
  CLOUD_OPS,
  type CloudOp,
  frame,
  fromBase64Url,
  joinEnvelopes,
  MAX_ACCOUNT_BYTES,
  MAX_BATCHES,
  parseEnvelopeHeader,
  toBase64Url,
  unframe,
  WRAPPED_DEK_BYTES,
} from '../shared/cloud-protocol'

/** Durable Object 的 ctx.storage.sql 中用到的部分（测试时用 node:sqlite 实现） */
export interface VaultSql {
  exec(query: string, ...bindings: (string | number | null | ArrayBuffer)[]): { toArray(): Record<string, unknown>[] }
}

export const LOCATOR_HEADER = 'x-vault-locator'
export const HG_VERIFIED_HEADER = 'x-vault-hg'
export const RESULT_HEADER = 'x-arkrecord-cloud'

/** 连续失败多少次之后开始退避 */
const FREE_ATTEMPTS = 5
const MAX_LOCK_MINUTES = 60

const encoder = new TextEncoder()
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })

export function initVaultSchema(sql: VaultSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL,
    verifier TEXT NOT NULL,
    sealed_dek BLOB NOT NULL,
    kid INTEGER NOT NULL,
    require_hg INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_access_day TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  )`)
  // 除主键外不建索引：索引会额外计入写入行数。AUTOINCREMENT 保证批次号永不重复使用
  sql.exec(`CREATE TABLE IF NOT EXISTS batches (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    size INTEGER NOT NULL,
    blob BLOB NOT NULL
  )`)
}

interface Meta {
  mode: string
  verifier: string
  sealed_dek: Uint8Array
  kid: number
  require_hg: number
  last_access_day: string | null
  fail_count: number
  locked_until: number
}

export interface VaultResult {
  status: number
  body?: BodyInit | null
  headers?: Record<string, string>
}

const json = (status: number, value: object): VaultResult => ({
  status,
  body: JSON.stringify(value),
  headers: { 'content-type': 'application/json' },
})
const fail = (status: number, code: string, extra: Record<string, string> = {}): VaultResult => ({
  status,
  body: JSON.stringify({ error: code }),
  headers: { 'content-type': 'application/json', [RESULT_HEADER]: code, ...extra },
})
const AUTH_FAILED = () => fail(401, 'auth_failed')

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new Error('不是二进制数据')
}
const buffer = (b: Uint8Array): ArrayBuffer => b.slice().buffer

/** 常量时间比较 */
function equal(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** 由 SYNC_PEPPER 派生的服务器端钥匙：verifier 用的 HMAC 钥匙，和给被包裹的 DEK 再加一层的 AES 钥匙 */
export class PepperKeys {
  private constructor(
    private readonly hmac: CryptoKey,
    private readonly ikm: CryptoKey,
  ) {}

  static async create(pepper: string): Promise<PepperKeys> {
    if (pepper.length < 32) throw new Error('SYNC_PEPPER 太短')
    const raw = encoder.encode(pepper)
    const hmac = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
    return new PepperKeys(hmac, ikm)
  }

  async verifier(authKey: Uint8Array): Promise<string> {
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', this.hmac, authKey as Uint8Array<ArrayBuffer>)))
  }

  private sealKey(locator: string): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('arkrecord/cloud-sync/v1/seal'), info: encoder.encode(locator) },
      this.ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  async seal(locator: string, data: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.sealKey(locator), data as Uint8Array<ArrayBuffer>))
    const out = new Uint8Array(12 + ct.length)
    out.set(iv)
    out.set(ct, 12)
    return out
  }

  async unseal(locator: string, sealed: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: sealed.subarray(0, 12) as Uint8Array<ArrayBuffer> },
        await this.sealKey(locator),
        sealed.subarray(12) as Uint8Array<ArrayBuffer>,
      ),
    )
  }
}

export interface VaultDeps {
  sql: VaultSql
  /** 原子执行多条语句（DO 里是 storage.transactionSync） */
  transaction<T>(fn: () => T): T
  /** 删除这个账号的全部存储（DO 里是 storage.deleteAll） */
  wipe(): Promise<void>
  keys: PepperKeys
  locator: string
  now?: () => number
}

/** 不存在的账号：在内存里模拟同样的退避，不写存储，尽量不让人看出账号是否存在 */
interface Ghost {
  failCount: number
  lockedUntil: number
}

export class Vault {
  private readonly now: () => number

  constructor(
    private readonly deps: VaultDeps,
    private readonly ghost: Ghost = { failCount: 0, lockedUntil: 0 },
  ) {
    this.now = deps.now ?? Date.now
  }

  /** 这个账号开通过吗：还没有建表就是没开通（只读 sqlite_master，不写入） */
  private exists(): boolean {
    return this.deps.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0
  }

  private meta(): Meta | null {
    if (!this.exists()) return null
    const row = this.deps.sql.exec('SELECT * FROM meta WHERE id = 1').toArray()[0]
    if (!row) return null
    return { ...(row as unknown as Meta), sealed_dek: bytes(row.sealed_dek) }
  }

  private headSeq(): number {
    const row = this.deps.sql.exec('SELECT MAX(seq) AS head FROM batches').toArray()[0]
    return Number(row?.head ?? 0)
  }

  private lockFor(failCount: number): number {
    return failCount >= FREE_ATTEMPTS ? this.now() + Math.min(2 ** (failCount - FREE_ATTEMPTS), MAX_LOCK_MINUTES) * 60_000 : 0
  }

  private locked(until: number): VaultResult {
    return fail(429, 'locked', { 'retry-after': String(Math.max(1, Math.ceil((until - this.now()) / 1000))) })
  }

  /**
   * 核对 authKey。hgVerified 表示 Worker 已经核实过这个账号的鹰角 token。
   * 返回 Meta 表示通过；否则返回要发给客户端的结果。
   */
  async authenticate(authKeyText: unknown, hgVerified: boolean): Promise<Meta | VaultResult> {
    const meta = this.meta()
    const authKey = fromBase64Url(authKeyText, 32)
    if (!meta) {
      // 不存在的账号：模拟退避，返回与密码错误相同的结果
      if (this.ghost.lockedUntil > this.now()) return this.locked(this.ghost.lockedUntil)
      this.ghost.failCount++
      this.ghost.lockedUntil = this.lockFor(this.ghost.failCount)
      if (authKey) await this.deps.keys.verifier(authKey)
      return AUTH_FAILED()
    }
    // 双重验证：没有核实过鹰角 token 的请求不核对密码，也不计失败次数
    if (meta.require_hg && !hgVerified) return AUTH_FAILED()
    if (meta.locked_until > this.now()) return this.locked(meta.locked_until)
    const ok = authKey !== null && equal(await this.deps.keys.verifier(authKey), meta.verifier)
    if (!ok) {
      const failCount = meta.fail_count + 1
      this.deps.sql.exec('UPDATE meta SET fail_count = ?, locked_until = ? WHERE id = 1', failCount, this.lockFor(failCount))
      return AUTH_FAILED()
    }
    const day = DAY.format(this.now())
    if (meta.fail_count || meta.locked_until || meta.last_access_day !== day) {
      this.deps.sql.exec('UPDATE meta SET fail_count = 0, locked_until = 0, last_access_day = ? WHERE id = 1', day)
    }
    return meta
  }

  /** 下载：返回被包裹的 DEK、kid、双重验证状态，以及 afterSeq 之后的全部批次 */
  async pull(header: Record<string, unknown>, hgVerified: boolean): Promise<VaultResult> {
    const auth = await this.authenticate(header.authKey, hgVerified)
    if (!('verifier' in auth)) return auth
    const afterSeq = Number(header.afterSeq)
    const rows = this.deps.sql.exec('SELECT seq, kind, blob FROM batches WHERE seq > ? ORDER BY seq', afterSeq).toArray()
    const wrappedDek = await this.deps.keys.unseal(this.deps.locator, auth.sealed_dek)
    const meta = {
      kid: auth.kid,
      requireHg: Boolean(auth.require_hg),
      wrappedDek: toBase64Url(wrappedDek),
      headSeq: this.headSeq(),
      /** 云端现有的批次数，浏览器据此决定是否改为上传快照 */
      count: Number(this.deps.sql.exec('SELECT COUNT(*) AS n FROM batches').toArray()[0]!.n),
      batches: rows.map((r) => ({ seq: Number(r.seq), kind: String(r.kind) })),
    }
    return {
      status: 200,
      body: frame(meta, joinEnvelopes(rows.map((r) => bytes(r.blob)))),
      headers: { 'content-type': 'application/octet-stream' },
    }
  }

  /** 上传一批 delta，或者一个合并后的 snapshot（替换 seq ≤ upToSeq 的旧批次） */
  async push(header: Record<string, unknown>, envelope: Uint8Array, hgVerified: boolean): Promise<VaultResult> {
    const auth = await this.authenticate(header.authKey, hgVerified)
    if (!('verifier' in auth)) return auth
    const head = parseEnvelopeHeader(envelope)
    if (!head) return fail(400, 'bad_envelope')
    // kid 不同：云端已经被覆盖、换了钥匙，这台设备需要重新输入密码
    if (head.kid !== auth.kid) return fail(409, 'stale_key')
    const existing = this.deps.sql.exec('SELECT seq FROM batches WHERE batch_id = ?', head.batchId).toArray()[0]
    if (existing) return json(200, { seq: Number(existing.seq), headSeq: this.headSeq(), duplicate: true })

    const stats = this.deps.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM batches').toArray()[0]!
    const count = Number(stats.n)
    const total = Number(stats.total)
    const headSeq = this.headSeq()
    const now = this.now()
    if (head.kind === 'delta') {
      if (header.upToSeq !== undefined) return fail(400, 'bad_request')
      if (count >= MAX_BATCHES) return fail(409, 'compact_required')
      if (total + envelope.length > MAX_ACCOUNT_BYTES) return fail(413, 'quota_exceeded')
      this.deps.sql.exec(
        'INSERT INTO batches (batch_id, kind, created_at, size, blob) VALUES (?, ?, ?, ?, ?)',
        head.batchId,
        'delta',
        now,
        envelope.length,
        buffer(envelope),
      )
    } else {
      const upToSeq = header.upToSeq
      if (typeof upToSeq !== 'number' || upToSeq > headSeq) return fail(400, 'bad_request')
      const kept = Number(this.deps.sql.exec('SELECT COALESCE(SUM(size), 0) AS kept FROM batches WHERE seq > ?', upToSeq).toArray()[0]!.kept)
      if (kept + envelope.length > MAX_ACCOUNT_BYTES) return fail(413, 'quota_exceeded')
      this.deps.transaction(() => {
        this.deps.sql.exec(
          'INSERT INTO batches (batch_id, kind, created_at, size, blob) VALUES (?, ?, ?, ?, ?)',
          head.batchId,
          'snapshot',
          now,
          envelope.length,
          buffer(envelope),
        )
        this.deps.sql.exec('DELETE FROM batches WHERE seq <= ?', upToSeq)
      })
    }
    const seq = Number(this.deps.sql.exec('SELECT seq FROM batches WHERE batch_id = ?', head.batchId).toArray()[0]!.seq)
    return json(200, { seq, headSeq: Math.max(seq, this.headSeq()) })
  }

  /** 开通 / 覆盖：只有 Worker 核实过鹰角 token 才能执行。删除旧的全部批次，换上新的钥匙，写入完整快照 */
  async claim(header: Record<string, unknown>, envelope: Uint8Array, hgVerified: boolean): Promise<VaultResult> {
    if (!hgVerified) return fail(403, 'hg_required')
    const authKey = fromBase64Url(header.authKey, 32)
    const wrappedDek = fromBase64Url(header.wrappedDek, WRAPPED_DEK_BYTES)
    const kid = header.kid
    if (!authKey || !wrappedDek || typeof kid !== 'number' || typeof header.requireHg !== 'boolean') return fail(400, 'bad_request')
    const head = parseEnvelopeHeader(envelope)
    if (!head || head.kind !== 'snapshot' || head.kid !== kid) return fail(400, 'bad_envelope')
    if (envelope.length > MAX_ACCOUNT_BYTES) return fail(413, 'quota_exceeded')
    const verifier = await this.deps.keys.verifier(authKey)
    const sealed = await this.deps.keys.seal(this.deps.locator, wrappedDek)
    const now = this.now()
    initVaultSchema(this.deps.sql)
    this.deps.transaction(() => {
      this.deps.sql.exec('DELETE FROM batches')
      this.deps.sql.exec('DELETE FROM meta')
      this.deps.sql.exec(
        `INSERT INTO meta (id, mode, verifier, sealed_dek, kid, require_hg, created_at, last_access_day, fail_count, locked_until)
         VALUES (1, 'password', ?, ?, ?, ?, ?, ?, 0, 0)`,
        verifier,
        buffer(sealed),
        kid,
        header.requireHg ? 1 : 0,
        now,
        DAY.format(now),
      )
      this.deps.sql.exec(
        'INSERT INTO batches (batch_id, kind, created_at, size, blob) VALUES (?, ?, ?, ?, ?)',
        head.batchId,
        'snapshot',
        now,
        envelope.length,
        buffer(envelope),
      )
    })
    this.ghost.failCount = 0
    this.ghost.lockedUntil = 0
    return json(200, { seq: this.headSeq(), headSeq: this.headSeq() })
  }

  /** 知道旧密码时改密码：只换 verifier 和包裹，不用重新上传数据 */
  async rekey(header: Record<string, unknown>, hgVerified: boolean): Promise<VaultResult> {
    const auth = await this.authenticate(header.authKey, hgVerified)
    if (!('verifier' in auth)) return auth
    const newAuthKey = fromBase64Url(header.newAuthKey, 32)
    const wrappedDek = fromBase64Url(header.wrappedDek, WRAPPED_DEK_BYTES)
    if (!newAuthKey || !wrappedDek) return fail(400, 'bad_request')
    const verifier = await this.deps.keys.verifier(newAuthKey)
    const sealed = await this.deps.keys.seal(this.deps.locator, wrappedDek)
    this.deps.sql.exec('UPDATE meta SET verifier = ?, sealed_dek = ? WHERE id = 1', verifier, buffer(sealed))
    return json(200, { ok: true })
  }

  /** 开启或关闭鹰角 token 双重验证：两样证明都要有 */
  async twoFactor(header: Record<string, unknown>, hgVerified: boolean): Promise<VaultResult> {
    if (!hgVerified) return fail(403, 'hg_required')
    if (typeof header.requireHg !== 'boolean') return fail(400, 'bad_request')
    const auth = await this.authenticate(header.authKey, hgVerified)
    if (!('verifier' in auth)) return auth
    this.deps.sql.exec('UPDATE meta SET require_hg = ? WHERE id = 1', header.requireHg ? 1 : 0)
    return json(200, { requireHg: header.requireHg })
  }

  /** 删除这个账号的全部云端数据：需要 authKey；忘记密码时用核实过的鹰角 token */
  async remove(header: Record<string, unknown>, hgVerified: boolean): Promise<VaultResult> {
    if (!hgVerified) {
      const auth = await this.authenticate(header.authKey, hgVerified)
      if (!('verifier' in auth)) return auth
    }
    await this.deps.wipe()
    this.ghost.failCount = 0
    this.ghost.lockedUntil = 0
    return { status: 204 }
  }

  async handle(op: CloudOp, header: Record<string, unknown>, payload: Uint8Array, hgVerified: boolean): Promise<VaultResult> {
    switch (op) {
      case 'pull':
        return this.pull(header, hgVerified)
      case 'push':
        return this.push(header, payload, hgVerified)
      case 'claim':
        return this.claim(header, payload, hgVerified)
      case 'rekey':
        return this.rekey(header, hgVerified)
      case 'twofactor':
        return this.twoFactor(header, hgVerified)
      case 'delete':
        return this.remove(header, hgVerified)
    }
  }
}

interface VaultEnv {
  SYNC_PEPPER?: string
}

export class CloudVault {
  private readonly state: DurableObjectState
  private readonly env: VaultEnv
  private keys: Promise<PepperKeys> | null = null
  private readonly ghost: Ghost = { failCount: 0, lockedUntil: 0 }

  constructor(state: DurableObjectState, env: VaultEnv) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const op = new URL(request.url).pathname.slice(1) as CloudOp
    const locator = request.headers.get(LOCATOR_HEADER)
    const framed = unframe(new Uint8Array(await request.arrayBuffer()))
    if (request.method !== 'POST' || !CLOUD_OPS.includes(op) || !locator || !framed || !this.env.SYNC_PEPPER) {
      return new Response(null, { status: 400 })
    }
    this.keys ??= PepperKeys.create(this.env.SYNC_PEPPER)
    const storage = this.state.storage
    const vault = new Vault(
      {
        sql: storage.sql as unknown as VaultSql,
        transaction: (fn) => storage.transactionSync(fn),
        // 删除后不再建表：不留下任何存储，Cloudflare 会自动清理这个对象
        wipe: () => storage.deleteAll(),
        keys: await this.keys,
        locator,
      },
      this.ghost,
    )
    const result = await vault.handle(op, framed.header, framed.payload, request.headers.get(HG_VERIFIED_HEADER) === '1')
    return new Response(result.body ?? null, { status: result.status, headers: result.headers })
  }
}
