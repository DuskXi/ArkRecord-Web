/**
 * 米哈游的保底模型：只用官方公布的数字（维护者 2026-10-19：“只显示官方数字 + 按照官方的数字和统计学算法计算出的
 * 官方理论预期，并且标注为推算出来，非官方”）。
 *
 * 官方公布的（游戏内“祈愿详情 / 跃迁详情”的概率公示，多处转载一致；以游戏内为准）：
 *   原神   角色活动、常驻、集录：5★ 基础 0.600%，综合（含保底）1.600%，最多 90 抽必出
 *          武器活动：            5★ 基础 0.700%，综合 1.850%，最多 80 抽必出
 *   星铁   角色活动、常驻：      5★ 基础 0.600%，综合 1.600%，最多 90 抽必出
 *          光锥活动：            5★ 基础 0.800%，综合 1.870%，最多 80 抽必出
 * 官方没有公布每一抽的概率曲线（“第几抽起概率上升”是社区统计的，不用）。
 *
 * 推算（标注为非官方）：假设曲线最简单的形状——先保持基础概率，从某一抽起线性上升，到保底那一抽为 100%；
 * 上升的起点取让“平均多少抽出一个 5★”等于 1 ÷ 官方综合概率的那一抽。得到的分布用于期望、运气百分位、抽卡规划。
 * 对不上官方综合概率（误差超过 2%）时不建模型。新手池、联动池没有建模。
 */
import type { PityModel } from '../stats/analyze'
import { distribution, type Distribution, type RateFn } from '../stats/pity'
import type { MhyGame } from './types'

export interface OfficialRates {
  /** 5★ 基础概率 */
  base: number
  /** 5★ 综合概率（含保底） */
  consolidated: number
  /** 最多多少抽必出 5★ */
  hardPity: number
}

const CHARACTER: OfficialRates = { base: 0.006, consolidated: 0.016, hardPity: 90 }

/** 官方公示的数字，按卡池组（types.ts 的 MHY_POOLS） */
export const OFFICIAL_RATES: Record<MhyGame, Partial<Record<string, OfficialRates>>> = {
  genshin: {
    character: CHARACTER,
    standard: CHARACTER,
    chronicled: CHARACTER,
    weapon: { base: 0.007, consolidated: 0.0185, hardPity: 80 },
  },
  starrail: {
    character: CHARACTER,
    standard: CHARACTER,
    lightcone: { base: 0.008, consolidated: 0.0187, hardPity: 80 },
  },
}

/** 先保持基础概率、从第 start 抽起线性上升、第 hardPity 抽为 100% 的曲线 */
export function rampRate(rates: OfficialRates, start: number): RateFn {
  const step = (1 - rates.base) / (rates.hardPity - start + 1)
  return (n) => (n >= rates.hardPity ? 1 : n < start ? rates.base : Math.min(1, rates.base + step * (n - start + 1)))
}

export interface DerivedCurve {
  /** 从第几抽起概率上升（推算） */
  start: number
  dist: Distribution
  /** 这条曲线的综合概率（1 ÷ 平均抽数），和官方的对照 */
  consolidated: number
}

/** 按官方数字推算的曲线；对不上官方综合概率时返回 null */
export function deriveCurve(rates: OfficialRates): DerivedCurve | null {
  const target = 1 / rates.consolidated
  let best: DerivedCurve | null = null
  for (let start = 1; start <= rates.hardPity; start++) {
    const dist = distribution(rampRate(rates, start), rates.hardPity)
    if (!best || Math.abs(dist.mean - target) < Math.abs(best.dist.mean - target)) best = { start, dist, consolidated: 1 / dist.mean }
  }
  if (!best || Math.abs(best.consolidated - rates.consolidated) / rates.consolidated > 0.02) return null
  return best
}

const cache = new Map<OfficialRates, DerivedCurve | null>()
function cachedCurve(rates: OfficialRates): DerivedCurve | null {
  if (!cache.has(rates)) cache.set(rates, deriveCurve(rates))
  return cache.get(rates)!
}

/**
 * 记录页面用的保底模型：scope 是“角色”或“武器”（原神武器、星铁光锥）。
 * 没有官方的软保底，softPity 等于 hardPity（界面上不显示软保底标记）；dist 是推算的（derived）。
 */
export function mhyModel(game: MhyGame, scope: 'char' | 'weapon'): PityModel {
  const group = scope === 'char' ? 'character' : game === 'genshin' ? 'weapon' : 'lightcone'
  const rates = OFFICIAL_RATES[game][group]!
  const curve = cachedCurve(rates)
  return { dist: curve?.dist ?? null, softPity: rates.hardPity, hardPity: rates.hardPity, topStar: 5, derived: true }
}
