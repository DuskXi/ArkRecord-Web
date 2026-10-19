import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArkRecordDB } from './db'
import { canRememberTokens, forgetToken, initTokenVault, resetTokenVaultForTests, tokensInKeychain } from './token-vault'
import type { Account } from './types'

// 全部是假的 token

let dbCount = 0
function freshDb(): ArkRecordDB {
  return new ArkRecordDB(`token-vault-test-${dbCount++}`)
}

function account(id: string, extra: Partial<Account> = {}): Account {
  return { id, game: 'arknights', uid: id.split(':')[1] ?? '1', nickName: 'n', channelName: 'c', isOfficial: true, createdAt: 1, ...extra } as Account
}

/** 假的主进程：available 表示系统钥匙串能不能用；saved 是“钥匙串”里的内容 */
function fakeBridge(available: boolean, saved: Record<string, string> = {}) {
  const store = { ...saved }
  const rpc = vi.fn(async (method: string, params?: unknown) => {
    const p = params as { accountId: string; token: string }
    if (method === 'app.tokens.status') return { available, backend: available ? 'dpapi' : 'basic_text' }
    if (method === 'app.tokens.load') return { tokens: { ...store } }
    if (method === 'app.tokens.save') {
      store[p.accountId] = p.token
      return { ok: true }
    }
    if (method === 'app.tokens.delete') {
      delete store[p.accountId]
      return { ok: true }
    }
    throw { code: -32601, message: 'nope' }
  })
  vi.stubGlobal('window', { arkrecord: { rpc, platform: 'win32' } })
  return { rpc, store }
}

/** 直接读 IndexedDB 里存的原始数据（不经过 Dexie 的钩子） */
async function rawAccounts(db: ArkRecordDB): Promise<Record<string, unknown>[]> {
  const idb = db.backendDB()
  return new Promise((resolve, reject) => {
    const request = idb.transaction('accounts').objectStore('accounts').getAll()
    request.addEventListener('success', () => resolve(request.result as Record<string, unknown>[]))
    request.addEventListener('error', () => reject(request.error))
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  resetTokenVaultForTests()
  vi.unstubAllGlobals()
})

describe('token vault in the web version', () => {
  it('does nothing: tokens stay in the account record', async () => {
    const db = freshDb()
    await initTokenVault(db.accounts)
    await db.accounts.put(account('arknights:1', { accountToken: 'FAKE_WEB' }))
    expect((await rawAccounts(db))[0]?.accountToken).toBe('FAKE_WEB')
    expect(canRememberTokens()).toBe(true)
    expect(tokensInKeychain()).toBe(false)
  })
})

describe('token vault in the desktop app', () => {
  it('saves tokens to the keychain and never writes them to IndexedDB', async () => {
    const { store } = fakeBridge(true)
    const db = freshDb()
    await initTokenVault(db.accounts)
    await db.accounts.put(account('arknights:1', { accountToken: 'FAKE_1' }))
    await flush()
    expect(store).toEqual({ 'arknights:1': 'FAKE_1' })
    expect((await rawAccounts(db))[0]?.accountToken).toBeUndefined()
    // 读出来的账号对象里有 token，其余代码不用改
    expect((await db.accounts.get('arknights:1'))?.accountToken).toBe('FAKE_1')
    expect((await db.accounts.toArray())[0]?.accountToken).toBe('FAKE_1')
    expect(canRememberTokens()).toBe(true)
    expect(tokensInKeychain()).toBe(true)
  })

  it('updates and later puts of the same account keep the token out of IndexedDB', async () => {
    const { store } = fakeBridge(true)
    const db = freshDb()
    await initTokenVault(db.accounts)
    await db.accounts.put(account('arknights:1'))
    await db.accounts.update('arknights:1', { accountToken: 'FAKE_2' })
    const read = (await db.accounts.get('arknights:1'))!
    await db.accounts.put({ ...read, lastSyncAt: 5 })
    await flush()
    expect(store['arknights:1']).toBe('FAKE_2')
    const raw = (await rawAccounts(db))[0]!
    expect(raw.accountToken).toBeUndefined()
    expect(raw.lastSyncAt).toBe(5)
  })

  it('loads remembered tokens on start', async () => {
    fakeBridge(true, { 'endfield:9': 'FAKE_SAVED' })
    const db = freshDb()
    await db.accounts.put(account('endfield:9', { game: 'endfield' }))
    await initTokenVault(db.accounts)
    expect((await db.accounts.get('endfield:9'))?.accountToken).toBe('FAKE_SAVED')
  })

  it('forgets tokens when asked and when the account is deleted', async () => {
    const { store } = fakeBridge(true, { 'arknights:1': 'FAKE_A', 'arknights:2': 'FAKE_B' })
    const db = freshDb()
    await db.accounts.bulkPut([account('arknights:1'), account('arknights:2')])
    await initTokenVault(db.accounts)
    forgetToken('arknights:1')
    await db.accounts.delete('arknights:2')
    await flush()
    expect(store).toEqual({})
    expect((await db.accounts.get('arknights:1'))?.accountToken).toBeUndefined()
  })

  it('keeps tokens only in memory when there is no system keychain', async () => {
    const { rpc } = fakeBridge(false)
    const db = freshDb()
    await initTokenVault(db.accounts)
    await db.accounts.put(account('arknights:1', { accountToken: 'FAKE_MEM' }))
    await flush()
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['app.tokens.status'])
    expect((await rawAccounts(db))[0]?.accountToken).toBeUndefined()
    // 这次运行里还能用
    expect((await db.accounts.get('arknights:1'))?.accountToken).toBe('FAKE_MEM')
    expect(canRememberTokens()).toBe(false)
  })

  it('treats a failing main process as no keychain', async () => {
    vi.stubGlobal('window', { arkrecord: { rpc: vi.fn(() => Promise.reject({ code: -32601, message: 'x' })), platform: 'linux' } })
    const db = freshDb()
    await initTokenVault(db.accounts)
    await db.accounts.put(account('arknights:1', { accountToken: 'FAKE_X' }))
    expect((await rawAccounts(db))[0]?.accountToken).toBeUndefined()
    expect(canRememberTokens()).toBe(false)
  })
})

describe('token vault: logging in again without "remember"', () => {
  it('removes the remembered token, like the web version clears it from the record', async () => {
    const { store } = fakeBridge(true, { 'arknights:1': 'FAKE_OLD' })
    const db = freshDb()
    await db.accounts.put(account('arknights:1'))
    await initTokenVault(db.accounts)
    const existing = (await db.accounts.get('arknights:1'))!
    // LoginModal：记住登录关掉时写入 accountToken: undefined
    await db.accounts.put({ ...existing, accountToken: undefined })
    await flush()
    expect(store).toEqual({})
    expect((await db.accounts.get('arknights:1'))?.accountToken).toBeUndefined()
  })
})

it('never stores a token value in IndexedDB, whatever the write path', async () => {
  fakeBridge(true)
  const db = freshDb()
  await initTokenVault(db.accounts)
  await db.accounts.add(account('arknights:1', { accountToken: 'FAKE_ADD' }))
  await db.accounts.bulkPut([account('arknights:2', { accountToken: 'FAKE_BULK' }), account('arknights:1', { accountToken: 'FAKE_PUT' })])
  await db.accounts.where('game').equals('arknights').modify({ accountToken: 'FAKE_MODIFY' })
  const raw = JSON.stringify(await rawAccounts(db))
  expect(raw).not.toContain('FAKE_')
})
