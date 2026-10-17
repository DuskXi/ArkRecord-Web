/**
 * 同步配置（profile.ts）：记住时密码加密后存在本机，存储里看不到明文；不记住时只在内存里。
 */
import { Dexie } from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PASSWORD = 'Kx7mP2qL9vRtWz4n'

async function fresh() {
  vi.resetModules()
  const deps = (Dexie as unknown as { dependencies: { indexedDB: unknown; IDBKeyRange: unknown } }).dependencies
  deps.indexedDB = new IDBFactory()
  deps.IDBKeyRange = IDBKeyRange
  return { profile: await import('./profile'), db: (await import('../db')).db }
}

let ctx: Awaited<ReturnType<typeof fresh>>
beforeEach(async () => {
  ctx = await fresh()
})

describe('同步配置', () => {
  it('记住：密码加密保存，存储里没有明文，钥匙不可导出；能取回', async () => {
    const { profile, db } = ctx
    expect(await profile.loadProfile()).toBeNull()
    await profile.saveProfile({ mode: 'password', password: PASSWORD, requireHg: true, remember: true })
    const stored = (await db.kv.get('cloudProfile'))!.value as { key: CryptoKey; ciphertext: Uint8Array }
    expect(stored.key.extractable).toBe(false)
    expect(new TextDecoder().decode(stored.ciphertext)).not.toContain(PASSWORD)
    expect(JSON.stringify(stored)).not.toContain(PASSWORD)
    expect(await profile.loadProfile()).toMatchObject({ mode: 'password', password: PASSWORD, requireHg: true, remember: true })
    expect(await profile.profileInfo()).toMatchObject({ mode: 'password', requireHg: true, remember: true })
    expect(await profile.profileInfo()).not.toHaveProperty('password')
  })

  it('不记住：只在内存里，存储里什么都没有', async () => {
    const { profile, db } = ctx
    await profile.saveProfile({ mode: 'password', password: PASSWORD, requireHg: false, remember: true })
    await profile.saveProfile({ mode: 'password', password: PASSWORD, requireHg: false, remember: false })
    expect(await db.kv.get('cloudProfile')).toBeUndefined()
    expect(await profile.loadProfile()).toMatchObject({ password: PASSWORD, remember: false })
  })

  it('密文被改动时取不回（不会得到错误的密码）；删除后什么都不剩', async () => {
    const { profile, db } = ctx
    await profile.saveProfile({ mode: 'password', password: PASSWORD, requireHg: false, remember: true })
    const row = (await db.kv.get('cloudProfile'))!
    const value = row.value as { ciphertext: Uint8Array }
    value.ciphertext[0]! ^= 1
    await db.kv.put(row)
    expect(await profile.loadProfile()).toBeNull()
    await profile.clearProfile()
    expect(await db.kv.get('cloudProfile')).toBeUndefined()
    expect(await profile.profileInfo()).toBeNull()
  })

  it('无密码模式：没有密码；之前版本保存的（没有 mode 字段）按密码模式读取', async () => {
    const { profile, db } = ctx
    await profile.saveProfile({ mode: 'hg', password: '', requireHg: true, remember: true })
    expect(await profile.loadProfile()).toMatchObject({ mode: 'hg', password: '' })
    expect(await profile.profileInfo()).toMatchObject({ mode: 'hg' })
    await profile.saveProfile({ mode: 'password', password: PASSWORD, requireHg: false, remember: true })
    const row = (await db.kv.get('cloudProfile'))!
    delete (row.value as { mode?: string }).mode
    await db.kv.put(row)
    expect(await profile.loadProfile()).toMatchObject({ mode: 'password', password: PASSWORD })
  })
})
