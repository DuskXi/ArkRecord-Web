/**
 * 终末地的赠送条目：不是抽出来的，不计入任何寻访统计，单独列出。
 *
 * 寻访记录接口里，kind 以 gift 开头的是赠送（官方页面的显示方式见 ef-webview 的记录页）：
 *   - gift_operator_token：信物赠礼，当期 UP 6★ 的信物 ×1（= 该干员多一份，潜能 +1）
 *   - gift_intel_book：寻访情报书（下次特许寻访转为 10 张专有凭证），不是干员
 *   - gift_weapon：武器赠礼，gift_weapon_box：武库箱，gift：其他赠礼
 *
 * 信物赠礼的规则（官方卡池说明）：
 *   - 特许寻访：本期卡池内每累计寻访 240 次，额外获得当期 UP 6★ 的信物 ×1；卡池关闭后清零；
 *   - 重构寻访：同名重构寻访累计计数（继承到下一次同名重构寻访），每累计 240 次同样赠送；
 *   - 加急招募的免费十连不计入累计寻访次数。
 * 记录接口只能查到约 90 天，较早的赠送可能查不到；本地记录的抽数够 240 而没有对应的赠送条目时，按规则推算补上，
 * 标为“推算”。推算只会补“缺少的”：已有的赠送条目先算进去，不会重复。
 */
import type { EfMeta } from '../meta'
import type { EfPoolInfo, EfPull } from '../types'
import { efCharFamily, isGift } from './events'

export { isGift }

/** 每累计寻访多少次赠送一个当期 UP 信物（官方页面的 CHAR_UP_6_ITEM_TIME） */
export const TOKEN_EVERY = 240

export interface GiftEvent {
  key: string
  ts: number
  /** 同一时间内的顺序 */
  order: number
  /** 接口的 kind（gift_operator_token 等） */
  kind: string
  /** 显示用：信物赠礼 / 寻访情报书 / 武器赠礼 … */
  label: string
  itemId: string | null
  name: string
  /** 4–6；不是干员 / 武器时为 0 */
  star: number
  poolId: string
  poolName: string
  weapon: boolean
  /** 是否等于获得了这名干员 / 这把武器一份（信物、武器赠礼是；情报书、武库箱不是） */
  copy: boolean
  /** 记录里没有，按累计寻访次数推算出来的 */
  inferred: boolean
  /** 推算的：本池第几次累计寻访时赠送 */
  at?: number
}

const LABELS: Record<string, string> = {
  gift_operator_token: '信物赠礼',
  gift_intel_book: '寻访情报书',
  gift_weapon_box: '武库箱',
  gift_weapon: '武器赠礼',
  gift: '赠礼',
}

export function giftLabel(kind: string): string {
  return LABELS[kind] ?? '赠礼'
}

/** 这种赠送是否等于获得了该物品一份 */
function givesCopy(kind: string): boolean {
  return kind === 'gift_operator_token' || kind === 'gift_weapon'
}

/** 有信物赠礼的卡池：特许寻访（每期单独计数）、重构寻访（同名累计）。分组 id 用 poolId（同名重构寻访的 poolId 相同） */
function tokenPool(p: EfPull, meta: EfMeta | undefined): boolean {
  if (p.type !== 'char') return false
  const fam = efCharFamily(p.poolType, p.poolId, p.poolName, meta?.pools[p.poolId]?.t)
  return fam.family === 'ef:special' || fam.family === 'ef:rerun'
}

/** 当期 UP 6★：游戏数据表的 UP 名单优先，其次官方接口给的名字 */
function upItem(poolId: string, pools: Map<string, EfPoolInfo>, meta: EfMeta | undefined): { id: string | null; name: string; star: number } | null {
  const id = meta?.pools[poolId]?.up?.[0]
  if (id) return { id, name: meta?.items[id]?.n ?? pools.get(poolId)?.up6Name ?? id, star: meta?.items[id]?.r ?? 6 }
  const name = pools.get(poolId)?.up6Name
  if (!name) return null
  const known = Object.entries(meta?.items ?? {}).find(([key, item]) => key.startsWith('chr_') && item.n === name)
  return { id: known?.[0] ?? null, name, star: known?.[1].r ?? 6 }
}

