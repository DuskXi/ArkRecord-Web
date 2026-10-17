/**
 * 累计寻访赠送：不是抽出来的，不计入任何寻访统计，单独列出；给了干员 / 武器一份的计入图鉴（两个游戏通用）。
 *
 * 终末地：寻访记录接口里 kind 以 gift 开头的是赠送（官方页面的显示方式见 ef-webview 的记录页）：
 *   - gift_operator_token：信物赠礼，当期 UP 6★ 的信物 ×1（= 该干员多一份，潜能 +1）
 *   - gift_intel_book：寻访情报书（下次特许寻访转为 10 张专有凭证），不是干员
 *   - gift_weapon：武器赠礼，当期 UP 6★ 武器 ×1；gift_weapon_box：武库赠礼（自选箱）；gift：其他赠礼
 * 接口的赠送条目一般没有干员 / 武器的 ID 和名字（官方页面显示的是另一个字段 nameText），
 * 所以按卡池补上：信物赠礼是这个卡池的当期 UP 6★，武器赠礼是当期 UP 武器。
 *
 * 规则（官方卡池说明）：
 *   - 终末地特许寻访：本期卡池内每累计寻访 240 次送当期 UP 的信物；重构寻访同一卡池累计；免费十连不计入；
 *   - 终末地武库申领（每次申领 10 把）：累计申领 10 次送武库赠礼，18 次送当期 UP 武器，之后每 8 次交替；
 *   - 明日方舟限定寻访：本期卡池内累计寻访 300 次（游戏数据 limitParam.freeCount）送限定干员，每个卡池一次。
 * 记录接口只能查到约 90 天（明日方舟的记录里没有赠送条目）。本地记录的次数够了而没有对应的赠送条目时，按规则推算补上，
 * 标为“推算”。推算只会补“缺少的”：已有的赠送条目先算进去，不会重复。
 */
import type { AkMeta, EfMeta } from '../meta'
import type { AkPull, EfPoolInfo, EfPull } from '../types'
import { efCharFamily, isGift } from './events'

export { isGift }

/** 终末地：每累计寻访多少次赠送一个当期 UP 信物（官方页面的 CHAR_UP_6_ITEM_TIME） */
export const TOKEN_EVERY = 240
/** 终末地武库申领：每次申领 10 把；第 10 次申领送武库赠礼、第 18 次送 UP 武器，之后每 8 次交替（WEAPON_GIFT_TIME*） */
export const WEAPON_PER_DRAW = 10
export const WEAPON_BOX_FIRST = 10
export const WEAPON_GIFT_FIRST = 18
export const WEAPON_GIFT_CYCLE = 16

export interface GiftEvent {
  key: string
  ts: number
  /** 同一时间内的顺序 */
  order: number
  /** 终末地接口的 kind（gift_operator_token 等）；明日方舟限定池赠送为 gift_limited */
  kind: string
  /** 显示用：信物赠礼 / 寻访情报书 / 武器赠礼 … */
  label: string
  itemId: string | null
  name: string
  /** 星级；不是干员 / 武器时为 0 */
  star: number
  poolId: string
  poolName: string
  weapon: boolean
  /** 是否等于获得了这名干员 / 这把武器一份（信物、武器赠礼、限定干员是；情报书、武库箱不是） */
  copy: boolean
  /** 记录里没有，按累计寻访次数推算出来的 */
  inferred: boolean
  /** 推算的：本池第几次累计寻访（武器池为第几次申领）时赠送 */
  at?: number
}

const LABELS: Record<string, string> = {
  gift_operator_token: '信物赠礼',
  gift_intel_book: '寻访情报书',
  gift_weapon_box: '武库赠礼',
  gift_weapon: '武器赠礼',
  gift_limited: '限定干员赠送',
  gift: '赠礼',
}

export function giftLabel(kind: string): string {
  return LABELS[kind] ?? '赠礼'
}

/** 这种赠送是否等于获得了该物品一份 */
function givesCopy(kind: string): boolean {
  return kind === 'gift_operator_token' || kind === 'gift_weapon' || kind === 'gift_limited'
}

interface Item {
  id: string
  name: string
  star: number
}

function byTime(a: { ts: number; order: number }, b: { ts: number; order: number }): number {
  return a.ts - b.ts || a.order - b.order
}

function group<T>(items: Iterable<T>, keyOf: (item: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    if (key === null) continue
    let list = out.get(key)
    if (!list) out.set(key, (list = []))
    list.push(item)
  }
  return out
}

// ───────────────────────── 终末地 ─────────────────────────

const efSeq = (p: EfPull) => Number(p.seqId) || 0
const efOrder = (a: EfPull, b: EfPull) => a.gachaTs - b.gachaTs || efSeq(a) - efSeq(b)

