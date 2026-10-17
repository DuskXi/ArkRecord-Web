/** 终末地 ef-webview 背后的寻访记录与卡池信息接口（详见 docs/rewrite/research.md 2.2） */
import type { EfPoolInfo } from '../types'
import { hg } from './client'

/** 国服固定为 1 */
const SERVER_ID = '1'
const LANG = 'zh-cn'

export const DEFAULT_CHAR_POOL_TYPES = [
  'E_CharacterGachaPoolType_Special',
  'E_CharacterGachaPoolType_Rerun',
  'E_CharacterGachaPoolType_Joint',
  'E_CharacterGachaPoolType_Standard',
  'E_CharacterGachaPoolType_Beginner',
]

export interface EfRawRecord {
  poolId: string
  poolName: string
  charId?: string
  charName?: string
  weaponId?: string
  weaponName?: string
  rarity: number
  isNew: boolean
  isFree?: boolean
  gachaTs: string
  seqId: string
  kind?: string
  poolType?: string | null
  /** 赠送条目显示的名字（官方页面优先显示它；赠送条目一般没有 charName / weaponName） */
  nameText?: string
}

export interface EfPage {
  list: EfRawRecord[]
  hasMore: boolean
}

function common(token: string) {
  return { token, server_id: SERVER_ID, lang: LANG }
}

export async function fetchCharPoolTypes(token: string): Promise<string[]> {
  try {
    const { data } = await hg<{ tabs?: { poolType: string }[] }>('ef', '/api/record/char/meta', { query: common(token) })
    const types = (data.tabs ?? []).map((t) => t.poolType).filter(Boolean)
    return [...new Set([...types, ...DEFAULT_CHAR_POOL_TYPES])]
  } catch {
    return DEFAULT_CHAR_POOL_TYPES
  }
}

export async function fetchCharPage(token: string, poolType: string, seqId?: string): Promise<EfPage> {
  const { data } = await hg<EfPage>('ef', '/api/record/char', {
    query: { ...common(token), pool_type: poolType, seq_id: seqId },
  })
  return { list: data.list ?? [], hasMore: Boolean(data.hasMore) }
}

export async function fetchWeaponPools(token: string): Promise<{ poolId: string; poolName: string; poolType: string }[]> {
  const { data } = await hg<{ poolId: string; poolName: string; poolType: string }[]>('ef', '/api/record/weapon/pool', {
    query: common(token),
  })
  return data ?? []
}

export async function fetchWeaponPage(token: string, poolId: string, seqId?: string): Promise<EfPage> {
  const { data } = await hg<EfPage>('ef', '/api/record/weapon', {
    query: { ...common(token), pool_id: poolId, seq_id: seqId },
  })
  return { list: data.list ?? [], hasMore: Boolean(data.hasMore) }
}

interface RawContent {
  pool: {
    pool_gacha_type: 'char' | 'weapon'
    pool_name: string
    pool_type: string
    up6_name?: string
    up6_image?: string
    up6_avatar?: string
    up5_name?: string
    all?: { id: string; name: string; rarity: number }[]
  }
}

/** 卡池详情，不需要 token */
export async function fetchPoolContent(poolId: string): Promise<EfPoolInfo> {
  const { data } = await hg<RawContent>('ef', '/api/content', {
    query: { lang: LANG, pool_id: poolId, server_id: SERVER_ID },
  })
  const pool = data.pool
  return {
    poolId,
    poolName: pool.pool_name,
    poolType: pool.pool_type,
    gachaType: pool.pool_gacha_type,
    up6Name: pool.up6_name || undefined,
    up6Image: pool.up6_image || undefined,
    up6Avatar: pool.up6_avatar || undefined,
    up5Names: pool.up5_name ? pool.up5_name.split(/[,，、/]/).map((s) => s.trim()).filter(Boolean) : undefined,
    items: pool.all ?? [],
    fetchedAt: Date.now(),
  }
}
