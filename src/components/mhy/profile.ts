/**
 * 原神、星铁的游戏档案（接口见 src/lib/game-profile.ts）：鹰角的统计页面按它显示。只在桌面版里。
 * 没有的功能给 null / false：图鉴要物品数据，还没做（docs/desktop/plan.md）。
 * 抽卡规划按角色 / 武器范围不同，由记录来源（records.ts）用 mhyPlanner 填上。
 */
import { formatNumber } from '@/lib/format'
import type { GameProfile } from '@/lib/game-profile'
import { MHY_GAME_LABEL, type MhyGame } from '@/lib/mhy/types'

/** 什么时候看不出歪没歪（规则见 src/lib/mhy/up.ts） */
const UP_UNKNOWN = '还没有能判断歪没歪的小保底 5★：只判断简体中文的记录；每个卡池第一个 UP 看不出是小保底还是大保底，不计入。'

const EMPTY_HINT = { description: '点右上角的“读取”，从游戏缓存读取抽卡记录。官方接口只能查询最近一段时间的记录，读到的都会保存在本机。', importLink: false }

export const MHY_PROFILES: Record<MhyGame, GameProfile> = {
  genshin: {
    id: 'genshin',
    label: MHY_GAME_LABEL.genshin,
    topStar: 5,
    stars: [5, 4, 3],
    topTerm: '出金',
    nouns: { char: '角色', weapon: '武器', charEn: 'CHARACTERS', weaponEn: 'WEAPONS' },
    recordName: '祈愿记录',
    playerTitle: 'TRAVELER',
    reportTitle: 'GENSHIN IMPACT',
    hasScope: true,
    hasLedger: false,
    emptyHint: EMPTY_HINT,
    guaranteeTitle: '大小保底',
    fiftyFifty: true,
    upUnknownNote: UP_UNKNOWN,
    giftNote: null,
    // 一抽 160 原石（纠缠之缘、相遇之缘）
    spendNote: (pulls) => `约 ${formatNumber(pulls * 160)} 原石`,
    poolFilters: [{ value: 'all', label: '全部' }],
    // 只有 5★ 有按官方数字推算的模型；4★、3★ 的理论占比先不写
    rarityRates: (top) => ({ 5: top }),
    codex: null,
    planner: null,
  },
  starrail: {
    id: 'starrail',
    label: MHY_GAME_LABEL.starrail,
    topStar: 5,
    stars: [5, 4, 3],
    topTerm: '出金',
    nouns: { char: '角色', weapon: '光锥', charEn: 'CHARACTERS', weaponEn: 'LIGHT CONES' },
    recordName: '跃迁记录',
    playerTitle: 'TRAILBLAZER',
    reportTitle: 'HONKAI: STAR RAIL',
    hasScope: true,
    hasLedger: false,
    emptyHint: EMPTY_HINT,
    guaranteeTitle: '大小保底',
    fiftyFifty: true,
    upUnknownNote: UP_UNKNOWN,
    giftNote: null,
    // 一抽 160 星琼（星轨专票、星轨通票）
    spendNote: (pulls) => `约 ${formatNumber(pulls * 160)} 星琼`,
    poolFilters: [{ value: 'all', label: '全部' }],
    rarityRates: (top) => ({ 5: top }),
    codex: null,
    planner: null,
  },
}
