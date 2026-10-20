/**
 * 桌面版的四款游戏（总览用）：怎么打开、总览上用的颜色。只在桌面版里（vite.config.ts 的 DESKTOP_ONLY）。
 * 每款游戏的统计在 src/lib/desktop/summary.ts。
 */
import type { MhyGame } from '@/lib/mhy/types'
import type { Game } from '@/lib/types'

export type AnyGame = Game | MhyGame

export interface DesktopGame {
  id: AnyGame
  label: string
  /** 放不下全名时用（总览的合计说明） */
  short: string
  /** 两个字母的简写（总览“最近出货”每行的游戏标签，悬停显示全名） */
  code: 'AK' | 'EF' | 'GS' | 'SR'
  vendor: '鹰角' | '米哈游'
  /** 打开这款游戏的页面 */
  to: string
  /** 总览上这款游戏的颜色（卡片的色条、每月抽数的图）；深浅色下都看得清 */
  accent: string
}

export const DESKTOP_GAMES: readonly DesktopGame[] = [
  { id: 'arknights', label: '明日方舟', short: '方舟', code: 'AK', vendor: '鹰角', to: '/', accent: '#0ea5e9' },
  { id: 'endfield', label: '终末地', short: '终末地', code: 'EF', vendor: '鹰角', to: '/', accent: '#d9c400' },
  { id: 'genshin', label: '原神', short: '原神', code: 'GS', vendor: '米哈游', to: '/genshin', accent: '#14b8a6' },
  { id: 'starrail', label: '崩坏：星穹铁道', short: '星铁', code: 'SR', vendor: '米哈游', to: '/starrail', accent: '#6366f1' },
]
