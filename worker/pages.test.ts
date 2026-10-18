import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import worker from './index'
import { estimateTokens, PAGE_PATHS, pageMarkdown, prefersMarkdown } from './pages'
import type { Env } from './proxy'

/** 测试从仓库根目录运行（和 token-fields.test.ts 一样） */
const read = (path: string) => readFileSync(path, 'utf8')
const SELF = 'https://ark-next.kaltsit.dev'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never
const LLMS = '# ArkRecord：完整说明\n\n> 说明\n'
const HTML = '<!doctype html><title>ArkRecord</title>'

/** 模拟静态资源：/llms-full.txt 返回说明，其余返回网页（带上 _headers 里的安全头，模拟 Cloudflare 的行为） */
function fakeAssets(calls: string[] = []): Fetcher {
  return {
    fetch: async (input: Request | string) => {
      const request = typeof input === 'string' ? new Request(input) : input
      const path = new URL(request.url).pathname
      calls.push(`${request.method} ${path}`)
      if (path === '/llms-full.txt') return new Response(LLMS, { headers: { 'content-type': 'text/plain' } })
      return new Response(request.method === 'HEAD' ? null : HTML, {
        headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'", link: '</llms.txt>; rel="alternate"' },
      })
    },
  } as unknown as Fetcher
}

function call(path: string, init: RequestInit = {}, env: Env = { ASSETS: fakeAssets() }): Promise<Response> {
  return worker.fetch(new Request(`${SELF}${path}`, init) as never, env, ctx) as Promise<Response>
}

describe('prefersMarkdown', () => {
  it('浏览器的 Accept 不会得到 Markdown', () => {
    expect(prefersMarkdown('text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8')).toBe(false)
    expect(prefersMarkdown('*/*')).toBe(false)
    expect(prefersMarkdown(null)).toBe(false)
    expect(prefersMarkdown('')).toBe(false)
  })

  it('明确要 Markdown、且不比 HTML 低时返回 Markdown', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true)
    expect(prefersMarkdown('text/markdown, text/html;q=0.9, */*;q=0.1')).toBe(true)
    expect(prefersMarkdown('text/html, text/markdown')).toBe(true)
    expect(prefersMarkdown('TEXT/MARKDOWN; charset=utf-8')).toBe(true)
    expect(prefersMarkdown('text/x-markdown')).toBe(true)
  })

  it('HTML 权重更高或 Markdown 权重为 0 时返回网页', () => {
    expect(prefersMarkdown('text/html, text/markdown;q=0.5')).toBe(false)
    expect(prefersMarkdown('text/markdown;q=0, text/html')).toBe(false)
    // q 值写错时忽略这一项
    expect(prefersMarkdown('text/markdown;q=abc')).toBe(false)
  })
})

describe('页面的内容协商', () => {
  it('要 Markdown 时返回 llms-full.txt 的内容', async () => {
    const res = await call('/', { headers: { accept: 'text/markdown' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('vary')).toBe('Accept')
    expect(Number(res.headers.get('x-markdown-tokens'))).toBeGreaterThan(0)
    expect(await res.text()).toBe(LLMS)
  })

  it('其他页面在前面加上这个页面的简介', async () => {
    const res = await call('/stats', { headers: { accept: 'text/markdown' } })
    const text = await res.text()
    expect(text).toMatch(/^# ArkRecord · 高级统计\n/)
    expect(text).toContain('https://ark.kaltsit.dev/stats')
    expect(text.endsWith(LLMS)).toBe(true)
  })

  it('HEAD 请求只返回响应头', async () => {
    const res = await call('/', { method: 'HEAD', headers: { accept: 'text/markdown' } })
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await res.text()).toBe('')
  })

  it('普通访问照常返回网页，保留静态资源的响应头，补上 Vary', async () => {
    const res = await call('/', { headers: { accept: 'text/html' } })
    expect(await res.text()).toBe(HTML)
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'")
    expect(res.headers.get('link')).toContain('/llms.txt')
    expect(res.headers.get('vary')).toContain('Accept')
  })

  it('POST 等其他方法不做协商，原样交给静态资源', async () => {
    const calls: string[] = []
    const res = await call('/', { method: 'POST', headers: { accept: 'text/markdown' } }, { ASSETS: fakeAssets(calls) })
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(calls).toEqual(['POST /'])
  })

  it('不是页面的地址不经过这里', async () => {
    const calls: string[] = []
    const res = await call('/.env', { headers: { accept: 'text/markdown' } }, { ASSETS: fakeAssets(calls) })
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('vary')).toBeNull()
    expect(calls).toEqual(['GET /.env'])
  })
})

describe('页面列表', () => {
  const routes = [...read('src/router.ts').matchAll(/path: '([^':*]+)'/g)].map((m) => m[1]!)

  it('和 src/router.ts 的页面一致', () => {
    expect(PAGE_PATHS.toSorted()).toEqual(routes.toSorted())
  })

  it('wrangler.jsonc 给了 Worker 静态文件的绑定 ASSETS（没有它，经过 Worker 的页面全部 404）', () => {
    expect(read('wrangler.jsonc')).toMatch(/"assets": \{[^}]*"binding": "ASSETS"/)
  })

  it('和 wrangler.jsonc 的 run_worker_first 一致（页面地址都要经过 Worker）', () => {
    const config = read('wrangler.jsonc')
    const list = /"run_worker_first": \[([^\]]*)\]/.exec(config)?.[1] ?? ''
    const patterns = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
    expect(patterns.filter((p) => p !== '/api/*').toSorted()).toEqual(PAGE_PATHS.toSorted())
  })

  it('每个页面都有标题和简介', () => {
    for (const path of PAGE_PATHS.filter((p) => p !== '/')) expect(pageMarkdown(path, ''), path).toMatch(/^# ArkRecord · \S+\n\n> https:\/\/\S+ ：\S+/)
    expect(estimateTokens('明日方舟 abcd')).toBe(6)
  })
})
