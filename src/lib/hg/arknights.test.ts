import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRecentOrders } from './arknights'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('充值记录', () => {
  it('先用角色的 u8 token 查询', async () => {
    const fetchMock = vi.fn(async () => json({ status: 0, msg: 'OK', data: [{ orderId: 'O1' }] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchRecentOrders('dTg=', 'account')).toEqual([{ orderId: 'O1' }])
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/hg/u8/u8/pay/v1/recent')
    expect(init.method).toBe('POST')
    // 参数都在请求体里，token 不出现在网址里
    expect(JSON.parse(String(init.body))).toEqual({ body: { token: 'dTg=' } })
  })

  it('u8 token 不被接受时，官服角色改用官网的方式（账号 token）查询', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ msg: 'token错误或已失效', status: 3 }, 401))
      .mockResolvedValueOnce(json({ status: 0, data: null }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchRecentOrders('dTg=', 'account')).toEqual([])
    const { body } = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))
    expect(body).toEqual({ appCode: '9aa9768a549ddaa186b7', channelMasterId: 1, channelToken: { token: 'account' } })
  })

  it('没有账号 token（B 服角色）时直接报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ msg: 'token错误或已失效', status: 3 }, 401)))
    await expect(fetchRecentOrders('dTg=')).rejects.toMatchObject({ kind: 'auth' })
  })
})