/** 有信物赠礼的角色卡池：特许寻访（每期单独计数）、重构寻访（同一卡池累计）。分组 id 用 poolId（同名重构寻访的 poolId 相同） */
function tokenPool(p: EfPull, meta: EfMeta | undefined): boolean {
  if (p.type !== 'char') return false
  const fam = efCharFamily(p.poolType, p.poolId, p.poolName, meta?.pools[p.poolId]?.t)
  return fam.family === 'ef:special' || fam.family === 'ef:rerun'
}

function efItem(id: string, meta: EfMeta | undefined, fallbackName?: string, fallbackStar?: number): Item {
  const known = meta?.items[id]
  return { id, name: known?.n ?? (fallbackName || id), star: known?.r ?? (fallbackStar || 6) }
}

/**
 * 卡池的当期 UP 6★（角色或武器）：游戏数据表的 UP 名单只有一个时用它，其次用官方接口给的名字。
 * 辉光庆典等 UP 不止一个、赠送的是自选信物的卡池，不知道是哪个，返回 null。
 */
function upItem(poolId: string, weapon: boolean, pools: Map<string, EfPoolInfo>, meta: EfMeta | undefined): Item | null {
  const ups = meta?.pools[poolId]?.up ?? []
  if (ups.length === 1) return efItem(ups[0]!, meta, pools.get(poolId)?.up6Name)
  if (ups.length > 1) return null
  const name = pools.get(poolId)?.up6Name
  if (!name) return null
  const prefix = weapon ? 'wpn_' : 'chr_'
  const known = Object.entries(meta?.items ?? {}).find(([key, item]) => key.startsWith(prefix) && item.n === name)
  return known ? efItem(known[0], meta) : null
}

/** 名字里提到的干员 / 武器（接口的 nameText 可能是“xx 的信物”之类）：取最长的那个 */
function itemInName(text: string, weapon: boolean, meta: EfMeta | undefined): Item | null {
  if (!text) return null
  const prefix = weapon ? 'wpn_' : 'chr_'
  let best: [string, { n: string; r: number }] | null = null
  for (const entry of Object.entries(meta?.items ?? {})) {
    const [id, item] = entry
    if (!id.startsWith(prefix) || !item.n || !text.includes(item.n)) continue
    if (!best || item.n.length > best[1].n.length) best = entry
  }
  return best ? { id: best[0], name: best[1].n, star: best[1].r } : null
}

/** 一条终末地赠送条目给的是哪个干员 / 武器：记录里的 ID → 记录里的名字 → 卡池的当期 UP */
export function resolveEfGift(p: EfPull, pools: Map<string, EfPoolInfo>, meta?: EfMeta): Item | null {
  if (!givesCopy(p.kind)) return null
  const weapon = p.type === 'weapon'
  if (p.itemId) return efItem(p.itemId, meta, p.itemName, p.rarity)
  return itemInName(p.itemName, weapon, meta) ?? upItem(p.poolId, weapon, pools, meta)
}

/**
 * 终末地的全部赠送：记录里的（补上干员 / 武器），加上按规则推算、记录里缺少的。按时间排序。
 */
export function endfieldGifts(pulls: readonly EfPull[], pools: Map<string, EfPoolInfo>, meta?: EfMeta): GiftEvent[] {
  const out: GiftEvent[] = []
  for (const p of pulls) {
    if (!isGift(p)) continue
    const item = resolveEfGift(p, pools, meta)
    out.push({
      key: p.key,
      ts: p.gachaTs,
      order: efSeq(p),
      kind: p.kind,
      label: giftLabel(p.kind),
      itemId: item?.id ?? null,
      name: item?.name ?? giftLabel(p.kind),
      star: item?.star ?? 0,
      poolId: p.poolId,
      poolName: p.poolName,
      weapon: p.type === 'weapon',
      copy: item !== null,
      inferred: false,
    })
  }
  out.push(...inferTokens(pulls, pools, meta), ...inferWeaponGifts(pulls, pools, meta))
  return out.toSorted(byTime)
}

function inferred(
  kind: string,
  poolId: string,
  trigger: { gachaTs: number; poolName: string },
  order: number,
  at: number,
  item: Item | null,
  weapon: boolean,
): GiftEvent {
  const copy = givesCopy(kind) && item !== null
  return {
    key: `inferred:${kind}:${poolId}:${at}`,
    ts: trigger.gachaTs,
    order: order + 0.5,
    kind,
    label: giftLabel(kind),
    itemId: copy ? item!.id : null,
    name: copy ? item!.name : giftLabel(kind),
    star: copy ? item!.star : 0,
    poolId,
    poolName: trigger.poolName,
    weapon,
    copy,
    inferred: true,
    at,
  }
}

