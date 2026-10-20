/**
 * 云同步协议中浏览器和 Worker 都要用到的部分（docs/rewrite/cloud-sync.md 6、9.4、9.5、11）。
 * 只用 Web 标准 API（TextEncoder、crypto.subtle），两边运行同一份代码，保证计算结果一致。
 *
 * 这个文件不接触任何鹰角 token：核实鹰角 token 的代码只在 worker/hg-verify.ts。
 */

export const PROTOCOL_VERSION = 1
/**
 * 云端数据（加密前）的格式版本，见 src/lib/cloud/codec.ts。服务器不解密，但网页和 Worker 一起部署：
 * /info 的 dataFormat 告诉客户端“这个网站的网页能读到哪个版本”，客户端不写更新的版本（engine.ts 的 siteDataFormat），
 * 免得这个网站上还没更新的网页读不了（桌面版同步到正式站时就是这样）。
 */
export const DATA_FORMAT_VERSION = 3
export const CLOUD_PREFIX = '/api/cloud/v1/'
export const CLOUD_OPS = ['status', 'claim', 'pull', 'push', 'rekey', 'twofactor', 'delete'] as const
export type CloudOp = (typeof CLOUD_OPS)[number]

/**
 * password：密码模式（推荐），数据只有密码能解开；
 * hg：无密码模式（不推荐），每个请求都要核实鹰角 token，钥匙由服务器派生，服务器技术上能解密（cloud-sync.md 8）
 */
export const CLOUD_MODES = ['password', 'hg'] as const
export type CloudMode = (typeof CLOUD_MODES)[number]

export const GAMES = ['arknights', 'endfield'] as const
export type CloudGame = (typeof GAMES)[number]

/** 请求头部 JSON 的上限 */
export const MAX_HEADER_BYTES = 1024
/** 单个信封（一批密文）的上限：DO SQLite 单行上限是 2 MB */
export const MAX_ENVELOPE_BYTES = 1024 * 1024
/** 每个账号的云端总量上限（防滥用） */
export const MAX_ACCOUNT_BYTES = 4 * 1024 * 1024
/** 批次数达到这个值时，必须先合并成快照才能继续上传 */
export const MAX_BATCHES = 32
/** 浏览器在批次数超过这个值时，主动改为上传快照 */
export const COMPACT_AT = 16
/** 一次下载最多返回的密文字节数，超过就分页 */
export const MAX_PULL_BYTES = 4 * 1024 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

// ───────────── base64url ─────────────

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** 只接受规范的 base64url（无填充、末尾多余的位为 0）；不合法时返回 null */
export function fromBase64Url(text: unknown, expectedLength?: number): Uint8Array | null {
  if (typeof text !== 'string' || !/^[\w-]*$/.test(text) || text.length % 4 === 1) return null
  let bytes: Uint8Array
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  if (toBase64Url(bytes) !== text) return null
  if (expectedLength !== undefined && bytes.length !== expectedLength) return null
  return bytes
}

// ───────────── 账号标识 ─────────────

function labelled(label: string, ...parts: string[]): Uint8Array<ArrayBuffer> {
  return encoder.encode([label, ...parts].join('\u0000')) as Uint8Array<ArrayBuffer>
}

export function isGame(value: unknown): value is CloudGame {
  return (GAMES as readonly unknown[]).includes(value)
}

/** UID：鹰角接口返回的是数字（以字符串保存），这里放宽到常见字符，长度有限 */
export function isUid(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,32}$/.test(value)
}

/** locator = base64url(SHA-256("arkrecord/cloud-sync/v1/locator" ‖ 0x00 ‖ game ‖ 0x00 ‖ uid))，只是假名，不是秘密 */
export async function computeLocator(game: CloudGame, uid: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', labelled('arkrecord/cloud-sync/v1/locator', game, uid))
  return toBase64Url(new Uint8Array(digest))
}

export function isLocator(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{43}$/.test(value)
}

/** 盐 = SHA-256("arkrecord/cloud-sync/v1/salt" ‖ 0x00 ‖ game ‖ 0x00 ‖ uid)：在本地算出，不经过服务器 */
export async function computeSalt(game: CloudGame, uid: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', labelled('arkrecord/cloud-sync/v1/salt', game, uid)))
}

