/**
 * 更新公告：每次发布新版本都在 content.ts 里加一篇（测试会检查当前版本有公告）。
 *
 * 两种更新：
 *   - 正式更新（major）：新功能、重要变化。更新后第一次打开网站时弹出；
 *   - 小更新（minor）：修复、小改进。只写进“更新公告”页，不弹窗，也不计入侧边栏的未读数；
 *     下一次正式更新弹窗时，会和它一起列出还没看过的小更新。
 *
 * 弹出规则：
 *   - 浏览器里记下“已读到哪一篇”（localStorage，只在这台设备上）；
 *   - 有没看过的正式更新时，第一次打开网站弹出最新一篇正式更新，同时列出其他没看过的；关掉就算全部已读；
 *   - 全新访问（会显示欢迎窗口）不弹，直接记为已读；
 *   - 老用户第一次遇到公告功能（还没有记录）：弹出最新一篇正式更新，并列出最近几篇。
 */
import { ANNOUNCEMENTS } from './content'

/** major：正式更新，弹窗；minor：小更新，只写进公告页 */
export type AnnouncementKind = 'major' | 'minor'

export const KIND_LABEL: Record<AnnouncementKind, string> = { major: '正式更新', minor: '小更新' }

export interface AnnouncementHighlight {
  /** 图标名必须写成字面量（构建时扫描打包） */
  icon: string
  title: string
  text: string
  /** 去看看：站内页面 */
  to?: string
  /** 详情：另一篇公告的 id */
  ref?: string
}

export interface AnnouncementSection {
  title: string
  /** 支持 **加粗** 和 [文字](/页面) 链接 */
  items: string[]
}

export interface Announcement {
  /** 唯一、不再改动；也用作页面锚点。发布版本时用 v + 版本号 */
  id: string
  /** 对应的网站版本；不对应版本的公告为 null */
  version: string | null
  /** 发布日期（北京时间），YYYY-MM-DD */
  date: string
  title: string
  /** 一两句话的概括：列表和弹窗里显示 */
  summary: string
  /** 正式更新弹窗；小更新只写进公告页 */
  kind: AnnouncementKind
  highlights?: AnnouncementHighlight[]
  sections: AnnouncementSection[]
}

/** 新的在前 */
export { ANNOUNCEMENTS }

export function findAnnouncement(id: string, list: readonly Announcement[] = ANNOUNCEMENTS): Announcement | undefined {
  return list.find((a) => a.id === id)
}

/** 老用户第一次看到公告功能时，弹窗里列出的“近期更新”篇数 */
export const RECENT_ON_FIRST = 4

/**
 * 没看过的公告（新的在前）。seen 是已读到的那一篇的 id：
 *   - null：还没有记录，交给 initialSeen 处理；这里返回空；
 *   - 找不到（公告被删掉了）：当作全部已读。
 */
export function unreadOf(seen: string | null, list: readonly Announcement[] = ANNOUNCEMENTS): Announcement[] {
  if (seen === null) return []
  const index = list.findIndex((a) => a.id === seen)
  return index < 0 ? [] : list.slice(0, index)
}

/** 没看过的正式更新（侧边栏的未读数只算这些） */
export function unreadMajorOf(seen: string | null, list: readonly Announcement[] = ANNOUNCEMENTS): Announcement[] {
  if (seen === null) return list.filter((a) => a.kind === 'major').slice(0, 1)
  return unreadOf(seen, list).filter((a) => a.kind === 'major')
}

export interface PopupPlan {
  /** 弹窗里完整显示的一篇 */
  main: Announcement
  /** 弹窗下方列出的其他公告 */
  others: Announcement[]
  /** others 的标题：没看过的 / 近期更新 */
  othersLabel: string
}

/**
 * 这次打开网站要弹出什么；不弹时返回 null。
 * seen 为 null 且不是全新访问（老用户第一次遇到公告功能）：弹出最新一篇，并列出最近几篇。
 */
export function popupPlan(seen: string | null, list: readonly Announcement[] = ANNOUNCEMENTS): PopupPlan | null {
  if (!list.length) return null
  if (seen === null) {
    const main = list.find((a) => a.kind === 'major')
    if (!main) return null
    return { main, others: list.filter((a) => a !== main).slice(0, RECENT_ON_FIRST), othersLabel: '近期更新' }
  }
  const unread = unreadOf(seen, list)
  const main = unread.find((a) => a.kind === 'major')
  if (!main) return null
  return { main, others: unread.filter((a) => a !== main), othersLabel: '你还没看过的其他更新' }
}

// ───────────────────────── 已读记录 ─────────────────────────

const SEEN_KEY = 'arkrecord:announcement'

/** 已读到的公告 id；没有记录时为 null。localStorage 不可用时当作全部已读，避免每次打开都弹 */
export function readSeen(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): string | null {
  try {
    if (!storage) return ANNOUNCEMENTS[0]?.id ?? null
    return storage.getItem(SEEN_KEY)
  } catch {
    return ANNOUNCEMENTS[0]?.id ?? null
  }
}

export function writeSeen(id: string, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(SEEN_KEY, id)
  } catch {
    // 忽略
  }
}

// ───────────────────────── 正文里的简单标记 ─────────────────────────

export type InlineSegment = { type: 'text'; text: string } | { type: 'bold'; text: string } | { type: 'link'; text: string; href: string }

const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

/** 只认 **加粗** 和 [文字](链接)；链接只能是站内路径（/ 开头）或 https 地址，其他原样当作文字 */
export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const index = m.index
    const href = m[3]
    if (m[2] !== undefined && href !== undefined && !isSafeHref(href)) continue
    if (index > last) out.push({ type: 'text', text: text.slice(last, index) })
    if (m[1] !== undefined) out.push({ type: 'bold', text: m[1] })
    else out.push({ type: 'link', text: m[2]!, href: href! })
    last = index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

export function isSafeHref(href: string): boolean {
  return (href.startsWith('/') && !href.startsWith('//')) || href.startsWith('https://')
}

/** 站内路径（RouterLink）；其他在新窗口打开 */
export function isInternalHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//')
}

/** 公告页里某一篇的地址 */
export function announcementPath(id: string): string {
  return `/announcements#${id}`
}
