import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db'
import { HgError } from '../hg/client'
import type { Account } from '../types'

const api = vi.hoisted(() => ({
  fetchCategories: vi.fn(),
  fetchHistoryPage: vi.fn(),
  fetchDiamondPage: vi.fn(),
  fetchRecentOrders: vi.fn(),
}))
vi.mock('../hg/auth', () => ({ grantOAuthToken: async () => 'oauth', getU8Token: async () => 'u8' }))
vi.mock('../hg/arknights', () => ({
  roleLogin: async (uid: string, u8: string) => ({ uid, roleToken: u8, akCookie: 'cookie' }),
  ...api,
}))

const { syncArknights } = await import('./arknights')

const account: Account = { id: 'arknights:1', game: 'arknights', uid: '1', nickName: '博士', isOfficial: true, createdAt: 0 }
const T = 1_760_000_000

/** 第 i 条源石记录（i 越小越新） */
function diamond(i: number) {
  return { operation: '购买', changeNum: -1, after: 100 - i, eventTs: T - i * 60, pos: i }
}
/** 源石接口：共 total 条，每页 10 条，从新到旧 */
function diamondPages(total: number) {
  api.fetchDiamondPage.mockImplementation(async (_session: unknown, cursor?: { pos: number }) => {
    const start = cursor ? cursor.pos + 1 : 0
    const list = Array.from({ length: Math.max(0, Math.min(10, total - start)) }, (_, k) => diamond(start + k))
    return { list, hasMore: start + 10 < total }
  })
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  await db.accounts.put(account)
  vi.clearAllMocks()
  api.fetchCategories.mockResolvedValue([])
  api.fetchRecentOrders.mockResolvedValue([{ orderId: 'O1', productName: '源石', amount: 600, platform: 1, payTime: T }])
  diamondPages(25)
})

describe('同步源石与充值记录', () => {
  it('读取全部源石分页和充值记录；官服角色可以用账号 token 兜底查询充值', async () => {
    const result = await syncArknights(account, 'account-token')
    expect(result).toMatchObject({ added: 0, ledger: 26, warnings: [] })
    expect(api.fetchDiamondPage).toHaveBeenCalledTimes(3)
    expect(api.fetchRecentOrders).toHaveBeenCalledWith('u8', 'account-token')
    expect(await db.akLedger.count()).toBe(26)
  })

  it('增量同步：遇到已保存的源石记录就停止；重复同步不会重复保存', async () => {
    await syncArknights(account, 'account-token')
    diamondPages(28) // 期间新增了 3 条（编号整体后移）
    api.fetchDiamondPage.mockClear()
    const original = api.fetchDiamondPage.getMockImplementation()!
    api.fetchDiamondPage.mockImplementation(async (session: unknown, cursor?: { pos: number }) => {
      const page = await original(session, cursor)
      // 新的 3 条时间更晚
      return { ...page, list: page.list.map((d: ReturnType<typeof diamond>) => ({ ...d, eventTs: Number(d.eventTs) + 3 * 60, after: d.after + 3 })) }
    })
    const result = await syncArknights(account, 'account-token')
    expect(api.fetchDiamondPage).toHaveBeenCalledTimes(1)
    expect(result.ledger).toBe(3)
    expect(await db.akLedger.where('accountId').equals(account.id).count()).toBe(29)
  })

  it('B 服角色不用账号 token 查询充值（那会查到官服角色的订单）', async () => {
    const bili = { ...account, id: 'arknights:2', uid: '2', isOfficial: false, channelName: 'bilibili服' }
    await db.accounts.put(bili)
    await syncArknights(bili, 'account-token')
    expect(api.fetchRecentOrders).toHaveBeenCalledWith('u8', undefined)
  })

  it('源石或充值读取失败时只给出提示，寻访记录照常保存', async () => {
    api.fetchCategories.mockResolvedValue([{ id: 'normal', name: '标准寻访' }])
    api.fetchHistoryPage.mockResolvedValue({
      list: [{ poolId: 'P', poolName: '常驻', charId: 'char_1', charName: '芬', rarity: 2, isNew: false, gachaTs: String(T * 1000), pos: 0 }],
      hasMore: false,
    })
    api.fetchDiamondPage.mockRejectedValue(new HgError('upstream', '接口返回错误 500'))
    api.fetchRecentOrders.mockRejectedValue(new HgError('auth', '登录状态已失效，请重新登录', 401))
    const result = await syncArknights(account, 'account-token')
    expect(result.added).toBe(1)
    expect(result.warnings).toEqual(['源石记录：接口返回错误 500', '充值记录：登录状态已失效，请重新登录'])
    expect(await db.akPulls.count()).toBe(1)
  })
})
