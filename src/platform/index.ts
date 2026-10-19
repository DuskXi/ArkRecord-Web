/**
 * 只有桌面版才有的游戏入口和页面（原神、星铁）。网页版用的是这个文件：什么都没有。
 *
 * 桌面构建（vite build --mode desktop、npm run desktop:dev）把 '@/platform' 解析成 ./desktop.ts（见 vite.config.ts），
 * 网页构建从头到尾不会引用桌面版的页面和 src/lib/mhy；万一引用到了，构建直接报错（vite.config.ts 的 webWithoutDesktopCode）。
 */
import type { RouteRecordRaw } from 'vue-router'

/** 游戏切换里多出来的入口：点了跳到 to，不改 app.game（app.game 只有鹰角的两款） */
export interface ExtraGame {
  id: string
  label: string
  short: string
  to: string
}

export const EXTRA_GAMES: ExtraGame[] = []
export const EXTRA_ROUTES: RouteRecordRaw[] = []
