import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVELOPE_HEADER_BYTES, frame, toBase64Url } from '../shared/cloud-protocol'
import { verifyHgProof } from './hg-verify'
import worker from './index'
import { fakeCloud } from './testing/fake-cloud'

afterEach(() => vi.unstubAllGlobals())

const OK = { status: 0, msg: 'OK', data: { list: [{ appCode: 'arknights', bindingList: [{ uid: '12345678' }, { uid: 87654321 }] }] } }

function fetcher(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

const header = (extra: Record<string, unknown> = {}) => ({ hgToken: 'oauth-token-abcdef', game: 'arknights', uid: '12345678', ...extra })

describe('核实鹰角 token（worker/hg-verify.ts）', () => {
  it('绑定列表里有这个 UID：核实通过；只请求写死的绑定列表地址；token 读出后从头部删除', async () => {
    const f = fetcher(OK)
    const h = header()
    expect(await verifyHgProof(h, { fetcher: f, userAgent: 'UA' })).toEqual({ status: 'verified', game: 'arknights', uid: '12345678' })
    const url = new URL(String(f.mock.calls[0]![0]))
    expect(`${url.origin}${url.pathname}`).toBe('https://binding-api-account-prod.hypergryph.com/account/binding/v1/binding_list')
    expect(url.searchParams.get('appCode')).toBe('arknights')
    expect(url.searchParams.get('token')).toBe('oauth-token-abcdef')
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>)['user-agent']).toBe('UA')
    expect('hgToken' in h).toBe(false)
  })

  it('接口返回数字形式的 UID 也能对上（字符串完全相等）', async () => {
    expect(await verifyHgProof(header({ uid: '87654321' }), { fetcher: fetcher(OK) })).toMatchObject({ status: 'verified' })
    expect(await verifyHgProof(header({ uid: '8765432' }), { fetcher: fetcher(OK) })).toEqual({ status: 'invalid' })
  })

  it('没有 token：absent，不发请求', async () => {
    const f = fetcher(OK)
    expect(await verifyHgProof({ game: 'arknights', uid: '1' }, { fetcher: f })).toEqual({ status: 'absent' })
    expect(f).not.toHaveBeenCalled()
  })

  it.each([
    ['UID 不在绑定列表里', header({ uid: '99999999' }), fetcher(OK)],
    ['游戏不匹配', header({ game: 'endfield' }), fetcher(OK)],
    ['status 不为 0', header(), fetcher({ ...OK, status: 3 })],
    ['HTTP 状态不是 200', header(), fetcher(OK, 500)],
    ['格式不对', header(), fetcher({ status: 0, data: { list: 'x' } })],
    ['token 格式不对', header({ hgToken: 'a b' }), fetcher(OK)],
    ['token 不是字符串', header({ hgToken: 123 }), fetcher(OK)],
    ['不认识的游戏', header({ game: 'genshin' }), fetcher(OK)],
    ['UID 格式不对', header({ uid: '1;drop' }), fetcher(OK)],
  ])('%s：一律当作核实失败', async (_name, h, f) => {
    expect(await verifyHgProof(h, { fetcher: f })).toEqual({ status: 'invalid' })
    expect('hgToken' in h).toBe(false)
  })

  it('网络错误、超时、响应不是 JSON：核实失败（fail closed）', async () => {
    const broken = vi.fn<typeof fetch>(async () => {
      throw new Error('network')
    })
    expect(await verifyHgProof(header(), { fetcher: broken })).toEqual({ status: 'invalid' })
    const notJson = vi.fn<typeof fetch>(async () => new Response('<html>', { status: 200 }))
    expect(await verifyHgProof(header(), { fetcher: notJson })).toEqual({ status: 'invalid' })
  })
})

describe('鹰角 token 只在处理请求时的内存里', () => {
  it('经过完整的 Worker：存储收到的内部请求、返回给浏览器的响应里都没有 token', async () => {
    const TOKEN = 'oauth-token-must-not-leak-0123456789'
    const upstream = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(OK), { status: 200 }))
    vi.stubGlobal('fetch', upstream)
    const cloud = fakeCloud('test-pepper-0123456789abcdef0123456789abcdef')
    const env = { CLOUD: cloud.namespace, SYNC_PEPPER: 'test-pepper-0123456789abcdef0123456789abcdef' } as never
    const send = (op: string, fields: Record<string, unknown>, payload?: Uint8Array) =>
      worker.fetch(
        new Request(`https://ark-next.kaltsit.dev/api/cloud/v1/${op}`, {
          method: 'POST',
          headers: { 'x-arkrecord-client': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
          body: frame(fields, payload),
        }) as never,
        env,
        { waitUntil: () => {}, passThroughOnException: () => {} } as never,
      ) as Promise<Response>
    const snapshot = new Uint8Array(ENVELOPE_HEADER_BYTES + 16)
    snapshot.set([1, 5, 2, 1])
    const who = { hgToken: TOKEN, game: 'arknights', uid: '12345678' }
    const responses = [
      await send('status', who),
      await send('claim', { ...who, authKey: toBase64Url(new Uint8Array(32).fill(1)), wrappedDek: toBase64Url(new Uint8Array(60)), kid: 5, requireHg: true }, snapshot),
      await send('status', who),
    ]
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200])
    // token 只用来请求写死的绑定列表地址
    expect(upstream).toHaveBeenCalledTimes(3)
    for (const [url] of upstream.mock.calls) expect(String(url)).toMatch(/^https:\/\/binding-api-account-prod\.hypergryph\.com\/account\/binding\/v1\/binding_list\?/)
    const leaks = (text: string) => text.includes(TOKEN)
    for (const r of responses) {
      expect(leaks(await r.clone().text())).toBe(false)
      expect(leaks(JSON.stringify([...r.headers]))).toBe(false)
    }
    expect(cloud.requests).toHaveLength(3)
    for (const req of cloud.requests) {
      expect(leaks(new TextDecoder().decode(req.body))).toBe(false)
      expect(leaks(JSON.stringify([...req.headers]))).toBe(false)
      expect(leaks(req.url)).toBe(false)
    }
    // 存储里也没有
    for (const storage of cloud.storages.values()) {
      const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
      for (const { name } of tables) expect(leaks(JSON.stringify(storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray(), (_k, v) => (v instanceof Uint8Array || v instanceof ArrayBuffer ? toBase64Url(new Uint8Array(v)) : v)))).toBe(false)
    }
  })
})
