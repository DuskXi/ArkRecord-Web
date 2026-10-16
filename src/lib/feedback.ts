/**
 * 站内反馈（服务端见 worker/feedback.ts）。网站首先引导用户去 GitHub 提 Issue，这里是给不方便用 GitHub 的人。
 *
 * 提交后得到反馈编号和凭证，只保存在这个浏览器的 localStorage 里：
 *   - 不同步、不进入导出文件；清除浏览器数据或换设备就找不回来，以后的回复也就看不到了；
 *   - 凭证留给以后的“查看回复”功能使用（还没有实现，见 worker/feedback.ts 开头的说明）。
 */
import type { Game } from './types'

export const GITHUB_ISSUES_URL = 'https://github.com/DuskXi/ArkRecord-Web/issues'

export const FEEDBACK_CATEGORIES = [
  { value: 'bug', label: '问题 / 报错' },
  { value: 'data', label: '数据不对' },
  { value: 'suggestion', label: '建议' },
  { value: 'other', label: '其他' },
] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]['value']

export const MAX_MESSAGE_LENGTH = 2000
export const MAX_CONTACT_LENGTH = 200

export interface FeedbackRef {
  id: string
  /** 以后查看回复时证明是提交者本人；不要展示或分享 */
  token: string
  createdAt: number
  category: FeedbackCategory
  /** 正文开头，方便在列表里认出是哪一条 */
  excerpt: string
}

const KEY = 'arkrecord:feedback'

export function listFeedbackRefs(): FeedbackRef[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(value) ? (value as FeedbackRef[]).filter((r) => typeof r?.id === 'string' && typeof r.token === 'string') : []
  } catch {
    return []
  }
}

function saveFeedbackRef(ref: FeedbackRef): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify([ref, ...listFeedbackRefs().filter((r) => r.id !== ref.id)]))
    return true
  } catch {
    return false
  }
}

export class FeedbackError extends Error {}

const ERRORS: Record<string, string> = {
  rate_limited: '提交太频繁了，请过一分钟再试。',
  invalid_feedback: '内容不符合要求：请至少写几个字，正文不超过 2000 字，联系方式不超过 200 字。',
  body_too_large: '内容太长了。',
  feedback_unavailable: '反馈服务暂时不可用，请稍后再试，或者去 GitHub 提 Issue。',
}

export interface FeedbackSubmission {
  category: FeedbackCategory
  message: string
  contact?: string
  appVersion: string
  game: Game
}

/** 提交反馈，并把编号保存在这个浏览器里；返回编号和是否保存成功 */
export async function submitFeedback(input: FeedbackSubmission): Promise<{ ref: FeedbackRef; saved: boolean }> {
  let res: Response
  try {
    res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arkrecord-client': '1' },
      body: JSON.stringify({ ...input, contact: input.contact?.trim() || undefined }),
    })
  } catch {
    throw new FeedbackError('网络连接失败，请检查网络后重试。')
  }
  if (res.status !== 201) {
    const code = res.headers.get('x-arkrecord-proxy') ?? ''
    throw new FeedbackError(ERRORS[code] ?? `提交失败（HTTP ${res.status}），请稍后再试，或者去 GitHub 提 Issue。`)
  }
  const { id, token } = (await res.json()) as { id: string; token: string }
  const message = input.message.trim()
  const ref: FeedbackRef = { id, token, createdAt: Date.now(), category: input.category, excerpt: message.slice(0, 60) }
  return { ref, saved: saveFeedbackRef(ref) }
}
