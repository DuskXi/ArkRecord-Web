/**
 * 桌面版云同步端到端：页面的云同步流程（engine.ts，和网页版同一份代码）→ 主进程的转发（desktop/electron/cloud.ts）
 * → 真实的 Worker 代码。转发出去的请求不带 Sec-Fetch-Site / Origin，要能通过 Worker 的同源检查。
 * 钥匙串用内存里的假实现，条目格式按主进程的规则（desktop/electron/token-store.ts）核对。
 * 验证：钥匙和同步配置（含密码）不写进 IndexedDB，重启应用后从钥匙串读回；没有钥匙串时只留在内存。
 */
import { Dexie } from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ArkrecordBridge } from '../transport'

// Worker 和主进程的模块按路径动态加载：前端的类型配置里没有它们的全局类型，不能静态引入
const WORKER_ENTRY = '../../../worker/index'
const FAKE_CLOUD = '../../../worker/testing/fake-cloud'
const FORWARD = '../../../desktop/electron/cloud'
const SECRET_RULES = '../../../desktop/electron/token-store'

interface FakeCloud {
  namespace: unknown
}
type Fetcher = (url: string, init: RequestInit) => Promise<Response>
let workerFetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response>
let makeCloud: (pepper: string) => FakeCloud
let forwardCloud: (request: Request, site: string | undefined, fetcher: Fetcher) => Promise<Response>
let rules: { isKey(value: unknown): boolean; isValue(value: unknown): boolean }
let pairs: (id: string, value: string) => boolean
let cloud: FakeCloud

const SITE = 'https://ark.kaltsit.dev'
const PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef'
const UID = '12345678'
const PASSWORD = 'Kx7mP2qL9vRtWz4n'
const VALID_OAUTH = 'valid-oauth-token-for-test'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} }
/** 主进程转发出去的请求（只记请求头，核对同源检查用到的几个） */
const forwarded: Headers[] = []

/** 主进程的 net.fetch：交给真实的 Worker；Worker 核实鹰角 token 时请求的绑定列表也在这里模拟 */
const toWorker: Fetcher = async (url, init) => {
  forwarded.push(new Headers(init.headers))
  return workerFetch(new Request(url, init), { CLOUD: cloud.namespace, SYNC_PEPPER: PEPPER }, ctx)
}

/** 页面的 fetch：/api/cloud/ 交给主进程的转发（app:// 协议），鹰角绑定列表是 Worker 自己发的 */
async function pageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input)
  if (url.startsWith('https://binding-api-account-prod.hypergryph.com/')) {
    const token = new URL(url).searchParams.get('token')
    const list = token === VALID_OAUTH ? [{ uid: UID }] : []
    return Response.json({ status: 0, data: { list: ['arknights', 'endfield'].map((appCode) => ({ appCode, bindingList: list })) } })
  }
  if (url.startsWith('/api/cloud/')) return forwardCloud(new Request(`app://arkrecord${url}`, init), SITE, toWorker)
  throw new Error(`unexpected fetch ${url}`)
}

