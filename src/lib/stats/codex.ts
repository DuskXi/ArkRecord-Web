/**
 * 图鉴：游戏里的全部干员（终末地还有武器），结合寻访记录标出抽到过哪些、抽到几次。
 *
 * 只根据寻访记录统计：活动赠送、公开招募、兑换所、剧情奖励等途径获得的，以及没有保存下来的早期寻访都不知道，
 * 所以“没有记录”不等于账号里没有。
 * TODO：支持上传森空岛 App 的干员列表截图，识别后同步账号里实际持有的干员。
 */
import type { AkMeta, EfMeta } from '../meta'
import type { PullEvent } from './events'

export interface CodexItem {
  id: string
  name: string
  star: number
  /** 明日方舟职业（PIONEER / WARRIOR / …） */
  profession?: string
  /** 获得方式（明日方舟干员表的 itemObtainApproach） */
  approach?: string
  /** 能否从寻访中抽到；不能的只能通过其他途径获得，寻访记录里不会出现 */
  gacha: boolean
}

export interface CodexEntry extends CodexItem {
  /** 寻访中抽到的次数 */
  count: number
  /** 其中作为当期 UP 抽到的次数 */
  up: number
  firstTs: number | null
  lastTs: number | null
}

export const PROFESSION_LABEL: Record<string, string> = {
  PIONEER: '先锋',
  WARRIOR: '近卫',
  TANK: '重装',
  SNIPER: '狙击',
  CASTER: '术师',
  MEDIC: '医疗',
  SUPPORT: '辅助',
  SPECIAL: '特种',
}

/** ID 里的数字部分，用于同星级内的排序（数字越大一般越新） */
function idNumber(id: string): number {
  return Number(/_(\d+)_/.exec(id)?.[1] ?? 0)
}

/** 明日方舟：3★ 以上、可以作为普通干员获得的干员（1★、2★ 和预备干员不出现在寻访中） */
export function akCodexItems(meta: AkMeta): CodexItem[] {
  // 当过 UP 的一定能在寻访中抽到（有些活动干员后来进了卡池，干员表里的获得方式没有更新）
  const upIds = new Set<string>()
  for (const pool of Object.values(meta.pools)) {
    for (const ids of Object.values(pool.up ?? {})) for (const id of ids) upIds.add(id)
  }
  return Object.entries(meta.chars)
    .filter(([, c]) => c.r >= 3 && !c.x)
    .map(([id, c]) => ({
      id,
      name: c.n,
      star: c.r,
      profession: c.p,
      approach: c.o,
      gacha: Boolean(c.o?.includes('寻访')) || upIds.has(id),
    }))
}

/** 终末地：角色（不含主角“管理员”）或武器。没有获得方式的数据，全部按可以抽到处理 */
export function efCodexItems(meta: EfMeta, weapon: boolean): CodexItem[] {
  const prefix = weapon ? 'wpn_' : 'chr_'
  return Object.entries(meta.items)
    .filter(([id, item]) => id.startsWith(prefix) && item.r >= 4 && !/_endmin[mf]$/.test(id))
    .map(([id, item]) => ({ id, name: item.n, star: item.r, gacha: true }))
}

/**
 * 把寻访记录对到图鉴上。旧版迁移的记录可能没有 ID，按名称对应；
 * 图鉴里没有的（元数据还没更新的新角色）也列出来，不丢记录。
 */
export function buildCodex(items: readonly CodexItem[], events: readonly PullEvent[]): CodexEntry[] {
  const entries = new Map<string, CodexEntry>()
  const byName = new Map<string, CodexEntry>()
  for (const item of items) {
    const entry: CodexEntry = { ...item, count: 0, up: 0, firstTs: null, lastTs: null }
    entries.set(item.id, entry)
    if (!byName.has(item.name)) byName.set(item.name, entry)
  }
  for (const e of events) {
    let entry = (e.itemId ? entries.get(e.itemId) : undefined) ?? byName.get(e.name)
    if (!entry) {
      const id = e.itemId ?? `name:${e.name}`
      entry = { id, name: e.name, star: e.star, gacha: true, count: 0, up: 0, firstTs: null, lastTs: null }
      entries.set(id, entry)
      byName.set(e.name, entry)
    }
    entry.count++
    if (e.isUp) entry.up++
    entry.firstTs = entry.firstTs === null ? e.ts : Math.min(entry.firstTs, e.ts)
    entry.lastTs = entry.lastTs === null ? e.ts : Math.max(entry.lastTs, e.ts)
    // 抽到过就说明能从寻访中获得
    entry.gacha = true
  }
  return [...entries.values()].toSorted((a, b) => b.star - a.star || idNumber(b.id) - idNumber(a.id) || a.id.localeCompare(b.id))
}

export interface CodexSummary {
  star: number
  /** 寻访可得的数量 */
  total: number
  /** 其中抽到过的数量 */
  owned: number
}

/** 各星级的收集进度（只算寻访可得的） */
export function summarizeCodex(entries: readonly CodexEntry[]): CodexSummary[] {
  const stars = [...new Set(entries.map((e) => e.star))].toSorted((a, b) => b - a)
  return stars.map((star) => {
    const list = entries.filter((e) => e.star === star && e.gacha)
    return { star, total: list.length, owned: list.filter((e) => e.count > 0).length }
  })
}
