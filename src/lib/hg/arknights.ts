/** 明日方舟官网用户中心的寻访记录接口（详见 docs/rewrite/research.md 1.3） */
import { hg, HgError } from './client'

export interface AkSession {
  uid: string
  roleToken: string
  akCookie: string
}

export interface AkCategory {
  id: string
  name: string
}

export interface AkRawRecord {
  poolId: string
  poolName: string
  charId: string
  charName: string
  rarity: number
  isNew: boolean
  gachaTs: string
  pos: number
}

export interface AkHistoryPage {
  list: AkRawRecord[]
  hasMore: boolean
}

export async function roleLogin(uid: string, u8Token: string): Promise<AkSession> {
  const { akCookie } = await hg('ak', '/user/api/role/login', {
    body: { token: u8Token, source_from: '', share_type: '', share_by: '' },
  })
  if (!akCookie) throw new HgError('auth', '角色登录没有返回会话 Cookie，请重新登录')
  return { uid, roleToken: u8Token, akCookie }
}

export async function fetchCategories(session: AkSession): Promise<AkCategory[]> {
  const { data } = await hg<AkCategory[]>('ak', '/user/api/inquiry/gacha/cate', {
    query: { uid: session.uid },
    roleToken: session.roleToken,
    akCookie: session.akCookie,
  })
  // 类别名里带换行（如“限定寻访\n庆典”）
  return data.map((c) => ({ id: c.id, name: c.name.replace(/\s+/g, ' ').trim() }))
}

export async function fetchHistoryPage(
  session: AkSession,
  category: string,
  cursor?: { pos: number; gachaTs: string },
  size = 50,
): Promise<AkHistoryPage> {
  const { data } = await hg<AkHistoryPage>('ak', '/user/api/inquiry/gacha/history', {
    query: { uid: session.uid, category, size, pos: cursor?.pos, gachaTs: cursor?.gachaTs },
    roleToken: session.roleToken,
    akCookie: session.akCookie,
  })
  return { list: data.list ?? [], hasMore: Boolean(data.hasMore) }
}

/** 官网“源石记录”页的一条记录（时间为秒；只能查询最近 30 天、最多 100 条） */
export interface AkDiamondRecord {
  operation: string
  changeNum: number
  after: number
  eventTs: number | string
  pos: number
}

export async function fetchDiamondPage(
  session: AkSession,
  cursor?: { pos: number; eventTs: number | string },
  size = 10,
): Promise<{ list: AkDiamondRecord[]; hasMore: boolean }> {
  const { data } = await hg<{ list?: AkDiamondRecord[]; hasMore?: boolean }>('ak', '/user/api/inquiry/diamond', {
    query: { uid: session.uid, size, pos: cursor?.pos, eventTs: cursor?.eventTs },
    roleToken: session.roleToken,
    akCookie: session.akCookie,
  })
  return { list: data?.list ?? [], hasMore: Boolean(data?.hasMore) }
}

/** 官网“充值记录”页的一条记录（金额为分，时间为秒；只能查询最近 30 天、最多 30 条） */
export interface AkOrder {
  orderId: string
  productName: string
  amount: number
  /** 0 为 iOS，1 为安卓 */
  platform: number
  payTime: number
}

/** 明日方舟在鹰角 U8 支付服务中的 appCode（取自官网用户中心加载的 hg-account-web-sdk） */
const AK_U8_APP_CODE = '9aa9768a549ddaa186b7'

/**
 * 充值记录由鹰角的 U8 支付服务提供，有两种查询方式：
 *   1. 用这个角色的 u8 token 查询（只对应这一个角色，官服、B 服都适用）；
 *   2. 官网的做法：用通行证账号 token 查询官服角色。
 * 先用第一种；不被接受时，官服角色再用第二种。
 */
export async function fetchRecentOrders(u8Token: string, officialAccountToken?: string): Promise<AkOrder[]> {
  try {
    const { data } = await hg<AkOrder[] | null>('u8', '/u8/pay/v1/recent', { body: { token: u8Token } })
    return data ?? []
  } catch (error) {
    const rejected = error instanceof HgError && (error.kind === 'auth' || error.kind === 'upstream')
    if (!rejected || !officialAccountToken) throw error
  }
  const { data } = await hg<AkOrder[] | null>('u8', '/u8/pay/v1/recent', {
    body: { appCode: AK_U8_APP_CODE, channelMasterId: 1, channelToken: { token: officialAccountToken } },
  })
  return data ?? []
}
