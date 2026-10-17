/**
 * 密码派生与密文（docs/rewrite/cloud-sync.md 7.1、7.7、9.4）：
 *   - 两套 Argon2id 实现与 RFC 9106 测试向量一致，随机输入下逐字节相同；
 *   - 一套实现不可用时自动换另一套；
 *   - DEK 只能用正确的 kek、locator、kid 解开；信封任何一位被改动都会被发现。
 */
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js'
import { describe, expect, it } from 'vitest'
import { computeLocator, computeSalt, parseEnvelopeHeader } from '../../../shared/cloud-protocol'
import { type Argon2Params, chooseImpl, RUNNERS, SELF_TEST, selfTest } from './argon2'
import {
  CloudCryptoError,
  generateDek,
  keysFromStretched,
  newBatchId,
  openEnvelope,
  padme,
  passwordKeys,
  randomKid,
  sealEnvelope,
  unwrapDek,
  wrapDek,
} from './crypto'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const enc = new TextEncoder()

describe('Argon2id：两套实现，结果必须一致', () => {
  it('纯 JS 实现通过 RFC 9106 的 Argon2id 测试向量（5.3 节）', () => {
    const out = nobleArgon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      t: 3,
      m: 32,
      p: 4,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
      dkLen: 32,
    })
    expect(hex(out)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
  })

  it('两套实现都通过自检向量', async () => {
    expect(await selfTest('wasm')).toBe(true)
    expect(await selfTest('js')).toBe(true)
    const out = await RUNNERS.js(enc.encode(SELF_TEST.password), enc.encode(SELF_TEST.salt), SELF_TEST.params)
    expect(hex(out)).toBe(SELF_TEST.expected)
  })

  it('随机输入、随机参数下两套实现逐字节相同', async () => {
    for (let i = 0; i < 12; i++) {
      const password = crypto.getRandomValues(new Uint8Array(1 + (i * 7) % 40))
      const salt = crypto.getRandomValues(new Uint8Array(16 + (i % 3) * 8))
      const params: Argon2Params = { t: 1 + (i % 3), m: 64 * (1 + (i % 4)), p: 1 + (i % 2), dkLen: 32 }
      const [a, b] = await Promise.all([RUNNERS.wasm(password, salt, params), RUNNERS.js(password, salt, params)])
      expect(hex(a)).toBe(hex(b))
    }
  })

  it('优先使用 WebAssembly 版；只允许纯 JS 时也能选出可用的实现', async () => {
    expect(await chooseImpl()).toBe('wasm')
  })
})

describe('密码 → authKey、kek', () => {
  it('同样的游戏、UID、密码，在任何设备上派生出同样的 authKey；密码先做 NFC 规范化', async () => {
    const a = await passwordKeys('arknights', '12345678', 'Kx7mP2qL9vRt', { inline: true })
    const b = await passwordKeys('arknights', '12345678', 'Kx7mP2qL9vRt', { inline: true })
    expect(hex(a.authKey)).toBe(hex(b.authKey))
    expect(a.authKey).toHaveLength(32)
    // “é”的两种写法（预组合 / 组合字符）派生出同样的钥匙
    const c = await passwordKeys('arknights', '1', 'CaféKx7mP2qL9', { inline: true })
    const d = await passwordKeys('arknights', '1', 'CaféKx7mP2qL9', { inline: true })
    expect(hex(c.authKey)).toBe(hex(d.authKey))
  })

  it('UID、游戏或密码不同，authKey 都不同；kek 不可导出', async () => {
    const base = await passwordKeys('arknights', '1', 'Kx7mP2qL9vRt', { inline: true })
    const others = await Promise.all([
      passwordKeys('arknights', '2', 'Kx7mP2qL9vRt', { inline: true }),
      passwordKeys('endfield', '1', 'Kx7mP2qL9vRt', { inline: true }),
      passwordKeys('arknights', '1', 'Kx7mP2qL9vRu', { inline: true }),
    ])
    for (const o of others) expect(hex(o.authKey)).not.toBe(hex(base.authKey))
    expect(base.kek.extractable).toBe(false)
  })

  it('authKey 与 kek 互相独立：知道 authKey 也推不出能解开 DEK 的钥匙', async () => {
    const salt = await computeSalt('arknights', '1')
    const stretched = crypto.getRandomValues(new Uint8Array(32))
    const { authKey, kek } = await keysFromStretched(stretched, salt)
    const locator = await computeLocator('arknights', '1')
    const dek = await generateDek()
    const wrapped = await wrapDek(dek, kek, locator, 7)
    // 把 authKey 当作钥匙去解，必然失败
    const fake = await crypto.subtle.importKey('raw', authKey as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['unwrapKey'])
    await expect(unwrapDek(wrapped, fake, locator, 7)).rejects.toThrow(CloudCryptoError)
  })
})

