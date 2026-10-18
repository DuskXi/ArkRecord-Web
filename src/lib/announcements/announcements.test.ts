import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Announcement, type AnnouncementKind, ANNOUNCEMENTS, isInternalHref, parseInline, popupPlan, RECENT_ON_FIRST, readSeen, unreadMajorOf, unreadOf, writeSeen } from './index'

/** router.ts 里的页面路径（不导入 router，避免在测试里创建浏览器路由） */
const ROUTES = new Set([...readFileSync(new URL('../../router.ts', import.meta.url), 'utf8').matchAll(/path: '([^']+)'/g)].map((m) => m[1]!))

function links(a: Announcement): string[] {
  const out: string[] = []
  for (const h of a.highlights ?? []) if (h.to) out.push(h.to)
  for (const s of a.sections) for (const item of s.items) for (const seg of parseInline(item)) if (seg.type === 'link') out.push(seg.href)
  return out
}

describe('公告内容', () => {
  it('当前版本有公告，而且是最新一篇（发布新版本必须写公告）', () => {
    expect(ANNOUNCEMENTS[0]!.version).toBe(__APP_VERSION__)
    expect(ANNOUNCEMENTS[0]!.id).toBe(`v${__APP_VERSION__}`)
  })

  it('id 不重复，版本公告的 id 是 v + 版本号；版本号不重复', () => {
    expect(new Set(ANNOUNCEMENTS.map((a) => a.id)).size).toBe(ANNOUNCEMENTS.length)
    const versions = ANNOUNCEMENTS.flatMap((a) => (a.version ? [a.version] : []))
    expect(new Set(versions).size).toBe(versions.length)
    for (const a of ANNOUNCEMENTS) {
      expect(a.id).toMatch(/^[a-z0-9][a-z0-9.-]*$/)
      if (a.version) expect(a.id).toBe(`v${a.version}`)
    }
  })

  it('按日期倒序，日期合法', () => {
    for (const a of ANNOUNCEMENTS) {
      expect(a.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(new Date(`${a.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(a.date)
    }
    const dates = ANNOUNCEMENTS.map((a) => a.date)
    expect(dates).toEqual(dates.toSorted().toReversed())
  })

  it('每篇都标明是正式更新还是小更新，至少有一篇正式更新', () => {
    for (const a of ANNOUNCEMENTS) expect(['major', 'minor'], a.id).toContain(a.kind)
    expect(ANNOUNCEMENTS.some((a) => a.kind === 'major')).toBe(true)
  })

  it('有标题、概括和正文', () => {
    for (const a of ANNOUNCEMENTS) {
      expect(a.title.trim()).not.toBe('')
      expect(a.summary.trim()).not.toBe('')
      expect(a.sections.length + (a.highlights?.length ?? 0)).toBeGreaterThan(0)
      for (const s of a.sections) expect(s.items.length).toBeGreaterThan(0)
    }
  })

  it('链接都有效：站内链接指向存在的页面，详情指向存在的公告', () => {
    const ids = new Set(ANNOUNCEMENTS.map((a) => a.id))
    for (const a of ANNOUNCEMENTS) {
      for (const href of links(a)) {
        if (isInternalHref(href)) expect(ROUTES, `${a.id}: ${href}`).toContain(href.split('#')[0])
        else expect(href).toMatch(/^https:\/\//)
      }
      for (const h of a.highlights ?? []) if (h.ref) expect(ids, `${a.id}: ${h.ref}`).toContain(h.ref)
      // 正文里没有写错的标记（成对的 ** 和 [](）
      for (const s of a.sections) for (const item of s.items) for (const seg of parseInline(item)) if (seg.type === 'text') expect(seg.text).not.toMatch(/\*\*|\]\(/)
    }
  })
})

const post = (id: string, kind: AnnouncementKind = 'major'): Announcement => ({ id, kind, version: null, date: '2026-01-01', title: id, summary: id, sections: [{ title: 't', items: ['x'] }] })
const LIST = [post('d'), post('c', 'minor'), post('b'), post('a')]

describe('弹出规则', () => {
  it('没看过的：已读那一篇之前的', () => {
    expect(unreadOf('a', LIST).map((a) => a.id)).toEqual(['d', 'c', 'b'])
    expect(unreadOf('d', LIST)).toEqual([])
    // 已读的那篇被删掉了：当作全部已读
    expect(unreadOf('gone', LIST)).toEqual([])
  })

  it('有更新：弹出最新一篇，下面列出其他没看过的', () => {
    const plan = popupPlan('a', LIST)!
    expect(plan.main.id).toBe('d')
    expect(plan.others.map((a) => a.id)).toEqual(['c', 'b'])
    expect(plan.othersLabel).toContain('没看过')
  })

  it('没有更新、或者只有小更新：不弹，侧边栏也不显示未读数', () => {
    expect(popupPlan('d', LIST)).toBeNull()
    const withMinor = [post('f', 'minor'), post('e', 'minor'), ...LIST]
    expect(popupPlan('d', withMinor)).toBeNull()
    expect(unreadOf('d', withMinor).map((a) => a.id)).toEqual(['f', 'e'])
    expect(unreadMajorOf('d', withMinor)).toEqual([])
  })

  it('小更新之后的正式更新：弹出正式更新，并列出没看过的小更新', () => {
    const list = [post('g'), post('f', 'minor'), post('e', 'minor'), ...LIST]
    const plan = popupPlan('d', list)!
    expect(plan.main.id).toBe('g')
    expect(plan.others.map((a) => a.id)).toEqual(['f', 'e'])
    expect(unreadMajorOf('d', list).map((a) => a.id)).toEqual(['g'])
  })

  it('最新的是小更新时，第一次遇到公告功能的老用户看到的是上一次正式更新', () => {
    const list = [post('f', 'minor'), post('e', 'minor'), ...LIST]
    const plan = popupPlan(null, list)!
    expect(plan.main.id).toBe('d')
    expect(plan.others.map((a) => a.id)).toEqual(['f', 'e', 'c', 'b'].slice(0, RECENT_ON_FIRST))
    expect(unreadMajorOf(null, list).map((a) => a.id)).toEqual(['d'])
  })

  it('老用户第一次遇到公告功能：弹出最新一篇，并列出最近几篇', () => {
    const many = Array.from({ length: 8 }, (_, i) => post(`p${8 - i}`))
    const plan = popupPlan(null, many)!
    expect(plan.main.id).toBe('p8')
    expect(plan.others.map((a) => a.id)).toEqual(['p7', 'p6', 'p5', 'p4'].slice(0, RECENT_ON_FIRST))
    expect(plan.othersLabel).toBe('近期更新')
  })

  it('已读记录：读写 localStorage；不可用时当作已读，不会每次都弹', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    expect(readSeen(storage)).toBeNull()
    writeSeen('v1.1.5', storage)
    expect(readSeen(storage)).toBe('v1.1.5')
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readSeen(broken)).toBe(ANNOUNCEMENTS[0]!.id)
    expect(readSeen(undefined)).toBe(ANNOUNCEMENTS[0]!.id)
  })
})

describe('正文标记', () => {
  it('加粗和链接', () => {
    expect(parseInline('在[图鉴](/codex)里**导入**截图')).toEqual([
      { type: 'text', text: '在' },
      { type: 'link', text: '图鉴', href: '/codex' },
      { type: 'text', text: '里' },
      { type: 'bold', text: '导入' },
      { type: 'text', text: '截图' },
    ])
    expect(parseInline('纯文字')).toEqual([{ type: 'text', text: '纯文字' }])
    expect(parseInline('[外部](https://github.com/DuskXi/ArkRecord-Web)')).toEqual([{ type: 'link', text: '外部', href: 'https://github.com/DuskXi/ArkRecord-Web' }])
  })

  it('不安全的链接原样当作文字', () => {
    expect(parseInline('[点我](javascript:alert(1))')).toEqual([{ type: 'text', text: '[点我](javascript:alert(1))' }])
    expect(parseInline('[外站](//evil.example)')).toEqual([{ type: 'text', text: '[外站](//evil.example)' }])
    expect(parseInline('[明文](http://example.com)')).toEqual([{ type: 'text', text: '[明文](http://example.com)' }])
  })
})
