/**
 * 记录里的空档（米哈游，标记见 src/lib/mhy/gaps.ts 和 PullEvent.gapAfter）：页面上列出来，说明空档后的抽数为什么是“未知”。
 * 鹰角两款没有标记，这里返回空数组。
 */
import type { PullEvent } from './events'

const DAY_MS = 86_400_000

export interface RecordGap {
  /** 空档前最后一条记录的时间 */
  from: number
  /** 空档后第一条记录的时间 */
  to: number
  days: number
}

/** events 里标出的空档，按时间排 */
export function listGaps(events: readonly PullEvent[]): RecordGap[] {
  const ends = new Map<number, number>()
  for (const e of events) {
    if (e.gapAfter !== undefined) ends.set(e.gapAfter, Math.max(ends.get(e.gapAfter) ?? 0, e.ts))
  }
  return [...ends]
    .map(([to, from]) => ({ from, to, days: Math.round((to - from) / DAY_MS) }))
    .toSorted((a, b) => a.to - b.to)
}
