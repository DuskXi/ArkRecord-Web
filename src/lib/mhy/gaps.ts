/**
 * 记录的空档（维护者 2026-10-20 同意）：官方只保留最近一段时间的记录，很久没读取、又导入了更早的记录（UIGF）时，
 * 中间那段抽的卡可能已经查不到了。空档前后的抽数不能接起来算，否则空档后第一个 5★ 的抽数偏多，还可能被错标成大保底。
 *
 * 判断是按时间的经验规则：全账号相邻两条记录隔得比保留时长还久，就当中间可能缺了记录。
 * 真的很久没抽卡也会被当成空档，那样只是显示“未知”，不会显示错的数。比保留时长短的缺口看不出来。
 */
import type { PullEvent } from '../stats/events'
import type { RecordGap } from '../stats/gaps'
import type { MhyGame } from './types'

/** 官方保留记录的时长（天）：原神据 BWIKI 和胡桃文档自 4.5 起为 1 年；星铁社区说 6 个月，未核实（docs/research/multi-game-and-desktop.md） */
export const RETENTION_DAYS: Record<MhyGame, number> = { genshin: 365, starrail: 180 }

const DAY_MS = 86_400_000

/**
 * 找出空档，并在每个保底分组空档前的最后一条记录上标 gapAfter（空档后第一条记录的时间）。
 * events 要按时间排好（normalizeMhy 里排过）。返回找到的空档。
 */
export function markGaps(game: MhyGame, events: readonly PullEvent[]): RecordGap[] {
  const limit = RETENTION_DAYS[game] * DAY_MS
  const gaps: RecordGap[] = []
  const lastOfFamily = new Map<string, PullEvent>()
  let prev: PullEvent | undefined
  for (const e of events) {
    if (prev && e.ts - prev.ts > limit) {
      gaps.push({ from: prev.ts, to: e.ts, days: Math.round((e.ts - prev.ts) / DAY_MS) })
      // 空档前出现过的分组都受影响；之前的空档已经标过、之后没再抽的分组不用再标
      for (const last of lastOfFamily.values()) last.gapAfter = e.ts
      lastOfFamily.clear()
    }
    lastOfFamily.set(e.family, e)
    prev = e
  }
  return gaps
}
