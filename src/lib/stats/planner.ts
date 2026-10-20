/**
 * 抽卡规划：给定当前垫抽和计划抽数，精确计算出货概率（逐抽动态规划，不做模拟）。
 *
 * 模型：
 *   - 每抽出 6★ 的概率由保底函数 rate(距上个 6★ 的抽数) 给出；
 *   - 出 6★ 时，以 upShare 的概率是目标（当期 UP）；
 *   - spark：在本池累计到第 at 抽时，若还没得到目标，则必定得到（定向保底 / 累计赠送）；
 *   - fallback（米哈游的大保底、神铸定轨）：出了不是目标的最高星之后，下一个最高星必定是目标。
 */
import type { RateFn } from './pity'

export interface PlanInput {
  rate: RateFn
  hardPity: number
  /** 当前已垫抽数（距上个 6★） */
  pity: number
  /** 计划抽数 */
  pulls: number
  /** 6★ 中目标所占的比例，0 表示不计算目标 */
  upShare: number
  /**
   * 定向保底：本池第 at 抽时若还没得到目标则必定得到；done 为本池已抽数。
   * gift 为 true 表示是累计赠送（不是抽出来的，不影响 6★ 计数和保底）。
   */
  spark?: { at: number; done: number; gift?: boolean }
  /**
   * 大保底：出了不是目标的最高星之后，下一个最高星必定是目标。guaranteed 为 true 表示现在已经是大保底：
   * 下一个最高星以 guaranteedShare（默认 1）的概率是目标，不是的话再下一个必定是（原神定轨武器：大保底时两把 UP 各一半）。
   */
  fallback?: { guaranteed: boolean; guaranteedShare?: number }
}

export interface PlanResult {
  /** 计划抽数内至少出 1 个 6★ 的概率 */
  pSix: number
  expectedSix: number
  /** P(6★ 个数 = k)，最后一项是“≥ 该数”的合计 */
  sixCountPmf: number[]
  /** 计划抽数内得到目标的概率；upShare 为 0 时为 null */
  pTarget: number | null
  /** sixCdf[n-1] = n 抽内至少一个 6★ 的概率；targetCdf 同理（upShare 为 0 时为空） */
  sixCdf: number[]
  targetCdf: number[]
  /** 得到目标所需抽数的中位数、90% 分位（在计算范围内达不到时为 null） */
  targetMedian: number | null
  targetP90: number | null
}

const MAX_HORIZON = 2000
const MAX_COUNT = 60

