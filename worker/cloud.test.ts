/**
 * 云同步接口（worker/cloud.ts）：Worker 不相信客户端发来的任何东西。
 */
import { describe, expect, it } from 'vitest'
import { computeLocator, ENVELOPE_HEADER_BYTES, frame, toBase64Url, unframe } from '../shared/cloud-protocol'
import type { HgProof } from './hg-verify'
import worker from './index'
import type { Env } from './proxy'
import { fakeCloud } from './testing/fake-cloud'

const SELF = 'https://ark-next.kaltsit.dev'
const PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef'
const HG_SECRET = 'test-hg-secret-0123456789abcdef0123456789'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never
const AUTH = toBase64Url(new Uint8Array(32).fill(1))
const WRAPPED = toBase64Url(new Uint8Array(60).fill(7))

function envelope(kind: 'delta' | 'snapshot', kid: number, id: number): Uint8Array {
  const e = new Uint8Array(ENVELOPE_HEADER_BYTES + 16)
  e.set([1, kid, kind === 'delta' ? 1 : 2, id])
  return e
}

function post(op: string, body: Uint8Array | string, env: Env, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`${SELF}/api/cloud/v1/${op}`, {
      method: 'POST',
      headers: { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream', ...headers },
      body,
    }) as never,
    env,
    ctx,
  ) as Promise<Response>
}

function makeEnv(cloud = fakeCloud(PEPPER, HG_SECRET)): Env & { cloud: ReturnType<typeof fakeCloud> } {
  return { CLOUD: cloud.namespace, SYNC_PEPPER: PEPPER, SYNC_HG_SECRET: HG_SECRET, cloud } as never
}

