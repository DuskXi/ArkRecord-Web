/**
 * 最高星旁边的“UP / 歪 / 大保底”标记和米哈游大小保底的现状，各页面共用。
 * 鹰角两款只有 UP 和歪；米哈游按大小保底（guarantee）细分：小保底没歪是“不歪”，歪了是“歪”，大保底是“大保底”。
 * guarantee、upShare 由 src/lib/mhy/up.ts 按官方规则填上。
 */
import type { PullEvent } from './events'

export interface UpTag {
  text: string
  /** 是当期 UP */
  up: boolean
  /** 鼠标悬停的说明 */
  title: string
}

export function upTag(e: Pick<PullEvent, 'isUp' | 'guarantee'>): UpTag | null {
  if (e.isUp === null) return null
  if (e.guarantee === 'big' && e.isUp) return { text: '大保底', up: true, title: '上一个歪了，这一个必是 UP（大保底）' }
  if (!e.isUp) {
    return { text: '歪', up: false, title: e.guarantee === 'small' ? '小保底歪了，下一个必是 UP（大保底）' : '不是当期 UP' }
  }
  if (e.guarantee === 'small') return { text: '不歪', up: true, title: '小保底，没歪' }
  return { text: 'UP', up: true, title: '当期 UP' }
}

export type GuaranteeState = 'small' | 'big' | 'unknown'

/**
 * 米哈游每个活动池保底分组现在是大保底、小保底，还是看不出来：按这个分组最后一个最高星（歪了就是大保底）。
 * 没有大小保底规则的事件（鹰角两款）不算。
 */
export function guaranteeStates(events: readonly PullEvent[], topStar = 5): Map<string, GuaranteeState> {
  const out = new Map<string, GuaranteeState>()
  for (const e of events) {
    if (e.star !== topStar || e.upShare === undefined) continue
    out.set(e.family, e.isUp === null ? 'unknown' : e.isUp ? 'small' : 'big')
  }
  return out
}