export function plan(input: PlanInput): PlanResult {
  const hard = input.hardPity
  const pity = clampInt(input.pity, 0, hard - 1)
  const pulls = clampInt(input.pulls, 0, MAX_HORIZON)
  const share = Math.min(1, Math.max(0, input.upShare))
  const rates = Array.from({ length: hard }, (_, k) => Math.min(1, Math.max(0, input.rate(k + 1))))
  const sparkLeft = share > 0 && input.spark ? input.spark.at - input.spark.done : Infinity
  const gift = input.spark?.gift ?? false
  const fallback = share > 0 ? input.fallback : undefined
  const guaranteedShare = Math.min(1, Math.max(0, fallback?.guaranteedShare ?? 1))

  // 状态：目标的进度 g × 当前垫抽 k × 已出 6★ 个数 c（超过 MAX_COUNT 的合并到最后一格）
  // g：0 还没得到；1 已得到；2 大保底（下一个必是目标）；3 大保底但下一个只有 guaranteedShare 是目标
  const G = fallback ? 4 : 2
  const C = MAX_COUNT + 1
  const at = (g: number, k: number, c: number) => (g * hard + k) * C + Math.min(c, MAX_COUNT)
  let state = new Float64Array(G * hard * C)
  state[at(fallback?.guaranteed ? (guaranteedShare < 1 ? 3 : 2) : 0, pity, 0)] = 1
  /** 出了一个最高星之后，目标进度怎么变：[新的 g, 概率] */
  const onTop = (g: number): [number, number][] => {
    if (g === 1 || share === 0) return [[g, 1]]
    if (g === 2) return [[1, 1]]
    if (g === 3) return [[1, guaranteedShare], [2, 1 - guaranteedShare]]
    return [[1, share], [fallback ? 2 : 0, 1 - share]]
  }

  let horizon = Math.max(pulls, 1)
  if (share > 0) horizon = Number.isFinite(sparkLeft) && sparkLeft > 0 ? Math.max(horizon, sparkLeft) : MAX_HORIZON

  let expectedSix = 0
  let sixCountPmf: number[] = [1]
  const sixCdf: number[] = []
  const targetCdf: number[] = []

  for (let n = 1; n <= horizon; n++) {
    const next = new Float64Array(state.length)
    const sparkNow = n === sparkLeft
    let six = 0
    for (let g = 0; g < G; g++) {
      for (let k = 0; k < hard; k++) {
        for (let c = 0; c < C; c++) {
          const m = state[at(g, k, c)]!
          if (m === 0) continue
          if (sparkNow && g !== 1 && !gift) {
            // 这一抽必定是目标 6★
            next[at(1, 0, c + 1)]! += m
            six += m
            continue
          }
          const g2 = sparkNow && g !== 1 ? 1 : g
          const p = rates[k]!
          for (const [g3, q] of onTop(g2)) if (q > 0) next[at(g3, 0, c + 1)]! += m * p * q
          six += m * p
          if (k + 1 < hard) next[at(g2, k + 1, c)]! += m * (1 - p)
        }
      }
    }
    state = next

    let none = 0
    let got = 0
    for (let g = 0; g < G; g++) for (let k = 0; k < hard; k++) none += state[at(g, k, 0)]!
    for (let i = hard * C; i < 2 * hard * C; i++) got += state[i]!
    sixCdf.push(Math.min(1, Math.max(0, 1 - none)))
    if (share > 0) targetCdf.push(Math.min(1, got))
    if (n <= pulls) expectedSix += six
    if (n === pulls) {
      sixCountPmf = Array.from({ length: C }, () => 0)
      for (let g = 0; g < G; g++) for (let k = 0; k < hard; k++) for (let c = 0; c < C; c++) sixCountPmf[c]! += state[at(g, k, c)]!
      while (sixCountPmf.length > 2 && sixCountPmf.at(-1)! < 1e-9) sixCountPmf.pop()
    }
    if (n >= pulls && (share === 0 || got > 0.999)) break
  }

  return {
    pSix: pulls === 0 ? 0 : sixCdf[pulls - 1]!,
    expectedSix,
    sixCountPmf,
    pTarget: share > 0 ? (pulls === 0 ? 0 : targetCdf[pulls - 1]!) : null,
    sixCdf,
    targetCdf,
    targetMedian: firstReaching(targetCdf, 0.5),
    targetP90: firstReaching(targetCdf, 0.9),
  }
}

function firstReaching(cdf: number[], q: number): number | null {
  const i = cdf.findIndex((p) => p >= q - 1e-12)
  return i === -1 ? null : i + 1
}

function clampInt(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(x) ? x : 0)))
}

export interface PlanPreset {
  id: string
  label: string
  /** 6★ 中目标的比例 */
  upShare: number
  /** 本池第几抽必得目标 */
  sparkAt?: number
  /** 累计赠送（不是抽出来的） */
  gift?: boolean
  /** 米哈游的大保底 / 定轨：不是目标的最高星之后，下一个必是目标（见 PlanInput.fallback） */
  fallback?: boolean
  /** 现在是大保底时，下一个最高星是目标的概率（默认 1） */
  guaranteedShare?: number
  note: string
}

/** 规则见 docs/rewrite/research.md 1.8、2.3 */
export const AK_PRESETS: PlanPreset[] = [
  { id: 'any', label: '任意 6★', upShare: 0, note: '只计算 6★ 出货概率' },
  { id: 'single', label: '单 UP 池', upShare: 0.5, sparkAt: 150, note: 'UP 占 6★ 的 50%，本池第 150 抽必得 UP' },
  { id: 'limited', label: '限定池的一名 UP', upShare: 0.35, sparkAt: 300, gift: true, note: '两名 UP 各占 35%，累计 300 抽赠送限定干员' },
  { id: 'linkage', label: '联动池', upShare: 0.5, sparkAt: 120, note: '联动干员占 6★ 的 50%，120 抽必得' },
  { id: 'double', label: '双 UP 池（任一名）', upShare: 0.5, sparkAt: 150, note: '两名 UP 合计 50%，150 抽必得其中一名' },
  { id: 'custom', label: '自定义', upShare: 0.5, note: '自行设置 UP 比例和定向保底' },
]

export const EF_PRESETS: PlanPreset[] = [
  { id: 'any', label: '任意 6★', upShare: 0, note: '只计算 6★ 出货概率' },
  { id: 'special', label: '特许寻访 UP', upShare: 0.5, sparkAt: 120, note: 'UP 占 6★ 的 50%，同一卡池第 120 抽必得（不继承）' },
  { id: 'custom', label: '自定义', upShare: 0.5, note: '自行设置 UP 比例和定向保底' },
]