describe('云同步接口：请求格式与来源', () => {
  it('info：返回协议版本、线上部署的 commit 和网页能读的数据格式版本', async () => {
    const res = (await worker.fetch(new Request(`${SELF}/api/cloud/v1/info`) as never, makeEnv(), ctx)) as Response
    // 本地是 dev，CI 里是 GITHUB_SHA
    expect(await res.json()).toEqual({ protocol: 1, commit: expect.stringMatching(/^(dev|[0-9a-f]{40})$/), dataFormat: 3, available: true, hgAvailable: true })
    const withoutHg = { ...makeEnv(), SYNC_HG_SECRET: undefined }
    expect(await ((await worker.fetch(new Request(`${SELF}/api/cloud/v1/info`) as never, withoutHg, ctx)) as Response).json()).toMatchObject({ available: true, hgAvailable: false })
  })

  it('只接受本站页面的 POST 二进制请求', async () => {
    const e = makeEnv()
    const body = frame({ locator: 'L'.repeat(43), authKey: AUTH, afterSeq: 0 })
    expect((await worker.fetch(new Request(`${SELF}/api/cloud/v1/pull`) as never, e, ctx)).status).toBe(405)
    expect((await post('pull', body, e, { 'x-arkrecord-client': '' })).status).toBe(403)
    expect((await post('pull', body, e, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post('pull', body, e, { 'content-type': 'application/json' })).status).toBe(415)
    expect((await post('nope', body, e)).status).toBe(404)
    expect((await post('pull', new Uint8Array([0, 200]), e)).status).toBe(400)
    expect((await post('pull', new Uint8Array(2 + 1024 + 1024 * 1024 + 1), e)).status).toBe(413)
  })

  it('没有配置存储或 SYNC_PEPPER 时返回 503', async () => {
    const res = await post('pull', frame({ locator: 'L'.repeat(43), authKey: AUTH, afterSeq: 0 }), {})
    expect(res.status).toBe(503)
  })

  it('限速', async () => {
    const e = { ...makeEnv(), RL_CLOUD: { limit: async () => ({ success: false }) } } as never
    expect((await post('pull', frame({ locator: 'L'.repeat(43), authKey: AUTH, afterSeq: 0 }), e)).status).toBe(429)
  })

  it.each([
    ['pull 缺 afterSeq', 'pull', { authKey: AUTH }],
    ['pull 带了数据', 'pull', { authKey: AUTH, afterSeq: 0, extra: true }],
    ['authKey 长度不对', 'pull', { authKey: 'abc', afterSeq: 0 }],
    ['afterSeq 是负数', 'pull', { authKey: AUTH, afterSeq: -1 }],
    ['locator 格式不对', 'pull', { locator: 'short', authKey: AUTH, afterSeq: 0 }],
    ['push 没有密文', 'push', { authKey: AUTH }],
  ])('字段不合法：%s', async (_name, op, header) => {
    const payload = _name === 'pull 带了数据' ? new Uint8Array([1]) : undefined
    const res = await post(op, frame({ locator: 'L'.repeat(43), ...header }, payload), makeEnv())
    expect(res.status).toBe(400)
  })
})

const verified = (uid = '12345678'): HgProof => ({ status: 'verified', game: 'arknights', uid })

describe('云同步接口：鹰角核实与 locator', () => {
  it('开通必须核实过鹰角 token；核实失败直接拒绝，不会访问存储', async () => {
    const e = makeEnv()
    const body = frame({ authKey: AUTH, wrappedDek: WRAPPED, kid: 5, requireHg: false, game: 'arknights', uid: '12345678' }, envelope('snapshot', 5, 1))
    expect((await post('claim', body, e)).status).toBe(403)
    // 带了 token 但核实失败（核实逻辑本身见 hg-verify.test.ts）
    const { handleCloud } = await import('./cloud')
    const res = await handleCloud(
      new Request(`${SELF}/api/cloud/v1/claim`, {
        method: 'POST',
        headers: { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
        body,
      }),
      e,
      new URL(`${SELF}/api/cloud/v1/claim`),
      { verify: async () => ({ status: 'invalid' }) },
    )
    expect(res.status).toBe(403)
    expect(res.headers.get('x-arkrecord-cloud')).toBe('hg_verify_failed')
    expect(e.cloud.requests).toHaveLength(0)
  })

  it('核实通过：locator 由 Worker 用核实过的 UID 计算；客户端传来不一致的 locator 被拒绝；内部请求只含白名单字段', async () => {
    const { handleCloud } = await import('./cloud')
    const e = makeEnv()
    const call = (header: Record<string, unknown>) =>
      handleCloud(
        new Request(`${SELF}/api/cloud/v1/claim`, {
          method: 'POST',
          headers: { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
          body: frame(header, envelope('snapshot', 5, 1)),
        }),
        e,
        new URL(`${SELF}/api/cloud/v1/claim`),
        { verify: async () => verified() },
      )
    const base = { authKey: AUTH, wrappedDek: WRAPPED, kid: 5, requireHg: false, game: 'arknights', uid: '12345678' }
    expect((await call({ ...base, locator: 'X'.repeat(43) })).status).toBe(400)
    // 不认识的模式直接拒绝
    expect((await call({ ...base, mode: 'admin' })).status).toBe(400)
    const res = await call({ ...base, injected: 'evil' })
    expect(res.status).toBe(200)
    const expected = await computeLocator('arknights', '12345678')
    const internal = e.cloud.requests.at(-1)!
    expect(internal.headers.get('x-vault-locator')).toBe(expected)
    expect(internal.headers.get('x-vault-hg')).toBe('1')
    expect(unframe(internal.body)!.header).toEqual({ authKey: AUTH, wrappedDek: WRAPPED, kid: 5, requireHg: false })
  })

  it('查询状态：必须核实过鹰角 token；只回答开通了没有、是哪种方式', async () => {
    const { handleCloud } = await import('./cloud')
    const e = makeEnv()
    const call = (op: string, header: Record<string, unknown>, proof: HgProof, payload?: Uint8Array) =>
      handleCloud(
        new Request(`${SELF}/api/cloud/v1/${op}`, {
          method: 'POST',
          headers: { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
          body: frame(header, payload),
        }),
        e,
        new URL(`${SELF}/api/cloud/v1/${op}`),
        { verify: async () => proof },
      )
    const who = { game: 'arknights', uid: '12345678' }
    // 只知道 UID 查不到：没有鹰角核实直接拒绝，不访问存储
    expect((await call('status', { locator: await computeLocator('arknights', '12345678') }, { status: 'absent' })).status).toBe(403)
    expect(e.cloud.requests).toHaveLength(0)
    // 不接受其他字段
    expect((await call('status', { ...who, authKey: AUTH }, verified())).status).toBe(400)
    expect((await call('status', who, verified(), new Uint8Array([1]))).status).toBe(400)
    expect(await (await call('status', who, verified())).json()).toEqual({ exists: false })
    expect(unframe(e.cloud.requests.at(-1)!.body)!.header).toEqual({})
    await call('claim', { authKey: AUTH, wrappedDek: WRAPPED, kid: 5, requireHg: true, ...who }, verified(), envelope('snapshot', 5, 1))
    expect(await (await call('status', who, verified())).json()).toEqual({ exists: true, mode: 'password', requireHg: true })
  })

  it('客户端伪造的内部请求头不会被采用', async () => {
    const e = makeEnv()
    const res = await post('claim', frame({ authKey: AUTH, wrappedDek: WRAPPED, kid: 5, requireHg: false, locator: 'L'.repeat(43) }, envelope('snapshot', 5, 1)), e, {
      'x-vault-hg': '1',
      'x-vault-locator': 'L'.repeat(43),
    })
    expect(res.status).toBe(403)
    expect(e.cloud.requests).toHaveLength(0)
  })

  it('完整流程：开通 → 用 authKey 下载 → 上传 → 再下载', async () => {
    const { handleCloud } = await import('./cloud')
    const e = makeEnv()
    const locator = await computeLocator('arknights', '12345678')
    const call = (op: string, header: Record<string, unknown>, payload?: Uint8Array, proof: HgProof = { status: 'absent' }) =>
      handleCloud(
        new Request(`${SELF}/api/cloud/v1/${op}`, {
          method: 'POST',
          headers: { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
          body: frame(header, payload),
        }),
        e,
        new URL(`${SELF}/api/cloud/v1/${op}`),
        { verify: async () => proof },
      )
    expect((await call('claim', { authKey: AUTH, wrappedDek: WRAPPED, kid: 5, requireHg: false, game: 'arknights', uid: '12345678' }, envelope('snapshot', 5, 1), verified())).status).toBe(200)
    const pulled = await call('pull', { locator, authKey: AUTH, afterSeq: 0 })
    expect(pulled.status).toBe(200)
    expect(unframe(new Uint8Array(await pulled.arrayBuffer()))!.header).toMatchObject({ headSeq: 1, wrappedDek: WRAPPED })
    expect((await call('push', { locator, authKey: AUTH }, envelope('delta', 5, 2))).status).toBe(200)
    const again = await call('pull', { locator, authKey: AUTH, afterSeq: 1 })
    expect(unframe(new Uint8Array(await again.arrayBuffer()))!.header).toMatchObject({ headSeq: 2, batches: [{ seq: 2, kind: 'delta' }] })
    // 只知道 locator（也就是只知道 UID）拿不到任何东西
    const stranger = await call('pull', { locator, authKey: toBase64Url(new Uint8Array(32)), afterSeq: 0 })
    expect(stranger.status).toBe(401)
    expect(await stranger.json()).toEqual({ error: 'auth_failed' })
  })
})

async function client(proof: HgProof) {
  const { handleCloud } = await import('./cloud')
  const e = makeEnv()
  const call = (op: string, header: Record<string, unknown>, payload?: Uint8Array, p: HgProof = proof) =>
    handleCloud(
      new Request(`${SELF}/api/cloud/v1/${op}`, {
        method: 'POST',
        headers: { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
        body: frame(header, payload),
      }),
      e,
      new URL(`${SELF}/api/cloud/v1/${op}`),
      { verify: async () => p },
    )
  return { e, call }
}

describe('云同步接口：无密码模式', () => {
  const who = { game: 'arknights', uid: '12345678' }

  it('开通：不带 authKey、不带 requireHg；内部请求只有白名单字段', async () => {
    const { e, call } = await client(verified())
    expect((await call('claim', { ...who, mode: 'hg', authKey: AUTH, wrappedDek: WRAPPED, kid: 9 }, envelope('snapshot', 9, 1))).status).toBe(400)
    expect((await call('claim', { ...who, mode: 'hg', wrappedDek: WRAPPED, kid: 9, requireHg: false }, envelope('snapshot', 9, 1))).status).toBe(400)
    expect((await call('claim', { ...who, mode: 'hg', wrappedDek: WRAPPED, kid: 9 }, envelope('snapshot', 9, 1), { status: 'absent' })).status).toBe(403)
    const res = await call('claim', { ...who, mode: 'hg', wrappedDek: WRAPPED, kid: 9, extra: 1 }, envelope('snapshot', 9, 1))
    expect(res.status).toBe(200)
    expect(unframe(e.cloud.requests.at(-1)!.body)!.header).toEqual({ mode: 'hg', wrappedDek: WRAPPED, kid: 9 })
  })

  it('每个请求都要核实过鹰角 token：只知道 locator 拿不到任何东西；核实过的请求不带 authKey 也能下载、上传', async () => {
    const { call } = await client(verified())
    await call('claim', { ...who, mode: 'hg', wrappedDek: WRAPPED, kid: 9 }, envelope('snapshot', 9, 1))
    const locator = await computeLocator('arknights', '12345678')
    // 没有鹰角 token：pull 本身就不合法（既没有 authKey 也没有核实）
    expect((await call('pull', { locator, afterSeq: 0 }, undefined, { status: 'absent' })).status).toBe(400)
    // 带一个随便的 authKey：和密码错误一样的 401
    expect((await call('pull', { locator, authKey: AUTH, afterSeq: 0 }, undefined, { status: 'absent' })).status).toBe(401)
    const pulled = await call('pull', { ...who, afterSeq: 0 })
    expect(pulled.status).toBe(200)
    const meta = unframe(new Uint8Array(await pulled.arrayBuffer()))!.header
    expect(meta).toMatchObject({ mode: 'hg', kid: 9, wrappedDek: WRAPPED })
    expect(typeof meta.hgKek).toBe('string')
    expect((await call('push', who, envelope('delta', 9, 2))).status).toBe(200)
    // 状态里能拿到同一个 KEK_hg
    const status = (await (await call('status', { ...who, kek: true })).json()) as Record<string, unknown>
    expect(status).toMatchObject({ exists: true, mode: 'hg', requireHg: true, hgKek: meta.hgKek })
    expect((await call('status', { ...who, kek: 'yes' })).status).toBe(400)
  })

  it('没有配置 SYNC_HG_SECRET：开通无密码模式返回 503，密码模式不受影响', async () => {
    const { handleCloud } = await import('./cloud')
    const e = { ...makeEnv(fakeCloud(PEPPER)), SYNC_HG_SECRET: undefined }
    const call = (header: Record<string, unknown>) =>
      handleCloud(
        new Request(`${SELF}/api/cloud/v1/claim`, {
          method: 'POST',
          headers: { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
          body: frame(header, envelope('snapshot', 9, 1)),
        }),
        e,
        new URL(`${SELF}/api/cloud/v1/claim`),
        { verify: async () => verified() },
      )
    const res = await call({ ...who, mode: 'hg', wrappedDek: WRAPPED, kid: 9 })
    expect(res.status).toBe(503)
    expect(res.headers.get('x-arkrecord-cloud')).toBe('hg_mode_unavailable')
    expect((await call({ ...who, authKey: AUTH, wrappedDek: WRAPPED, kid: 9, requireHg: false })).status).toBe(200)
  })
})
