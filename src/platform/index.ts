/**
 * 只有桌面版才有的厂商、游戏和页面（米哈游：原神、星铁）。网页版用的是这个文件：什么都没有，侧边栏只有鹰角。
 *
 * 桌面构建（vite build --mode desktop、npm run desktop:dev）把 '@/platform' 解析成 ./desktop.ts（见 vite.config.ts），
 * 网页构建从头到尾不会引用桌面版的页面和 src/lib/mhy；万一引用到了，构建直接报错（vite.config.ts 的 webWithoutDesktopCode）。
 */
import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'

/** 一个游戏：点了跳到 to；页面路径是 to 或 to/… 时算在这个游戏里。不改 app.game（app.game 只有鹰角的两款） */
export interface ExtraGame {
  id: string
  label: string
  short: string
  to: string
}

/** 鹰角以外的厂商：侧边栏顶部的“厂商切换”里多一项，下面是它自己的游戏切换和侧边栏（账号、导航） */
export interface ExtraVendor {
  id: string
  label: string
  short: string
  games: ExtraGame[]
  /** 侧边栏里游戏切换下面的部分，props：{ game: 游戏 id, collapsed } */
  sidebar: Component
}

export const EXTRA_VENDORS: ExtraVendor[] = []
export const EXTRA_ROUTES: RouteRecordRaw[] = []
