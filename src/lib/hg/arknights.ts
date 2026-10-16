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
    method: 'POST',
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
