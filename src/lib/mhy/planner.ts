/**
 * 米哈游的抽卡规划：每抽概率用按官方数字推算的曲线（models.ts，非官方），UP 和大保底按官方规则（up.ts）。
 * 原神「捕获明光」官方没有公布概率，不计入，实际得到 UP 角色的机会比算出来的略高。
 */
import type { RateFn } from '../stats/pity'
import type { PlanPreset } from '../stats/planner'
import { mhyRate } from './models'
import type { MhyGame } from './types'

const ANY: PlanPreset = { id: 'any', label: '任意 5★', upShare: 0, note: '只计算 5★ 出货概率' }

const UP_CHARACTER: PlanPreset = {
  id: 'up',
  label: '本期 UP 角色',
  upShare: 0.5,
  fallback: true,
  note: '出 5★ 时 50% 是 UP；歪了之后下一个 5★ 必是 UP（大保底）',
}

export const MHY_PRESETS: Record<MhyGame, Record<'char' | 'weapon', readonly PlanPreset[]>> = {
  genshin: {
    char: [ANY, { ...UP_CHARACTER, note: `${UP_CHARACTER.note}。不含「捕获明光」：官方没有公布它的概率，实际机会比这里略高` }],
    weapon: [
      ANY,
      { id: 'up', label: 'UP 武器（两把任一）', upShare: 0.75, fallback: true, note: '出 5★ 武器时 75% 是两把 UP 之一；不是的话下一个必是 UP 之一（大保底）' },
      {
        id: 'path',
        label: '定轨的武器',
        upShare: 0.375,
        fallback: true,
        guaranteedShare: 0.5,
        note: '定轨后抽到不是定轨的 5★ 武器得 1 点命定值，下一个 5★ 武器必是定轨的那把；大保底时两把 UP 各一半。命定值换期清空，这里按同一期计算',
      },
    ],
  },
  starrail: {
    char: [ANY, UP_CHARACTER],
    weapon: [ANY, { id: 'up', label: '本期 UP 光锥', upShare: 0.75, fallback: true, note: '出 5★ 光锥时 75% 是 UP；歪了之后下一个 5★ 光锥必是 UP（大保底）' }],
  },
}

export interface MhyPlanner {
  presets: readonly PlanPreset[]
  rate: RateFn
  includeIsolated: boolean
  resources: boolean
}

/** 游戏档案的 planner 字段；推算不出曲线时为 null（不显示规划） */
export function mhyPlanner(game: MhyGame, scope: 'char' | 'weapon'): MhyPlanner | null {
  const rate = mhyRate(game, scope)
  return rate ? { presets: MHY_PRESETS[game][scope], rate, includeIsolated: false, resources: false } : null
}
