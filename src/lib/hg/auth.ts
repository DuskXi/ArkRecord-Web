/**
 * 鹰角通行证认证流程（明日方舟与终末地共用）：
 *   账号 token → OAuth token（grant）→ 查询绑定的游戏角色 → 为某个角色换取 u8 token
 * 详见 docs/rewrite/research.md 1.2、2.1。
 */
import type { Game } from '../types'
import { hg } from './client'

/** 鹰角用户中心的 appCode（type 1 返回可用于换取 u8 token 的 OAuth token） */
const USER_CENTER_APP_CODE = 'be36d44aa36bfb5b'

export interface Binding {
  game: Game
  uid: string
  nickName: string
  channelName?: string
  channelMasterId?: number
  isOfficial?: boolean
  isDefault?: boolean
}

interface RawBinding {
  uid: string | number
  nickName?: string
  nickname?: string
  channelName?: string
  channelMasterId?: number
  isOfficial?: boolean
  isDefault?: boolean
  roles?: { nickName?: string; nickname?: string; serverId?: string; serverName?: string }[]
}

export async function grantOAuthToken(accountToken: string): Promise<string> {
  const { data } = await hg<{ token: string }>('as', '/user/oauth2/v2/grant', {
    body: { token: accountToken, appCode: USER_CENTER_APP_CODE, type: 1 },
  })
  return data.token
}

export async function listBindings(oauthToken: string, game: Game): Promise<Binding[]> {
  const { data } = await hg<{ list: { appCode: string; bindingList: RawBinding[] }[] }>(
    'binding',
    '/account/binding/v1/binding_list',
    { query: { token: oauthToken, appCode: game } },
  )
  const entry = data.list.find((item) => item.appCode === game)
  return (entry?.bindingList ?? []).map((raw) => {
    const role = raw.roles?.[0]
    return {
      game,
      uid: String(raw.uid),
      nickName: raw.nickName ?? raw.nickname ?? role?.nickName ?? role?.nickname ?? String(raw.uid),
      channelName: raw.channelName,
      channelMasterId: raw.channelMasterId,
      isOfficial: raw.isOfficial,
      isDefault: raw.isDefault,
    }
  })
}

export async function getU8Token(oauthToken: string, uid: string): Promise<string> {
  const { data } = await hg<{ token: string }>('binding', '/account/binding/v1/u8_token_by_uid', {
    body: { token: oauthToken, uid },
  })
  return data.token
}

/** 从用户粘贴的内容里取出账号 token：支持完整 JSON（{"code":0,"data":{"content":"..."}}）或 token 本身 */
export function parseAccountToken(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { data?: { content?: unknown; token?: unknown } }
    const value = parsed?.data?.content ?? parsed?.data?.token
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return /^[\w+/=.-]{16,}$/.test(text) ? text : null
  }
}
