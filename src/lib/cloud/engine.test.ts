/**
 * 云同步端到端测试：浏览器端的完整流程（engine.ts）直接对接真实的 Worker 代码（worker/index.ts + CloudVault），
 * 每台“设备”是一个独立的 IndexedDB。验证开通、新设备恢复、双向合并、并发、改密码、覆盖、双重验证、合并快照、删除，
 * 以及最后所有设备的数据指纹一致。
 */
import { Dexie } from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AkLedgerEntry } from '../types'

// Worker 端的模块按路径动态加载：前端的类型配置里没有 Workers 的全局类型，不能静态引入
const WORKER_ENTRY = '../../../worker/index'
const FAKE_CLOUD = '../../../worker/testing/fake-cloud'

interface FakeCloud {
  namespace: unknown
  storages: Map<string, { sql: { exec(query: string): { toArray(): Record<string, unknown>[] } } }>
}
let workerFetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response>
let makeCloud: (pepper: string, hgSecret?: string) => FakeCloud
let cloud: FakeCloud

const SELF = 'https://ark-next.kaltsit.dev'
const PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef'
const HG_SECRET = 'test-hg-secret-0123456789abcdef0123456789'
/** 服务器是否配置了无密码模式 */
let hgSecret: string | undefined = HG_SECRET
const UID = '12345678'
const PASSWORD = 'Kx7mP2qL9vRtWz4n'
const VALID_OAUTH = 'valid-oauth-token-for-test'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }

const env = () => ({ CLOUD: cloud.namespace, SYNC_PEPPER: PEPPER, ...(hgSecret ? { SYNC_HG_SECRET: hgSecret } : {}) })

/** 把浏览器发出的请求交给真实的 Worker；Worker 核实鹰角 token 时请求的绑定列表也在这里模拟 */
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input)
  if (url.startsWith('https://binding-api-account-prod.hypergryph.com/')) {
    const token = new URL(url).searchParams.get('token')
    const list = token === VALID_OAUTH ? [{ uid: UID }] : []
    return Response.json({ status: 0, data: { list: ['arknights', 'endfield'].map((appCode) => ({ appCode, bindingList: list })) } })
  }
  if (url.startsWith('/api/')) {
    const headers = new Headers(init?.headers)
    headers.set('sec-fetch-site', 'same-origin')
    return workerFetch(new Request(`${SELF}${url}`, { ...init, headers }), env(), ctx)
  }
  throw new Error(`unexpected fetch ${url}`)
}

