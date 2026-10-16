import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listFeedbackRefs, submitFeedback } from './feedback'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

const input = { category: 'bug' as const, message: '  同步时提示请求太频繁，等了一会儿还是不行  ', contact: ' ', appVersion: '1.0.0', game: 'arknights' as const }

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('站内反馈（前端）', () => {
  it('提交成功后把编号和凭证保存在本地，新的在前；空的联系方式不上传', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 'FB-AAAAA-11111', token: 't1' }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ id: 'FB-BBBBB-22222', token: 't2' }, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const first = await submitFeedback(input)
    await submitFeedback({ ...input, category: 'suggestion' })
    expect(first.saved).toBe(true)
    expect(listFeedbackRefs().map((r) => r.id)).toEqual(['FB-BBBBB-22222', 'FB-AAAAA-11111'])
    expect(listFeedbackRefs()[1]).toMatchObject({ token: 't1', category: 'bug', excerpt: '同步时提示请求太频繁，等了一会儿还是不行' })
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(sent.contact).toBeUndefined()
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers).toMatchObject({ 'x-arkrecord-client': '1' })
  })

  it('失败时给出可读的原因，不保存', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'x-arkrecord-proxy': 'rate_limited' } })))
    await expect(submitFeedback(input)).rejects.toThrow('提交太频繁')
    expect(listFeedbackRefs()).toEqual([])
  })

  it('本地存储损坏时返回空列表', () => {
    localStorage.setItem('arkrecord:feedback', '{oops')
    expect(listFeedbackRefs()).toEqual([])
  })
})