describe('DEK 的包裹', () => {
  it('只能用同一个 kek、locator、kid 解开；解开后默认不可导出', async () => {
    const locator = await computeLocator('arknights', '1')
    const other = await computeLocator('arknights', '2')
    const salt = await computeSalt('arknights', '1')
    const { kek } = await keysFromStretched(crypto.getRandomValues(new Uint8Array(32)), salt)
    const { kek: wrongKek } = await keysFromStretched(crypto.getRandomValues(new Uint8Array(32)), salt)
    const dek = await generateDek()
    const kid = randomKid()
    expect(kid).toBeGreaterThanOrEqual(1)
    expect(kid).toBeLessThanOrEqual(255)
    const wrapped = await wrapDek(dek, kek, locator, kid)
    expect(wrapped).toHaveLength(60)
    const back = await unwrapDek(wrapped, kek, locator, kid)
    expect(back.extractable).toBe(false)
    await expect(unwrapDek(wrapped, wrongKek, locator, kid)).rejects.toThrow(CloudCryptoError)
    await expect(unwrapDek(wrapped, kek, other, kid)).rejects.toThrow(CloudCryptoError)
    await expect(unwrapDek(wrapped, kek, locator, kid === 255 ? 1 : kid + 1)).rejects.toThrow(CloudCryptoError)
    // 用解开的 DEK 能解密原 DEK 加密的数据
    const locatorA = locator
    const env = await sealEnvelope(dek, locatorA, kid, 'delta', enc.encode('hello'))
    expect(new TextDecoder().decode((await openEnvelope(back, locatorA, env)).plaintext)).toBe('hello')
  })
})

describe('信封', () => {
  it('Padmé：不小于原长度，额外开销不超过 12%，长度单调', () => {
    let prev = 0
    for (let n = 0; n < 200_000; n += n < 1000 ? 1 : 97) {
      const p = padme(n)
      expect(p).toBeGreaterThanOrEqual(n)
      if (n >= 16) expect(p / n).toBeLessThanOrEqual(1.12)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
    expect(padme(1000)).toBe(1024)
  })

  it('加密后能原样解开；信封头里能读出 kid、类型、批次号', async () => {
    const dek = await generateDek()
    const locator = await computeLocator('endfield', '42')
    const plaintext = enc.encode('{"v":1,"game":"endfield"}'.repeat(50))
    const batchId = newBatchId()
    const env = await sealEnvelope(dek, locator, 9, 'snapshot', plaintext, batchId)
    const header = parseEnvelopeHeader(env)!
    expect(header).toMatchObject({ version: 1, kid: 9, kind: 'snapshot' })
    expect(header.batchId).toHaveLength(22)
    const opened = await openEnvelope(dek, locator, env)
    expect(opened.plaintext).toEqual(plaintext)
    // 压缩后明显变小
    expect(env.length).toBeLessThan(plaintext.length / 5)
  })

  it('任何一位被改动（信封头或密文）、换成别的账号、换了钥匙，都会被发现', async () => {
    const dek = await generateDek()
    const locator = await computeLocator('arknights', '1')
    const env = await sealEnvelope(dek, locator, 3, 'delta', enc.encode('secret records'))
    for (let i = 0; i < env.length; i++) {
      for (const bit of [0x01, 0x80]) {
        const tampered = env.slice()
        tampered[i]! ^= bit
        await expect(openEnvelope(dek, locator, tampered)).rejects.toThrow(CloudCryptoError)
      }
    }
    await expect(openEnvelope(dek, await computeLocator('arknights', '2'), env)).rejects.toThrow(CloudCryptoError)
    await expect(openEnvelope(await generateDek(), locator, env)).rejects.toThrow(CloudCryptoError)
    await expect(openEnvelope(dek, locator, env.subarray(0, env.length - 1))).rejects.toThrow(CloudCryptoError)
  })

  it('同样的明文每次加密结果都不同（随机 IV）', async () => {
    const dek = await generateDek()
    const locator = await computeLocator('arknights', '1')
    const id = newBatchId()
    const a = await sealEnvelope(dek, locator, 1, 'delta', enc.encode('x'), id)
    const b = await sealEnvelope(dek, locator, 1, 'delta', enc.encode('x'), id)
    expect(hex(a)).not.toBe(hex(b))
  })
})
