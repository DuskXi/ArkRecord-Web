/**
 * 云同步的密钥与密文（docs/rewrite/cloud-sync.md 5、7.1、9.4）。全部在浏览器里完成，密码、kek、DEK 明文都不离开浏览器。
 *
 *   salt      = SHA-256("arkrecord/cloud-sync/v1/salt" ‖ 0 ‖ game ‖ 0 ‖ uid)      本地算出，不经过服务器
 *   stretched = Argon2id(NFC(password), salt, ARGON2_V1)
 *   authKey   = HKDF(salt, stretched, "arkrecord/cloud-sync/v1/auth")            发给服务器证明所有权
 *   kek       = HKDF(salt, stretched, "arkrecord/cloud-sync/v1/kek")             包裹 DEK，不可导出
 *
 * 每个云端账号一把随机的 DEK（AES-256-GCM），所有记录用它加密后才上传。
 */
import { deflateSync, inflateSync } from 'fflate'
import {
  type CloudGame,
  computeSalt,
  dekAad,
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_KIND,
  ENVELOPE_VERSION,
  envelopeAad,
  type EnvelopeHeader,
  type EnvelopeKind,
  parseEnvelopeHeader,
  WRAPPED_DEK_BYTES,
} from '../../../shared/cloud-protocol'
import { argon2id, type Argon2Impl } from './argon2'
import type { KdfResponse } from './kdf.worker'

const encoder = new TextEncoder()

export class CloudCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudCryptoError'
  }
}

// ───────────── 密码 → authKey、kek ─────────────

export interface PasswordKeys {
  authKey: Uint8Array
  kek: CryptoKey
  impl: Argon2Impl
}

/** 在 Web Worker 里算 Argon2id；浏览器不支持模块 Worker 时退回到页面里直接算 */
function stretchInWorker(password: Uint8Array, salt: Uint8Array, onProgress?: (fraction: number) => void) {
  return new Promise<{ hash: Uint8Array; impl: Argon2Impl }>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      argon2id(password, salt, undefined, onProgress).then(resolve, reject)
      return
    }
    worker.addEventListener('message', (event: MessageEvent<KdfResponse>) => {
      const msg = event.data
      if (msg.type === 'progress') onProgress?.(msg.fraction)
      else {
        worker.terminate()
        if (msg.type === 'done') resolve({ hash: msg.hash, impl: msg.impl })
        else reject(new CloudCryptoError(msg.message))
      }
    })
    // Worker 本身加载失败（例如被浏览器策略禁止）：退回到页面里直接算
    worker.addEventListener('error', () => {
      worker.terminate()
      argon2id(password, salt, undefined, onProgress).then(resolve, reject)
    })
    // 这是 Web Worker 的 postMessage，没有 targetOrigin 参数
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage({ password, salt })
  })
}

/** 由 Argon2id 的结果派生 authKey 和 kek（HKDF-SHA256：先以盐提取，再按用途扩展） */
export async function keysFromStretched(stretched: Uint8Array, salt: Uint8Array): Promise<{ authKey: Uint8Array; kek: CryptoKey }> {
  const ikm = await crypto.subtle.importKey('raw', stretched as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits', 'deriveKey'])
  const params = (info: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, info: encoder.encode(info) })
  const authKey = new Uint8Array(await crypto.subtle.deriveBits(params('arkrecord/cloud-sync/v1/auth'), ikm, 256))
  const kek = await crypto.subtle.deriveKey(params('arkrecord/cloud-sync/v1/kek'), ikm, { name: 'AES-GCM', length: 256 }, false, [
    'wrapKey',
    'unwrapKey',
  ])
  return { authKey, kek }
}

/** 由密码派生 authKey 和 kek。密码先做 Unicode NFC 规范化，避免不同设备的输入法产生不同的字节 */
export async function passwordKeys(
  game: CloudGame,
  uid: string,
  password: string,
  options: { onProgress?: (fraction: number) => void; inline?: boolean } = {},
): Promise<PasswordKeys> {
  const salt = await computeSalt(game, uid)
  const pw = encoder.encode(password.normalize('NFC'))
  const { hash, impl } = options.inline || typeof Worker === 'undefined'
    ? await argon2id(pw, salt, undefined, options.onProgress)
    : await stretchInWorker(pw, salt, options.onProgress)
  return { ...(await keysFromStretched(hash, salt)), impl }
}

// ───────────── DEK ─────────────

/** 新的 DEK：只在开通 / 覆盖时生成一次，可导出只是为了用 kek 包裹 */
export function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/** kid：DEK 的编号（1–255），写在每个信封头里，用来发现“云端已经换了钥匙” */
export function randomKid(): number {
  return 1 + (crypto.getRandomValues(new Uint8Array(1))[0]! % 255)
}

/** 用 kek 包裹 DEK：IV 12 B + 密文；附加认证数据绑定 locator 和 kid */
export async function wrapDek(dek: CryptoKey, kek: CryptoKey, locator: string, kid: number): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, additionalData: dekAad(locator, kid) }))
  const out = new Uint8Array(12 + wrapped.length)
  out.set(iv)
  out.set(wrapped, 12)
  return out
}