beforeAll(async () => {
  workerFetch = ((await import(/* @vite-ignore */ WORKER_ENTRY)) as { default: { fetch: typeof workerFetch } }).default.fetch
  makeCloud = ((await import(/* @vite-ignore */ FAKE_CLOUD)) as { fakeCloud: typeof makeCloud }).fakeCloud
  vi.stubGlobal('fetch', fakeFetch)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

/** 一台设备：独立的 IndexedDB，独立加载的模块（内存里的钥匙也是各自的） */
async function device(factory = new IDBFactory()) {
  vi.resetModules()
  const deps = (Dexie as unknown as { dependencies: { indexedDB: unknown; IDBKeyRange: unknown } }).dependencies
  deps.indexedDB = factory
  deps.IDBKeyRange = IDBKeyRange
  const engine = await import('./engine')
  const { db } = await import('../db')
  const { mergeAkPulls, toAkPull } = await import('../sync/arknights')
  const { mergeLedger } = await import('../ledger')
  const { readLocalDataset } = await import('./dataset')
  const { fingerprint } = await import('./codec')
  const accountId = `arknights:${UID}`
  return {
    factory,
    engine,
    db,
    accountId,
    async createAccount(nickName = '博士') {
      await db.accounts.put({ id: accountId, game: 'arknights', uid: UID, nickName, createdAt: 1, metaAt: 1 })
      return (await db.accounts.get(accountId))!
    },
    /** 第 from..to 次十连 */
    async addPulls(from: number, to: number, source: 'api' | 'import' = 'api') {
      const pulls = []
      for (let i = from; i < to; i++) {
        for (let pos = 0; pos < 10; pos++) {
          const p = toAkPull(accountId, 'normal', {
            poolId: 'NORM_1',
            poolName: '常驻标准寻访',
            charId: pos === 0 && i % 3 === 0 ? 'char_103_angel' : 'char_123_fang',
            charName: pos === 0 && i % 3 === 0 ? '能天使' : '芬',
            rarity: pos === 0 && i % 3 === 0 ? 5 : 2,
            isNew: false,
            gachaTs: String(1_700_000_000_000 + i * 3_600_000),
            pos,
          } as never)
          pulls.push(source === 'api' ? p : { ...p, source, category: undefined })
        }
      }
      await mergeAkPulls(accountId, pulls)
    },
    async addLedger(i: number) {
      const entry: AkLedgerEntry = {
        accountId,
        kind: 'stone',
        key: `${1_700_000_000 + i}:购买:${i}:${i + 1}`,
        ts: (1_700_000_000 + i) * 1000,
        raw: { eventTs: 1_700_000_000 + i, operation: '购买', changeNum: 1, after: i + 1 },
      }
      await mergeLedger([entry])
    },
    async count() {
      return db.akPulls.where('accountId').equals(accountId).count()
    },
    async print() {
      const account = await db.accounts.get(accountId)
      return fingerprint(await readLocalDataset(account!))
    },
  }
}

const target = { game: 'arknights' as const, uid: UID }

describe('云同步端到端', () => {
  it('开通 → 新设备恢复 → 双向合并 → 并发 → 收敛到同一个指纹', async () => {
    cloud = makeCloud(PEPPER)
    const a = await device()
    const account = await a.createAccount()
    await a.addPulls(0, 20)
    await a.addLedger(1)
    // 开通需要有效的鹰角 token
    await expect(a.engine.enableCloud(account, { password: PASSWORD, oauthToken: 'wrong', requireHg: false, remember: true, overwrite: false })).rejects.toMatchObject({
      code: 'hg_verify_failed',
    })
    // 弱密码直接拒绝
    await expect(a.engine.enableCloud(account, { password: 'Password2024', oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })).rejects.toMatchObject({
      code: 'weak_password',
    })
    await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })
    // 查询状态需要有效的鹰角 token；已经开通的账号不能再“开通”（只能明确选择覆盖）
    await expect(a.engine.cloudStatus(target, 'wrong')).rejects.toMatchObject({ code: 'hg_verify_failed' })
    expect(await a.engine.cloudStatus(target, VALID_OAUTH)).toEqual({ exists: true, mode: 'password', requireHg: false })
    expect(await a.engine.cloudStatus({ game: 'endfield', uid: UID }, VALID_OAUTH)).toEqual({ exists: false })
    await expect(
      a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false }),
    ).rejects.toMatchObject({ code: 'already_enabled' })

    // 新设备：只靠 UID + 密码恢复，不需要鹰角 token
    const b = await device()
    await expect(b.engine.unlockCloud(target, { password: `${PASSWORD}x`, remember: true })).rejects.toMatchObject({ code: 'wrong_password' })
    const restored = await b.engine.unlockCloud(target, { password: PASSWORD, remember: true })
    expect(restored.downloaded).toBe(200)
    expect(await b.count()).toBe(200)
    expect((await b.db.accounts.get(b.accountId))!.nickName).toBe('博士')
    expect(await b.db.akLedger.count()).toBe(1)
    expect(await b.print()).toBe(await a.print())

    // B 新增，A 下载
    await b.addPulls(20, 25)
    expect((await b.engine.syncCloud(b.accountId)).uploaded).toBe(50)
    expect((await a.engine.syncCloud(a.accountId)).downloaded).toBe(50)
    expect(await a.print()).toBe(await b.print())

    // 并发：两边各自新增不同的记录，各同步两轮后一致
    await a.addPulls(25, 28)
    await b.addPulls(28, 31)
    await a.engine.syncCloud(a.accountId)
    await b.engine.syncCloud(b.accountId)
    await a.engine.syncCloud(a.accountId)
    await b.engine.syncCloud(b.accountId)
    expect(await a.count()).toBe(310)
    expect(await a.print()).toBe(await b.print())

    // 同一条记录两边版本不同（导入 vs 接口）：都收敛到接口版本，且不会来回上传
    await a.addPulls(31, 32, 'import')
    await b.addPulls(31, 32, 'api')
    await a.engine.syncCloud(a.accountId)
    await b.engine.syncCloud(b.accountId)
    await a.engine.syncCloud(a.accountId)
    expect(await a.print()).toBe(await b.print())
    const quiet = await b.engine.syncCloud(b.accountId)
    expect(quiet.uploaded).toBe(0)
    expect((await a.db.akPulls.where('accountId').equals(a.accountId).filter((p) => p.source === 'import').count())).toBe(0)
  })

  it('改密码：其他设备需要重新输入新密码；覆盖：从最全的浏览器换掉云端，其他设备的多余记录补传回来', async () => {
    cloud = makeCloud(PEPPER)
    const a = await device()
    const account = await a.createAccount()
    await a.addPulls(0, 10)
    await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })
    const b = await device()
    await b.engine.unlockCloud(target, { password: PASSWORD, remember: true })

    const NEW = 'Tz4kWq8nRb2mHs6v'
    await expect(a.engine.changePassword(a.accountId, { oldPassword: `${PASSWORD}x`, newPassword: NEW })).rejects.toMatchObject({ code: 'wrong_password' })
    await a.engine.changePassword(a.accountId, { oldPassword: PASSWORD, newPassword: NEW })
    await a.engine.syncCloud(a.accountId)
    await expect(b.engine.syncCloud(b.accountId)).rejects.toMatchObject({ code: 'auth_changed' })
    await expect(b.engine.syncCloud(b.accountId)).rejects.toMatchObject({ code: 'need_password' })
    await expect(b.engine.unlockCloud(target, { password: PASSWORD, remember: true })).rejects.toMatchObject({ code: 'wrong_password' })
    await b.engine.unlockCloud(target, { password: NEW, remember: true })

    // B 有一些 A 没有的记录（还没上传），然后 A 忘记了密码，从 A 覆盖云端
    await b.addPulls(10, 12)
    const NEWER = 'Pw9xLm3kQz7rTb5n'
    await a.engine.enableCloud(account, { password: NEWER, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: true })
    // B 的钥匙失效，用新密码重新解锁后，把自己多出来的记录补传上去
    await expect(b.engine.syncCloud(b.accountId)).rejects.toMatchObject({ code: 'auth_changed' })
    const back = await b.engine.unlockCloud(target, { password: NEWER, remember: true })
    expect(back.uploaded).toBe(20)
    await a.engine.syncCloud(a.accountId)
    expect(await a.count()).toBe(120)
    expect(await a.print()).toBe(await b.print())
  })

  it('双重验证：开启后没有鹰角 token 不能同步、不能在新设备恢复', async () => {
    cloud = makeCloud(PEPPER)
    const a = await device()
    const account = await a.createAccount()
    await a.addPulls(0, 3)
    await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })
    await expect(a.engine.setTwoFactor(a.accountId, true, 'wrong')).rejects.toMatchObject({ code: 'hg_verify_failed' })
    await a.engine.setTwoFactor(a.accountId, true, VALID_OAUTH)
    await expect(a.engine.syncCloud(a.accountId)).rejects.toMatchObject({ code: 'need_hg' })
    await a.engine.syncCloud(a.accountId, { oauthToken: VALID_OAUTH })
    const b = await device()
    await expect(b.engine.unlockCloud(target, { password: PASSWORD, remember: true })).rejects.toMatchObject({ code: 'wrong_password' })
    await b.engine.unlockCloud(target, { password: PASSWORD, remember: true, oauthToken: VALID_OAUTH })
    expect(await b.count()).toBe(30)
    await a.engine.setTwoFactor(a.accountId, false, VALID_OAUTH)
    await a.engine.syncCloud(a.accountId)
  })

  it('批次多了自动合并成快照；新设备从快照恢复的数据完整', async () => {
    cloud = makeCloud(PEPPER)
    const a = await device()
    const account = await a.createAccount()
    await a.addPulls(0, 1)
    await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })
    let compacted = 0
    for (let i = 1; i < 40; i++) {
      await a.addPulls(i, i + 1)
      if ((await a.engine.syncCloud(a.accountId)).compacted) compacted++
    }
    expect(compacted).toBeGreaterThan(0)
    const rows = [...cloud.storages.values()][0]!.sql.exec('SELECT COUNT(*) AS n FROM batches').toArray()[0]!.n as number
    expect(rows).toBeLessThanOrEqual(17)
    const c = await device()
    await c.engine.unlockCloud(target, { password: PASSWORD, remember: true })
    expect(await c.count()).toBe(400)
    expect(await c.print()).toBe(await a.print())
  })

  it('不在这台设备保存钥匙：刷新网页后需要重新输入密码；删除云端后无法再恢复', async () => {
    cloud = makeCloud(PEPPER)
    const a = await device()
    const account = await a.createAccount()
    await a.addPulls(0, 2)
    await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: false, overwrite: false })
    await a.engine.syncCloud(a.accountId)
    expect((await a.db.cloud.get(a.accountId))!.authKey).toBeUndefined()
    // 同一个数据库、重新加载模块（相当于刷新网页）
    const reloaded = await device(a.factory)
    await expect(reloaded.engine.syncCloud(reloaded.accountId)).rejects.toMatchObject({ code: 'need_password' })
    await reloaded.engine.unlockCloud(target, { password: PASSWORD, remember: true })
    await reloaded.engine.deleteCloud(target)
    expect(await reloaded.db.cloud.get(reloaded.accountId)).toBeUndefined()
    const b = await device()
    await expect(b.engine.unlockCloud(target, { password: PASSWORD, remember: true })).rejects.toMatchObject({ code: 'wrong_password' })
    // 本地数据不受影响
    expect(await reloaded.count()).toBe(20)
  })

  it('终末地：寻访记录和卡池信息一起恢复', async () => {
    cloud = makeCloud(PEPPER)
    const a = await device()
    const { mergeEfPulls, mergeEfPools } = await import('../sync/endfield')
    const id = `endfield:${UID}`
    await a.db.accounts.put({ id, game: 'endfield', uid: UID, nickName: '管理员', createdAt: 1, metaAt: 1 })
    await mergeEfPulls(
      id,
      Array.from({ length: 30 }, (_, i) => ({
        accountId: id,
        key: `char:special_1:${1000 + i}`,
        type: 'char' as const,
        poolId: 'special_1',
        poolName: '特许寻访',
        poolType: 'E_CharacterGachaPoolType_Special',
        itemId: i % 10 === 0 ? 'chr_0025_ardelia' : 'chr_0001',
        itemName: i % 10 === 0 ? '艾尔黛拉' : '某干员',
        rarity: i % 10 === 0 ? 6 : 4,
        isNew: i === 0,
        isFree: false,
        kind: 'draw',
        gachaTs: 1_760_000_000_000 + i * 1000,
        seqId: String(1000 + i),
        source: 'api' as const,
      })),
    )
    await mergeEfPools([{ poolId: 'special_1', poolName: '特许寻访', poolType: 'x', gachaType: 'char', up6Name: '艾尔黛拉', items: [{ id: 'chr_0025_ardelia', name: '艾尔黛拉', rarity: 6 }], fetchedAt: 5 }])
    const account = (await a.db.accounts.get(id))!
    await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })
    const b = await device()
    await b.engine.unlockCloud({ game: 'endfield', uid: UID }, { password: PASSWORD, remember: true })
    expect(await b.db.efPulls.count()).toBe(30)
    expect((await b.db.efPools.get('special_1'))!.up6Name).toBe('艾尔黛拉')
    const { readLocalDataset } = await import('./dataset')
    const { fingerprint } = await import('./codec')
    expect(await fingerprint(await readLocalDataset((await b.db.accounts.get(id))!))).toBe(
      (await a.db.cloud.get(id))!.fingerprint,
    )
  })

  it('无密码模式：开通不需要密码；新设备只用鹰角 token 连接；每次云同步都要 token；和密码模式互相切换，数据不丢', async () => {
    hgSecret = HG_SECRET
    cloud = makeCloud(PEPPER, HG_SECRET)
    const a = await device()
    const account = await a.createAccount()
    await a.addPulls(0, 10)
    await expect(a.engine.enableCloud(account, { mode: 'hg', oauthToken: 'wrong', overwrite: false })).rejects.toMatchObject({ code: 'hg_verify_failed' })
    await a.engine.enableCloud(account, { mode: 'hg', oauthToken: VALID_OAUTH, overwrite: false })
    expect(await a.engine.cloudStatus(target, VALID_OAUTH)).toEqual({ exists: true, mode: 'hg', requireHg: true })
    // 这台设备上不保存任何钥匙
    const stored = (await a.db.cloud.get(a.accountId))!
    expect(stored).toMatchObject({ mode: 'hg', requireHg: true })
    expect(stored.authKey).toBeUndefined()
    expect(stored.dek).toBeUndefined()
    await expect(a.engine.syncCloud(a.accountId)).rejects.toMatchObject({ code: 'need_hg' })
    await expect(a.engine.enableCloud(account, { mode: 'hg', oauthToken: VALID_OAUTH, overwrite: false })).rejects.toMatchObject({ code: 'already_enabled' })

    // 新设备：密码解不开；只用鹰角 token 连接
    const b = await device()
    await expect(b.engine.unlockCloud(target, { password: PASSWORD, remember: true })).rejects.toMatchObject({ code: 'wrong_password' })
    await expect(b.engine.unlockHgCloud(target, { oauthToken: 'wrong' })).rejects.toMatchObject({ code: 'hg_verify_failed' })
    expect((await b.engine.unlockHgCloud(target, { oauthToken: VALID_OAUTH })).downloaded).toBe(100)
    await b.addPulls(10, 12)
    expect((await b.engine.syncCloud(b.accountId, { oauthToken: VALID_OAUTH })).uploaded).toBe(20)
    expect((await a.engine.syncCloud(a.accountId, { oauthToken: VALID_OAUTH })).downloaded).toBe(20)
    expect(await a.print()).toBe(await b.print())
    // 没有密码可改，也不能关掉鹰角验证
    await expect(a.engine.changePassword(a.accountId, { oldPassword: PASSWORD, newPassword: 'Tz4kWq8nRb2mHs6v' })).rejects.toMatchObject({ code: 'wrong_mode' })
    await expect(a.engine.setTwoFactor(a.accountId, false, VALID_OAUTH)).rejects.toMatchObject({ code: 'wrong_mode' })

    // 切换为密码模式：B 有还没上传的记录，切换后用密码重新解锁时补传
    await b.addPulls(12, 13)
    await a.engine.switchCloudMode(account, { to: 'password', password: PASSWORD, oauthToken: VALID_OAUTH, remember: true })
    expect(await a.engine.cloudStatus(target, VALID_OAUTH)).toEqual({ exists: true, mode: 'password', requireHg: false })
    await expect(b.engine.syncCloud(b.accountId, { oauthToken: VALID_OAUTH })).rejects.toMatchObject({ code: 'auth_changed' })
    await expect(b.engine.unlockHgCloud(target, { oauthToken: VALID_OAUTH })).rejects.toMatchObject({ code: 'not_enabled' })
    expect((await b.engine.unlockCloud(target, { password: PASSWORD, remember: true })).uploaded).toBe(10)
    await a.engine.syncCloud(a.accountId)
    expect(await a.count()).toBe(130)
    expect(await a.print()).toBe(await b.print())

    // 再切回无密码模式：B 的密码钥匙失效，用鹰角 token 重新连接
    await a.engine.switchCloudMode(account, { to: 'hg', oauthToken: VALID_OAUTH })
    await expect(b.engine.syncCloud(b.accountId)).rejects.toMatchObject({ code: 'auth_changed' })
    await b.engine.unlockHgCloud(target, { oauthToken: VALID_OAUTH })
    expect(await b.print()).toBe(await a.print())
    // 切换前必须能先合并云端：已经是这个模式时拒绝
    await expect(a.engine.switchCloudMode(account, { to: 'hg', oauthToken: VALID_OAUTH })).rejects.toMatchObject({ code: 'wrong_mode' })
  })

  it('服务器没有配置无密码模式：开通无密码模式失败，密码模式不受影响', async () => {
    hgSecret = undefined
    cloud = makeCloud(PEPPER)
    try {
      const a = await device()
      const account = await a.createAccount()
      await a.addPulls(0, 2)
      await expect(a.engine.enableCloud(account, { mode: 'hg', oauthToken: VALID_OAUTH, overwrite: false })).rejects.toMatchObject({ code: 'hg_mode_unavailable' })
      await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })
    } finally {
      hgSecret = HG_SECRET
    }
  })
})
