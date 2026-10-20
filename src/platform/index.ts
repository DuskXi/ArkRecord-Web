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
  /** 在这个厂商的页面上，侧边栏顶部显示的名称（不写就是 ARKRECORD） */
  brand?: string
}

/** 按游戏、物品 ID、名称给出头像地址；没有时 CharAvatar 显示文字 */
export type AvatarResolver = (game: string, itemId: string | null, name: string) => string | undefined

/** “关于”页数据来源表里多出的一行 */
export interface ExtraSource {
  name: string
  desc: string
  url: string
}

export const EXTRA_VENDORS: ExtraVendor[] = []
export const EXTRA_ROUTES: RouteRecordRaw[] = []
/** “关于”页：数据来源表里多出的行 */
export const EXTRA_SOURCES: ExtraSource[] = []
/** “关于”页底部版权说明后面多出的话 */
export const EXTRA_NOTICES: string[] = []
/** 头像怎么取：网页版是 null，CharAvatar 用构建时镜像到本站的头像；桌面版全部运行时经本机后端转发（见 desktop.ts） */
export const AVATAR_RESOLVER: AvatarResolver | null = null
/** “关于”页数据来源的说明换一种写法（桌面版：按需加载，不是镜像到本站），键是来源名称 */
export const SOURCE_NOTES: Record<string, string> = {}