/** 无密码模式：服务器给的 KEK_hg（32 字节）→ 用来包裹、解开 DEK 的钥匙（不可导出） */
export async function hgKekKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new CloudCryptoError('服务器给的钥匙格式不对')
  return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'])
}

/** 解开 DEK；默认不可导出（存进 IndexedDB 后，页面脚本也读不出它的原始字节） */
export async function unwrapDek(wrapped: Uint8Array, kek: CryptoKey, locator: string, kid: number, extractable = false): Promise<CryptoKey> {
  if (wrapped.length !== WRAPPED_DEK_BYTES) throw new CloudCryptoError('云端的钥匙格式不对')
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      wrapped.subarray(12) as Uint8Array<ArrayBuffer>,
      kek,
      { name: 'AES-GCM', iv: wrapped.subarray(0, 12) as Uint8Array<ArrayBuffer>, additionalData: dekAad(locator, kid) },
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt'],
    )
  } catch {
    throw new CloudCryptoError('密码不对，或者云端的钥匙已经更换')
  }
}

// ───────────── 信封：压缩 → 长度前缀 + Padmé 填充 → AES-GCM ─────────────

/**
 * Padmé 填充（Nikitin 等，2019）：只把长度向上取整到少数几个有效位，额外开销不超过 12%，
 * 服务器只能看到大致大小。
 */
export function padme(length: number): number {
  if (!Number.isInteger(length) || length < 0 || length >= 2 ** 31) throw new CloudCryptoError('长度不对')
  if (length < 3) return length
  const e = 31 - Math.clz32(length) // floor(log2(length))
  const s = 32 - Math.clz32(e) // floor(log2(e)) + 1
  const unit = 2 ** (e - s)
  return Math.ceil(length / unit) * unit
}

function frameCompressed(compressed: Uint8Array): Uint8Array<ArrayBuffer> {
  const total = padme(4 + compressed.length)
  const out = new Uint8Array(total)
  new DataView(out.buffer).setUint32(0, compressed.length)
  out.set(compressed, 4)
  return out
}

function unframeCompressed(framed: Uint8Array): Uint8Array {
  if (framed.length < 4) throw new CloudCryptoError('密文格式不对')
  const length = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(0)
  if (4 + length > framed.length || padme(4 + length) !== framed.length) throw new CloudCryptoError('密文长度不对')
  for (let i = 4 + length; i < framed.length; i++) if (framed[i] !== 0) throw new CloudCryptoError('密文填充不对')
  return framed.subarray(4, 4 + length)
}

/** 新的批次号：16 字节随机数 */
export function newBatchId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

/** 加密一批明文，返回信封（信封头 + 密文）。batchId 由调用方给出，重试时用同一个，服务器据此去重 */
export async function sealEnvelope(
  dek: CryptoKey,
  locator: string,
  kid: number,
  kind: EnvelopeKind,
  plaintext: Uint8Array,
  batchId: Uint8Array = newBatchId(),
): Promise<Uint8Array> {
  if (batchId.length !== 16) throw new CloudCryptoError('批次号长度不对')
  const header = new Uint8Array(ENVELOPE_HEADER_BYTES)
  header[0] = ENVELOPE_VERSION
  header[1] = kid
  header[2] = ENVELOPE_KIND[kind]
  header.set(batchId, 3)
  header.set(crypto.getRandomValues(new Uint8Array(12)), 19)
  const framed = frameCompressed(deflateSync(plaintext, { level: 9 }))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: header.subarray(19, 31), additionalData: envelopeAad(locator, header) }, dek, framed),
  )
  const out = new Uint8Array(header.length + ciphertext.length)
  out.set(header)
  out.set(ciphertext, header.length)
  return out
}

/** 解开信封：任何一位被改动（包括信封头、或者换成别的账号的密文）都会失败 */
export async function openEnvelope(dek: CryptoKey, locator: string, envelope: Uint8Array): Promise<{ header: EnvelopeHeader; plaintext: Uint8Array }> {
  const header = parseEnvelopeHeader(envelope)
  if (!header) throw new CloudCryptoError('不认识的密文格式')
  let framed: Uint8Array
  try {
    framed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: header.iv as Uint8Array<ArrayBuffer>, additionalData: envelopeAad(locator, envelope.subarray(0, ENVELOPE_HEADER_BYTES)) },
        dek,
        envelope.subarray(ENVELOPE_HEADER_BYTES) as Uint8Array<ArrayBuffer>,
      ),
    )
  } catch {
    throw new CloudCryptoError('密文校验失败：数据被改动过，或者钥匙不对')
  }
  try {
    return { header, plaintext: inflateSync(unframeCompressed(framed)) }
  } catch (error) {
    throw error instanceof CloudCryptoError ? error : new CloudCryptoError('解压失败')
  }
}
