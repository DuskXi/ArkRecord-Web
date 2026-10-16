export type Game = 'arknights' | 'endfield'

/** 抽到 6★ 的叫法：明日方舟的 6★ 是金色，叫“出金”；终末地的 6★ 是红色，叫“出红” */
export const SIX_TERM: Record<Game, string> = {
  arknights: '出金',
  endfield: '出红',
}

export const GAME_LABEL: Record<Game, string> = {
  arknights: '明日方舟',
  endfield: '终末地',
}

/** 一个游戏角色（同一个鹰角通行证下可以有多个） */
export interface Account {
  /** `${game}:${uid}` */
  id: string
  game: Game
  uid: string
  nickName: string
  /** 渠道名，如“官服”“bilibili服” */
  channelName?: string
  isOfficial?: boolean
  createdAt: number
  lastSyncAt?: number
  /** 鹰角通行证的账号 token，只在用户选择“记住登录”时保存在本地 */
  accountToken?: string
}

/** 明日方舟的一次寻访结果（接口原始字段 + 本地补充字段） */
export interface AkPull {
  accountId: string
  /** `${poolId}:${charId}:${gachaTs}:${pos}`；旧版迁移的数据为 `legacy:${秒级时间}:${序号}` */
  key: string
  poolId: string | null
  poolName: string
  /** gacha/cate 的类别 id */
  category?: string
  charId: string | null
  charName: string
  /** 与接口一致：从 0 开始，5 表示 6★ */
  rarity: number
  isNew: boolean
  /** 毫秒时间戳 */
  gachaTs: number
  /** 秒级时间戳，用于和旧版数据跨格式去重 */
  tsSec: number
  pos: number
  source: 'api' | 'legacy' | 'import'
}

/** 终末地的一次寻访结果 */
export interface EfPull {
  accountId: string
  /** `${type}:${poolId}:${seqId}` */
  key: string
  type: 'char' | 'weapon'
  poolId: string
  poolName: string
  /** 角色池为 pool_type（E_CharacterGachaPoolType_*），武器池为 normal / rerun 等 */
  poolType: string
  itemId: string
  itemName: string
  /** 4–6 */
  rarity: number
  isNew: boolean
  isFree: boolean
  /** 'draw' 为真实抽取，'gift_*' 为赠送条目 */
  kind: string
  gachaTs: number
  seqId: string
  source: 'api' | 'import'
}

/** 明日方舟旧版的源石 / 充值记录，原样保留以便以后接入新接口时合并 */
export interface AkLedgerEntry {
  accountId: string
  kind: 'stone' | 'recharge'
  key: string
  ts: number
  raw: unknown
}

/** 终末地卡池信息（来自 ef-webview /api/content，按 poolId 缓存） */
export interface EfPoolInfo {
  poolId: string
  poolName: string
  poolType: string
  gachaType: 'char' | 'weapon'
  up6Name?: string
  up6Image?: string
  up6Avatar?: string
  up5Names?: string[]
  items: { id: string; name: string; rarity: number }[]
  fetchedAt: number
}

export interface Snapshot {
  id?: number
  createdAt: number
  reason: string
  /** 导出格式的 JSON 字符串 */
  payload: string
}
