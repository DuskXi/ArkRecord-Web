/**
 * 匿名使用人数统计（前端部分，服务端见 worker/stats.ts）。
 *
 * 去重全部在本地完成：localStorage 记住“今天、这个月是否已上报过”，每天最多上报一次。
 * 上报内容只有四个字段，不含账号、UID、寻访记录，也不生成或上传任何标识符：
 *   first     这个浏览器是否第一次上报
 *   newMonth  本月是否第一次上报
 *   games     这个浏览器里有哪些游戏的账号（arknights / endfield）
 *   newGames  其中第一次出现的
 * 只有用户在统计同意里选择“全部接受”之后才会上报（见 consent.ts）；选择“仅必要”或还没选择时不发出任何请求。
 */
import { readConsent } from './consent'
import type { Game } from './types'

const STATE_KEY = 'arkrecord:usage'
/** 旧版本显示过统计说明的标记，现在只用来判断是不是第一次访问 */
const NOTICE_KEY = 'arkrecord:usage-notice'

interface UsageState {
  day: string
  month: string
  games: Game[]
}

export interface UsageSummary {
  users: number
  games: Record<Game, number>
  today: number
  todayNew: number
  month: number
  day: string
}

const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })

// localStorage 在隐私模式、禁用站点数据时可能抛错，统计失败不影响任何功能
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 忽略
  }
}

/** 这个浏览器是否用过之前带统计说明的版本 */
export function usageNoticeSeen(): boolean {
  return read(NOTICE_KEY) === '1'
}

/** 根据本地记录决定今天是否需要上报，以及上报什么；不需要时返回 null */
export function buildPing(games: Game[], state: UsageState | null, now = Date.now()) {
  const day = DAY.format(now)
  const month = day.slice(0, 7)
  const uniqueGames = [...new Set(games)].toSorted()
  const newGames = uniqueGames.filter((g) => !state?.games.includes(g))
  if (state?.day === day && !newGames.length) return null
  return {
    ping: { first: !state, newMonth: state?.month !== month, games: uniqueGames, newGames },
    next: { day, month, games: [...new Set([...(state?.games ?? []), ...uniqueGames])].toSorted() } satisfies UsageState,
  }
}

export async function reportUsage(games: Game[]): Promise<void> {
  if (readConsent() !== 'all') return
  let state: UsageState | null = null
  try {
    state = JSON.parse(read(STATE_KEY) ?? 'null') as UsageState | null
  } catch {
    state = null
  }
  const plan = buildPing(games, state)
  if (!plan) return
  try {
    const res = await fetch('/api/stats/ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arkrecord-client': '1' },
      body: JSON.stringify(plan.ping),
      keepalive: true,
    })
    if (res.ok) write(STATE_KEY, JSON.stringify(plan.next))
  } catch {
    // 网络问题时下次打开再试
  }
}

export async function fetchUsageSummary(): Promise<UsageSummary | null> {
  try {
    const res = await fetch('/api/stats/summary')
    return res.ok ? ((await res.json()) as UsageSummary) : null
  } catch {
    return null
  }
}