/** 按“每累计 240 次”推算记录里缺少的信物赠礼 */
export function inferTokens(pulls: readonly EfPull[], pools: Map<string, EfPoolInfo>, meta?: EfMeta): GiftEvent[] {
  const candidates = pulls.filter((p) => tokenPool(p, meta))
  const recorded = group(candidates, (p) => (p.kind === 'gift_operator_token' ? p.poolId : null))
  const draws = group(candidates, (p) => (!isGift(p) && !p.isFree ? p.poolId : null))
  const out: GiftEvent[] = []
  for (const [poolId, list] of draws) {
    const expected = Math.floor(list.length / TOKEN_EVERY)
    const have = recorded.get(poolId)?.length ?? 0
    if (expected <= have) continue
    const up = upItem(poolId, false, pools, meta)
    const sorted = list.toSorted(efOrder)
    // 已有的赠送条目对应前几次，推算的从后面补
    for (let n = have + 1; n <= expected; n++) {
      const at = n * TOKEN_EVERY
      const trigger = sorted[at - 1]!
      out.push(inferred('gift_operator_token', poolId, trigger, efSeq(trigger), at, up, false))
    }
  }
  return out
}

/** 第 n 次赠送是在第几次申领（武库赠礼：10、26、42…；UP 武器：18、34、50…） */
const weaponGiftAt = (first: number, n: number) => first + (n - 1) * WEAPON_GIFT_CYCLE
const weaponGiftCount = (first: number, draws: number) => (draws < first ? 0 : Math.floor((draws - first) / WEAPON_GIFT_CYCLE) + 1)

/** 武库申领：按累计申领次数推算记录里缺少的武库赠礼和 UP 武器 */
export function inferWeaponGifts(pulls: readonly EfPull[], pools: Map<string, EfPoolInfo>, meta?: EfMeta): GiftEvent[] {
  const weapons = pulls.filter((p) => p.type === 'weapon')
  const recorded = group(weapons, (p) => (isGift(p) ? `${p.poolId}\u0000${p.kind}` : null))
  const draws = group(weapons, (p) => (isGift(p) ? null : p.poolId))
  const out: GiftEvent[] = []
  for (const [poolId, list] of draws) {
    const times = Math.floor(list.length / WEAPON_PER_DRAW)
    const sorted = list.toSorted(efOrder)
    const up = upItem(poolId, true, pools, meta)
    for (const [kind, first] of [
      ['gift_weapon_box', WEAPON_BOX_FIRST],
      ['gift_weapon', WEAPON_GIFT_FIRST],
    ] as const) {
      const expected = weaponGiftCount(first, times)
      const have = recorded.get(`${poolId}\u0000${kind}`)?.length ?? 0
      for (let n = have + 1; n <= expected; n++) {
        const at = weaponGiftAt(first, n)
        const trigger = sorted[at * WEAPON_PER_DRAW - 1]!
        out.push(inferred(kind, poolId, trigger, efSeq(trigger), at, up, true))
      }
    }
  }
  return out
}

// ───────────────────────── 明日方舟 ─────────────────────────

/**
 * 明日方舟：限定寻访累计 300 次（游戏数据里的 limitParam.freeCount）赠送限定干员，每个卡池一次。
 * 寻访记录接口里没有赠送条目，全部按规则推算。
 */
export function arknightsGifts(pulls: readonly AkPull[], meta: AkMeta): GiftEvent[] {
  const out: GiftEvent[] = []
  for (const [poolId, list] of group(pulls, (p) => p.poolId)) {
    const pool = meta.pools[poolId]
    if (pool?.t !== 'LIMITED' || !pool.free || !pool.lim || list.length < pool.free) continue
    const trigger = list.toSorted((a, b) => a.gachaTs - b.gachaTs || a.pos - b.pos)[pool.free - 1]!
    const char = meta.chars[pool.lim]
    out.push(
      inferred(
        'gift_limited',
        poolId,
        { gachaTs: trigger.gachaTs, poolName: pool.n || trigger.poolName },
        trigger.pos,
        pool.free,
        { id: pool.lim, name: char?.n ?? pool.lim, star: char?.r ?? 6 },
        false,
      ),
    )
  }
  return out.toSorted(byTime)
}

/** 显示用的一句说明：信物赠礼（潜能 +1）/ 武器赠礼 / 累计 300 抽赠送；推算的加上“推算” */
export function giftNote(g: GiftEvent): string {
  const base =
    g.kind === 'gift_operator_token'
      ? '信物赠礼 · 潜能 +1'
      : g.kind === 'gift_limited'
        ? `累计 ${g.at ?? ''} 抽赠送`
        : g.kind === 'gift_weapon'
          ? '武器赠礼'
          : g.label
  return g.inferred ? `${base} · 推算` : base
}

export interface GiftSummary {
  /** 全部赠送条目 */
  total: number
  /** 其中给了干员 / 武器一份的（信物、武器赠礼、限定干员） */
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
