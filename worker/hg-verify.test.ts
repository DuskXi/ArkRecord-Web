import { describe, expect, it, vi } from 'vitest'
import { verifyHgProof } from './hg-verify'

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
