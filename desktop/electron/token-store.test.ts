import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Cipher, TOKEN_FILE, TokenStore, isAccountId, isToken, parseTokenFile, serializeTokenFile } from './token-store.js'

/** 假的加密：前面加一个标记再逐字节异或；没有标记的解不开（模拟钥匙串变了） */
const xor = (data: Uint8Array) => Buffer.from(data.map((byte) => byte ^ 0x5a))
const fakeCipher: Cipher = {
  encrypt: (text) => xor(Buffer.from(`enc:${text}`)),
  decrypt: (data) => {
    const text = xor(data).toString()
    if (!text.startsWith('enc:')) throw new Error('decrypt failed')
    return text.slice(4)
  },
}

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'arkrecord-tokens-'))
  path = join(dir, TOKEN_FILE)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('校验', () => {
  it('accountId 只能是 arknights / endfield 加 uid', () => {
    expect(isAccountId('arknights:12345678')).toBe(true)
    expect(isAccountId('endfield:abc_DEF-1')).toBe(true)
    for (const id of ['genshin:1', 'arknights:', 'arknights:a b', `arknights:${'1'.repeat(65)}`, 'arknights:1/../x', 1, null]) {
      expect(isAccountId(id)).toBe(false)
    }
  })

  it('token 只能是可见 ASCII，最长 4096', () => {
    expect(isToken('Abc+/=._-~')).toBe(true)
    expect(isToken('x'.repeat(4096))).toBe(true)
    for (const token of ['', 'a b', 'a\nb', '中文', 'x'.repeat(4097), 1, undefined]) expect(isToken(token)).toBe(false)
  })
})

describe('文件格式', () => {
  it('只留下格式对的条目，坏文件当作空的', () => {
    const entries = parseTokenFile(
      JSON.stringify({ version: 1, entries: { 'arknights:1': 'QUJD', 'genshin:1': 'QUJD', 'endfield:2': 'not base64!', 'endfield:3': 1 } }),
    )
    expect([...entries]).toEqual([['arknights:1', 'QUJD']])
    expect(parseTokenFile('{').size).toBe(0)
    expect(parseTokenFile(JSON.stringify({ version: 2, entries: { 'arknights:1': 'QUJD' } })).size).toBe(0)
    expect(parseTokenFile('null').size).toBe(0)
  })

  it('写出来的格式能读回去', () => {
    const entries = new Map([['arknights:1', 'QUJD']])
    expect(JSON.parse(serializeTokenFile(entries))).toEqual({ version: 1, entries: { 'arknights:1': 'QUJD' } })
    expect(parseTokenFile(serializeTokenFile(entries))).toEqual(entries)
  })
})

describe('TokenStore', () => {
  it('保存、读回、删除；文件里只有密文', async () => {
    const store = new TokenStore(path, fakeCipher)
    expect(await store.load()).toEqual({})
    await store.save('arknights:1', 'token-one')
    await store.save('endfield:2', 'token-two')
    expect(await store.load()).toEqual({ 'arknights:1': 'token-one', 'endfield:2': 'token-two' })

    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('token-one')
    expect(raw).not.toContain('token-two')

    await store.delete('arknights:1')
    expect(await store.load()).toEqual({ 'endfield:2': 'token-two' })
    await store.delete('endfield:2')
    // 一条都不剩时删掉文件
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    // 删除不存在的账号不出错
    await store.delete('endfield:2')
  })

  it('同时保存几个账号不会互相覆盖', async () => {
    const store = new TokenStore(path, fakeCipher)
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.save(`arknights:${i}`, `token-${i}`)))
    expect(Object.keys(await store.load())).toHaveLength(10)
  })

  it('解不开的条目丢掉，并从文件里删掉', async () => {
    await writeFile(path, serializeTokenFile(new Map([['arknights:1', Buffer.from('garbage').toString('base64')]])))
    const store = new TokenStore(path, fakeCipher)
    await store.save('endfield:2', 'token-two')
    expect(await store.load()).toEqual({ 'endfield:2': 'token-two' })
    expect(parseTokenFile(await readFile(path, 'utf8')).has('arknights:1')).toBe(false)
  })

  it('格式不对的 accountId 和 token 不保存，报错里不带 token', async () => {
    const store = new TokenStore(path, fakeCipher)
    await expect(store.save('genshin:1', 'token-x')).rejects.toThrow()
    const error = (await store.save('arknights:1', 'secret value').catch((reason: unknown) => reason)) as Error
    expect(error.message).not.toContain('secret')
    await expect(store.delete('../x')).rejects.toThrow()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('文件权限是 0600', async () => {
    const store = new TokenStore(path, fakeCipher)
    await store.save('arknights:1', 'token-one')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