// ───────────── 请求 / 响应的二进制格式：[2 字节头部长度][头部 JSON][数据] ─────────────

export function frame(header: object, payload: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
  const head = encoder.encode(JSON.stringify(header))
  if (head.length > 0xffff) throw new Error('头部太长')
  const out = new Uint8Array(2 + head.length + payload.length)
  new DataView(out.buffer).setUint16(0, head.length)
  out.set(head, 2)
  out.set(payload, 2 + head.length)
  return out
}

export function unframe(bytes: Uint8Array, maxHeader = MAX_HEADER_BYTES): { header: Record<string, unknown>; payload: Uint8Array } | null {
  if (bytes.length < 2) return null
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0)
  if (length > maxHeader || 2 + length > bytes.length) return null
  let header: unknown
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(2, 2 + length)))
  } catch {
    return null
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) return null
  return { header: header as Record<string, unknown>, payload: bytes.subarray(2 + length) }
}

/** 多个信封拼在一起：每个前面带 4 字节长度 */
export function joinEnvelopes(blobs: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(blobs.reduce((n, b) => n + 4 + b.length, 0))
  const view = new DataView(out.buffer)
  let at = 0
  for (const b of blobs) {
    view.setUint32(at, b.length)
    out.set(b, at + 4)
    at += 4 + b.length
  }
  return out
}

export function splitEnvelopes(bytes: Uint8Array): Uint8Array[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Uint8Array[] = []
  let at = 0
  while (at < bytes.length) {
    if (at + 4 > bytes.length) return null
    const length = view.getUint32(at)
    if (at + 4 + length > bytes.length) return null
    out.push(bytes.subarray(at + 4, at + 4 + length))
    at += 4 + length
  }
  return out
}

// ───────────── 信封头：版本 1 B + kid 1 B + 类型 1 B + batchId 16 B + IV 12 B ─────────────

export const ENVELOPE_VERSION = 1
export const ENVELOPE_HEADER_BYTES = 31
export const ENVELOPE_KIND = { delta: 1, snapshot: 2 } as const
export type EnvelopeKind = keyof typeof ENVELOPE_KIND
/** AES-GCM 认证标签 */
const TAG_BYTES = 16

export interface EnvelopeHeader {
  version: number
  kid: number
  kind: EnvelopeKind
  batchId: string
  iv: Uint8Array
}

/** Worker 只读信封头（批次号、类型、kid），解不开密文 */
export function parseEnvelopeHeader(bytes: Uint8Array): EnvelopeHeader | null {
  if (bytes.length < ENVELOPE_HEADER_BYTES + TAG_BYTES || bytes[0] !== ENVELOPE_VERSION) return null
  const kind = bytes[2] === ENVELOPE_KIND.delta ? 'delta' : bytes[2] === ENVELOPE_KIND.snapshot ? 'snapshot' : null
  if (!kind) return null
  return {
    version: bytes[0],
    kid: bytes[1]!,
    kind,
    batchId: toBase64Url(bytes.subarray(3, 19)),
    iv: bytes.subarray(19, 31),
  }
}

/** 密文的附加认证数据：绑定协议、locator 和整个信封头，服务器不能把别的账号或别的批次的密文冒充成这一批 */
export function envelopeAad(locator: string, header: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`arkrecord/cloud-sync/v1\u0000${locator}\u0000`)
  const out = new Uint8Array(prefix.length + header.length)
  out.set(prefix)
  out.set(header, prefix.length)
  return out
}

/** 包裹 DEK 时的附加认证数据：绑定 locator 和 kid */
export function dekAad(locator: string, kid: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(`arkrecord/cloud-sync/v1/dek\u0000${locator}\u0000${kid}`) as Uint8Array<ArrayBuffer>
}

/** 被 kek 包裹的 DEK：IV 12 B + 密文 32 B + 标签 16 B */
export const WRAPPED_DEK_BYTES = 60
/** authKey 32 B */
export const AUTH_KEY_BYTES = 32
/** 无密码模式由服务器派生、用来包裹 DEK 的钥匙 KEK_hg：32 B */
export const HG_KEK_BYTES = 32
