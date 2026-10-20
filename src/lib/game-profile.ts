/**
 * 游戏档案：统计页面里因游戏而不同的地方（名称、最高星级、叫法、有哪些功能）。
 * 页面和组件按档案走，不写“明日方舟 / 终末地”的分支；记录来源（useRecords）带着当前游戏的档案。
 * 鹰角两款在这里；米哈游两款在 src/lib/mhy，只在桌面版里。
 * 只取决于鹰角游戏数据的地方（图鉴的干员列表、森空岛截图）仍按记录来源的 game 区分。
 */
import { formatNumber } from './format'
import { arknightsRate, endfieldRate, type RateFn } from './stats/pity'
import { AK_PRESETS, EF_PRESETS, type PlanPreset } from './stats/planner'
import { type Game, GAME_LABEL, SIX_TERM } from './types'

/** 统计里记的星级 */
export type Star = 3 | 4 | 5 | 6

/** 从最高星往下的星级（到 3★ 为止）：鹰角 6 / 5 / 4 / 3，米哈游 5 / 4 / 3 */
export function starsFrom(top: number): Star[] {
  return ([6, 5, 4, 3] as const).filter((s) => s <= top)
}

/** 卡池页的筛选 */
export type PoolFilter = 'all' | 'limited' | 'standard' | 'kernel' | 'weapon'

export interface GameProfile {
  /** 游戏 id：头像、游戏数据按它取 */
  readonly id: string
  /** 游戏名 */
  readonly label: string
  /** 最高星级（和统计引擎的 PityModel.topStar 一致） */
  readonly topStar: Star
  /** 记录里会出现的星级，从高到低（终末地没有 3★） */
  readonly stars: readonly number[]
  /** 抽到最高星的叫法：明日方舟、原神、星铁是“出金”，终末地是“出红” */
  readonly topTerm: string
  /** 角色和武器的叫法（中文、总览上的英文）；有角色 / 武器范围切换的游戏两个都用 */
  readonly nouns: { readonly char: string; readonly weapon: string; readonly charEn: string; readonly weaponEn: string }
  /** 记录叫什么：寻访记录 / 祈愿记录 / 跃迁记录 */
  readonly recordName: string
  /** 总览上玩家的称呼 */
  readonly playerTitle: string
  /** 分享图的英文抬头 */
  readonly reportTitle: string
  /** 角色和武器分开看（页面右上角有“角色 / 武器”切换） */
  readonly hasScope: boolean
  /** 有源石与充值记录（只有明日方舟） */
  readonly hasLedger: boolean
  /** 总览没有记录时的提示；importLink：给出“去导入”（数据页）的按钮 */
  readonly emptyHint: { readonly description: string; readonly importLink: boolean }
  /** 累计寻访赠送是什么；没有赠送的游戏为 null */
  readonly giftNote: string | null
  /** 总览“抽数”那一格的说明 */
  readonly spendNote: (pulls: number) => string
  /** 卡池页的筛选（第一项是“全部”） */
  readonly poolFilters: readonly { readonly value: PoolFilter; readonly label: string }[]
  /** 各星级的期望占比（分析页的对比线）；最高星的概率由保底模型算出后传进来。没有的星级为 0，不知道的不写 */
  readonly rarityRates: (top: number) => Partial<Record<3 | 4 | 5 | 6, number>>
  /** 图鉴：职业筛选、潜能（只有角色）、“其他途径获得”的说明；没有图鉴的游戏为 null */
  readonly codex: {
    readonly professionFilter: boolean
    readonly potential: boolean
    readonly otherSources: { readonly char: string; readonly weapon: string }
  } | null
  /** 抽卡规划：预设、概率、是否包含不共享保底的卡池、是否有“按资源换算”；没有规划的游戏为 null */
  readonly planner: {
    readonly presets: readonly PlanPreset[]
    readonly rate: RateFn
    readonly includeIsolated: boolean
    readonly resources: boolean
  } | null
}

const HG_EMPTY_HINT = { description: '点击右上角的“同步”从鹰角服务器拉取最近 90 天的记录，或在“数据”页导入旧数据。', importLink: true }

export const HG_PROFILES: Record<Game, GameProfile> = {
  arknights: {
    id: 'arknights',
    label: GAME_LABEL.arknights,
    topStar: 6,
    stars: [6, 5, 4, 3],
    topTerm: SIX_TERM.arknights,
    nouns: { char: '干员', weapon: '武器', charEn: 'OPERATORS', weaponEn: 'WEAPONS' },
    recordName: '寻访记录',
    playerTitle: 'DOCTOR',
    reportTitle: 'RHODES ISLAND',
    hasScope: false,
    hasLedger: true,
    emptyHint: HG_EMPTY_HINT,
    giftNote: '限定池累计 300 抽赠送',
    spendNote: (pulls) => `约 ${formatNumber(pulls * 600)} 合成玉`,
    poolFilters: [
      { value: 'all', label: '全部' },
      { value: 'limited', label: '限定 / 联动' },
      { value: 'standard', label: '标准' },
      { value: 'kernel', label: '中坚' },
    ],
    rarityRates: (top) => ({ 6: top, 5: 0.08, 4: 0.5, 3: 0.42 - top }),
    codex: {
      professionFilter: true,
      potential: false,
      // 明日方舟没有武器范围，weapon 用不到
      otherSources: { char: '公开招募、活动赠送、兑换所、剧情奖励等途径获得的干员', weapon: '' },
    },
    planner: { presets: AK_PRESETS, rate: arknightsRate, includeIsolated: true, resources: true },
  },
  endfield: {
    id: 'endfield',
    label: GAME_LABEL.endfield,
    topStar: 6,
    stars: [6, 5, 4],
    topTerm: SIX_TERM.endfield,
    nouns: { char: '干员', weapon: '武器', charEn: 'OPERATORS', weaponEn: 'WEAPONS' },
    recordName: '寻访记录',
    playerTitle: 'ENDMINISTRATOR',
    reportTitle: 'ENDFIELD',
    hasScope: true,
    hasLedger: false,
    emptyHint: HG_EMPTY_HINT,
    giftNote: '信物赠礼，潜能 +1',
    spendNote: () => '含免费十连，不含赠送',
    poolFilters: [
      { value: 'all', label: '全部' },
      { value: 'limited', label: '特许 / 重构' },
      { value: 'standard', label: '基础' },
      { value: 'weapon', label: '武器' },
    ],
    rarityRates: (top) => ({ 6: top, 5: 0.08, 4: 0.92 - top, 3: 0 }),
    codex: {
      professionFilter: false,
      potential: true,
      otherSources: { char: '剧情、活动赠送等途径获得的干员', weapon: '活动、商店、剧情奖励等途径获得的武器' },
    },
    planner: { presets: EF_PRESETS, rate: endfieldRate, includeIsolated: false, resources: false },
  },
}
