/**
 * 同步识别码的统计（docs/rewrite/sync-user-id.md 的“用于统计”）：数“用过云同步的独立用户”。
 *
 * 网页版：只在统计选了“全部接受”之后，由页面单独上报 SHA-256("arkrecord-user-v1:<识别码>")，每天最多一次，随机延迟；
 *   服务器再用自己的密钥做 HMAC 才保存（worker/desktop-stats.ts）。请求里没有别的内容，和使用人数统计（usage.ts）互不关联。
 * 桌面版：不走这里，识别码交给 Python 后端（desktop-stats.ts 的 reportDesktopStats），默认开启，“关于”页可以关闭。
 * 没开通过云同步的设备没有识别码，什么都不报。
 */
import { readConsent } from './consent'
import { loadDeviceUser } from './sync-user'

const STATE_KEY = 'arkrecord:sync-user-ping'
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
/** 页面打开后多久上报（毫秒），每次随机 */
const DELAY_RANGE = [5_000, 60_000] as const

export async function userHash(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`arkrecord-user-v1:${id}`)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

interface PingState {
  day: string
  id: string
}

/** 今天这个识别码报过没有（识别码换了，比如回答“是同一个人”之后，当天也报新的） */
export function alreadySent(state: PingState | null, id: string, now = Date.now()): boolean {
  return state?.day === DAY.format(now) && state.id === id
}

function readState(): PingState | null {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as PingState | null
  } catch {
    return null
  }
}

let pending: ReturnType<typeof setTimeout> | undefined

/** 网页版：选了“全部接受”、有识别码、今天还没报过时，随机延迟后上报。失败不影响任何功能，下次打开再试 */
export async function reportSyncUser(): Promise<void> {
  if (readConsent() !== 'all') return
  const user = await loadDeviceUser()
  if (!user || alreadySent(readState(), user.id)) return
  clearTimeout(pending)
  const delay = DELAY_RANGE[0] + Math.random() * (DELAY_RANGE[1] - DELAY_RANGE[0])
  pending = setTimeout(() => void send(user.id), delay)
}

async function send(id: string): Promise<void> {
  // 等待期间改了统计选择的，不报
  if (readConsent() !== 'all') return
  try {
    const res = await fetch('/api/stats/user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arkrecord-client': '1' },
      body: JSON.stringify({ hash: await userHash(id) }),
      keepalive: true,
    })
    if (res.ok) localStorage.setItem(STATE_KEY, JSON.stringify({ day: DAY.format(Date.now()), id } satisfies PingState))
  } catch {
    // 网络问题、localStorage 不可用时下次再试
  }
}
