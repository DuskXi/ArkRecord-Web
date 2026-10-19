/**
 * 原神、崩坏：星穹铁道的记录（只在桌面版里用；网页版的构建里不能出现这个目录的模块，见 docs/desktop/plan.md）。
 *
 * 字段来自抽卡记录接口（2026-10-19 原神国服实测，见 plan.md 的“本机实测”）：
 *   count, gacha_type, id, item_id, item_type, lang, name, op_gacha_type, rank_type, time, uid
 * 星铁另有 gacha_id。记录主键是接口的 id（19 位数字，必须当字符串处理）。
 */

export type MhyGame = 'genshin' | 'starrail'

export const MHY_GAME_LABEL: Record<MhyGame, string> = {
  genshin: '原神',
  starrail: '崩坏：星穹铁道',
}

/** 一个米哈游游戏账号（没有昵称：抽卡记录接口不返回） */
export interface MhyAccount {
  /** `${game}:${uid}` */
  id: string
  game: MhyGame
  uid: string
  /** 区服：cn_gf01、os_usa、prod_gf_cn 等（来自抽卡链接或接口） */
  region: string
  /** hk4e_cn、hkrpg_global 等 */
  gameBiz: string
  /** 区服的 UTC 偏移（小时），把记录里的本地时间换算成时间戳 */
  utcOffset: number
  createdAt: number
  lastSyncAt?: number
}

/** 一条抽卡记录 */
export interface MhyPull {
  accountId: string
  /** 接口的 id（19 位数字字符串） */
  id: string
  /** 记录自己的 gacha_type（原神查 301 时会同时返回 301 和 400） */
  gachaType: string
  /** 所属卡池（查询用的类型）：原神 400 归入 301，其余与 gachaType 相同。统计、保底按它分组 */
  pool: string
  /** 接口的 op_gacha_type（含义还没确认，先原样保存） */
  opGachaType?: string
  /** 星铁的 gacha_id */
  gachaId?: string
  /** 原神基本是空的，要按名称对应 */
  itemId: string
  name: string
  /** 角色 / 武器 / 光锥 */
  itemType: string
  /** 3–5 */
  rank: number
  count: number
  /** 接口原样的时间（区服当地时间，YYYY-MM-DD HH:MM:SS） */
  time: string
  /** 换算后的毫秒时间戳 */
  ts: number
  lang: string
  source: 'api' | 'import'
}

export interface MhyPoolInfo {
  /** 查询用的 gacha_type */
  type: string
  name: string
  /** 和哪些卡池共用保底（同一组里连续计数） */
  group: string
  /** 走 getLdGachaLog（星铁联动池） */
  ld?: boolean
}

/** 各游戏要查的卡池（顺序即同步顺序，和后端 games.py 一致） */
export const MHY_POOLS: Record<MhyGame, readonly MhyPoolInfo[]> = {
  genshin: [
    { type: '301', name: '角色活动祈愿', group: 'character' },
    { type: '302', name: '武器活动祈愿', group: 'weapon' },
    { type: '200', name: '常驻祈愿', group: 'standard' },
    { type: '500', name: '集录祈愿', group: 'chronicled' },
    { type: '100', name: '新手祈愿', group: 'beginner' },
  ],
  starrail: [
    { type: '11', name: '角色活动跃迁', group: 'character' },
    { type: '12', name: '光锥活动跃迁', group: 'lightcone' },
    { type: '1', name: '常驻跃迁', group: 'standard' },
    { type: '21', name: '角色联动跃迁', group: 'collab-character', ld: true },
    { type: '22', name: '光锥联动跃迁', group: 'collab-lightcone', ld: true },
    { type: '2', name: '新手跃迁', group: 'beginner' },
  ],
}

/** 记录的 gacha_type 属于哪个卡池：原神的 400（角色活动祈愿-2）归入 301 */
export function poolOf(game: MhyGame, gachaType: string): string {
  return game === 'genshin' && gachaType === '400' ? '301' : gachaType
}

export function poolInfo(game: MhyGame, pool: string): MhyPoolInfo | undefined {
  return MHY_POOLS[game].find((p) => p.type === pool)
}

export const mhyAccountId = (game: MhyGame, uid: string) => `${game}:${uid}`