beforeAll(async () => {
  workerFetch = ((await import(/* @vite-ignore */ WORKER_ENTRY)) as { default: { fetch: typeof workerFetch } }).default.fetch
  makeCloud = ((await import(/* @vite-ignore */ FAKE_CLOUD)) as { fakeCloud: typeof makeCloud }).fakeCloud
  forwardCloud = ((await import(/* @vite-ignore */ FORWARD)) as { forwardCloud: typeof forwardCloud }).forwardCloud
  const store = (await import(/* @vite-ignore */ SECRET_RULES)) as { CLOUD_SECRET_RULES: typeof rules; cloudSecretPairs: typeof pairs }
  rules = store.CLOUD_SECRET_RULES
  pairs = store.cloudSecretPairs
  vi.stubGlobal('fetch', pageFetch)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

/** 假的系统钥匙串（主进程的 app.cloudSecrets.*）：按主进程的规则核对条目 */
function keychain(available = true) {
  const entries = new Map<string, string>()
  const bridge: ArkrecordBridge = {
    platform: 'win32',
    async rpc(method, params) {
      const { id, secret } = (params ?? {}) as { id?: unknown; secret?: unknown }
      switch (method) {
        case 'app.tokens.status':
          return { available, backend: 'dpapi' }
        case 'app.cloudSecrets.load':
          return { secrets: available ? Object.fromEntries(entries) : {} }
        case 'app.cloudSecrets.save':
          if (!available) throw { code: -32000, message: '没有钥匙串', data: { kind: 'keychain_unavailable' } }
          if (!rules.isKey(id) || !rules.isValue(secret) || !pairs(id as string, secret as string)) throw { code: -32602, message: '格式不对' }
          entries.set(id as string, secret as string)
          return { ok: true }
        case 'app.cloudSecrets.delete':
          entries.delete(id as string)
          return { ok: true }
        default:
          throw { code: -32601, message: '不允许调用这个方法' }
      }
    },
  }
  return { bridge, entries }
}

/** 启动一次应用：独立加载的模块（内存里的钥匙也是各自的），IndexedDB 和钥匙串可以沿用上一次的 */
async function launch(bridge: ArkrecordBridge, factory = new IDBFactory()) {
  vi.resetModules()
  const deps = (Dexie as unknown as { dependencies: { indexedDB: unknown; IDBKeyRange: unknown } }).dependencies
  deps.indexedDB = factory
  deps.IDBKeyRange = IDBKeyRange
  const secrets = await import('./secrets')
  await secrets.initCloudSecrets(bridge)
  const engine = await import('./engine')
  const state = await import('./state')
  const profile = await import('./profile')
  const { db } = await import('../db')
  const accountId = `arknights:${UID}`
  return { factory, secrets, engine, state, profile, db, accountId }
}

const target = { game: 'arknights' as const, uid: UID }

describe('桌面版云同步端到端', () => {
  it('经主进程转发通过 Worker 的同源检查；钥匙存在钥匙串里，不进 IndexedDB；重启后不用再输入密码', async () => {
    cloud = makeCloud(PEPPER)
    forwarded.length = 0
    const { bridge, entries } = keychain()
    const a = await launch(bridge)
    await a.db.accounts.put({ id: a.accountId, game: 'arknights', uid: UID, nickName: '博士', createdAt: 1, metaAt: 1 })
    const account = (await a.db.accounts.get(a.accountId))!
    await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })

    // 转发出去的请求：x-arkrecord-client: 1，Referer 是网站首页，没有 Cookie、Origin
    expect(forwarded.length).toBeGreaterThan(0)
    for (const headers of forwarded) {
      expect(headers.get('x-arkrecord-client')).toBe('1')
      expect(headers.get('referer')).toBe(`${SITE}/`)
      expect(headers.get('cookie')).toBeNull()
      expect(headers.get('origin')).toBeNull()
    }

    const stored = await a.db.cloud.get(a.accountId)
    expect(stored?.remember).toBe(true)
    expect(stored?.authKey).toBeUndefined()
    expect(stored?.dek).toBeUndefined()
    expect([...entries.keys()]).toEqual([a.accountId])
    expect(entries.get(a.accountId)).toMatch(/^k1\./)
    // 内存里留的 DEK 不可导出
    expect(a.state.keysOf(stored!)?.dek.extractable).toBe(false)

    // 重启：从钥匙串读回钥匙，直接云同步
    const b = await launch(bridge, a.factory)
    const again = (await b.db.cloud.get(b.accountId))!
    expect(b.state.isReady(again)).toBe(true)
    expect(b.state.keysOf(again)?.dek.extractable).toBe(false)
    expect((await b.engine.syncCloud(b.accountId)).uploaded).toBe(0)

    // 退出云同步：钥匙串里的钥匙一起删掉
    await b.engine.forgetCloud(b.accountId)
    expect(entries.size).toBe(0)
  })

  it('同步配置（含云同步密码）存在钥匙串里，不进 IndexedDB；清除后钥匙串里也没有', async () => {
    const { bridge, entries } = keychain()
    const a = await launch(bridge)
    await a.profile.saveProfile({ mode: 'password', password: PASSWORD, requireHg: true, remember: true })
    expect(await a.db.kv.get('cloudProfile')).toBeUndefined()
    expect(entries.get('profile')).toMatch(/^p1\./)
    expect(entries.get('profile')).not.toContain(PASSWORD)

    const b = await launch(bridge, a.factory)
    expect(await b.profile.loadProfile()).toMatchObject({ mode: 'password', password: PASSWORD, requireHg: true, remember: true })
    expect(await b.profile.profileInfo()).toMatchObject({ mode: 'password', requireHg: true, remember: true })
    await b.profile.clearProfile()
    expect(entries.has('profile')).toBe(false)
    expect(await b.profile.loadProfile()).toBeNull()
  })

  it('没有可用的钥匙串：钥匙和同步配置只留在内存，IndexedDB 里也没有；重启后要重新输入密码', async () => {
    cloud = makeCloud(PEPPER)
    const { bridge, entries } = keychain(false)
    const a = await launch(bridge)
    expect(a.secrets.secretsInKeychain()).toBe(false)
    await a.db.accounts.put({ id: a.accountId, game: 'arknights', uid: UID, nickName: '博士', createdAt: 1, metaAt: 1 })
    const account = (await a.db.accounts.get(a.accountId))!
    await a.engine.enableCloud(account, { password: PASSWORD, oauthToken: VALID_OAUTH, requireHg: false, remember: true, overwrite: false })
    await a.profile.saveProfile({ mode: 'password', password: PASSWORD, requireHg: false, remember: true })
    const stored = (await a.db.cloud.get(a.accountId))!
    expect(stored.authKey).toBeUndefined()
    expect(a.state.isReady(stored)).toBe(true)
    expect(await a.db.kv.get('cloudProfile')).toBeUndefined()
    expect((await a.profile.profileInfo())?.remember).toBe(false)
    expect(entries.size).toBe(0)

    const b = await launch(bridge, a.factory)
    expect(b.state.isReady((await b.db.cloud.get(b.accountId))!)).toBe(false)
    expect(await b.profile.loadProfile()).toBeNull()
    // 输入密码后照常云同步
    expect((await b.engine.unlockCloud(target, { password: PASSWORD, remember: true })).downloaded).toBe(0)
  })
})