function byTime(a: { ts: number; order: number }, b: { ts: number; order: number }): number {
  return a.ts - b.ts || a.order - b.order
}

/**
 * 终末地的全部赠送：记录里的，加上按规则推算、记录里缺少的信物赠礼。按时间排序。
 */
export function endfieldGifts(pulls: readonly EfPull[], pools: Map<string, EfPoolInfo>, meta?: EfMeta): GiftEvent[] {
  const out: GiftEvent[] = []
  for (const p of pulls) {
    if (!isGift(p)) continue
    const item = p.itemId ? meta?.items[p.itemId] : undefined
    const copy = givesCopy(p.kind) && Boolean(p.itemId || p.itemName)
    out.push({
      key: p.key,
      ts: p.gachaTs,
      order: Number(p.seqId) || 0,
      kind: p.kind,
      label: giftLabel(p.kind),
      itemId: p.itemId || null,
      name: p.itemName || item?.n || giftLabel(p.kind),
      star: copy ? p.rarity || item?.r || 0 : 0,
      poolId: p.poolId,
      poolName: p.poolName,
      weapon: p.type === 'weapon',
      copy,
      inferred: false,
    })
  }
  out.push(...inferTokens(pulls, pools, meta))
  return out.toSorted(byTime)
}

/** 按“每累计 240 次”推算记录里缺少的信物赠礼 */
export function inferTokens(pulls: readonly EfPull[], pools: Map<string, EfPoolInfo>, meta?: EfMeta): GiftEvent[] {
  const draws = new Map<string, EfPull[]>()
  const recorded = new Map<string, number>()
  for (const p of pulls) {
    if (!tokenPool(p, meta)) continue
    if (p.kind === 'gift_operator_token') recorded.set(p.poolId, (recorded.get(p.poolId) ?? 0) + 1)
    else if (!isGift(p) && !p.isFree) {
      let list = draws.get(p.poolId)
      if (!list) draws.set(p.poolId, (list = []))
      list.push(p)
    }
  }
  const out: GiftEvent[] = []
  for (const [poolId, list] of draws) {
    const expected = Math.floor(list.length / TOKEN_EVERY)
    const have = recorded.get(poolId) ?? 0
    if (expected <= have) continue
    const up = upItem(poolId, pools, meta)
    const sorted = list.toSorted((a, b) => a.gachaTs - b.gachaTs || (Number(a.seqId) || 0) - (Number(b.seqId) || 0))
    // 已有的赠送条目对应前几次，推算的从后面补
    for (let n = have + 1; n <= expected; n++) {
      const at = n * TOKEN_EVERY
      const trigger = sorted[at - 1]!
      out.push({
        key: `inferred:${poolId}:${at}`,
        ts: trigger.gachaTs,
        order: (Number(trigger.seqId) || 0) + 0.5,
        kind: 'gift_operator_token',
        label: giftLabel('gift_operator_token'),
        itemId: up?.id ?? null,
        name: up?.name ?? '当期 UP 干员',
        star: up?.star ?? 6,
        poolId,
        poolName: trigger.poolName,
        weapon: false,
        copy: Boolean(up),
        inferred: true,
        at,
      })
    }
  }
  return out
}

export interface GiftSummary {
  /** 全部赠送条目 */
  total: number
  /** 其中给了干员 / 武器一份的（信物、武器赠礼） */
  copies: number
  /** 其中推算的 */
  inferred: number
}

export function summarizeGifts(gifts: readonly GiftEvent[]): GiftSummary {
  return {
    total: gifts.length,
    copies: gifts.filter((g) => g.copy).length,
    inferred: gifts.filter((g) => g.inferred).length,
  }
}
