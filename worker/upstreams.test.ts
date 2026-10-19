import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRoute, UPSTREAMS } from './upstreams'

// 白名单的完整清单。改动白名单时要同时改这里，避免误增、误删转发的接口。
const EXPECTED_ROUTES = [
  'as POST as.hypergryph.com/user/oauth2/v2/grant auth',
  'binding GET binding-api-account-prod.hypergryph.com/account/binding/v1/binding_list auth',
  'binding POST binding-api-account-prod.hypergryph.com/account/binding/v1/u8_token_by_uid auth',
  'ak POST ak.hypergryph.com/user/api/role/login auth',
  'ak GET ak.hypergryph.com/user/api/inquiry/gacha/cate data',
  'ak GET ak.hypergryph.com/user/api/inquiry/gacha/history data',
  'ak GET ak.hypergryph.com/user/api/inquiry/diamond data',
  'u8 POST u8.hypergryph.com/u8/pay/v1/recent data',
  'ef GET ef-webview.hypergryph.com/api/record/char data',
  'ef GET ef-webview.hypergryph.com/api/record/char/meta data',
  'ef GET ef-webview.hypergryph.com/api/record/char/pool data',
  'ef GET ef-webview.hypergryph.com/api/record/weapon data',
  'ef GET ef-webview.hypergryph.com/api/record/weapon/pool data',
  'ef GET ef-webview.hypergryph.com/api/content data',
]

const UPSTREAM_KEYS = new Set(['host', 'purpose', 'reason', 'routes', 'relayAkCookie', 'extraHeaders'])
const ROUTE_KEYS = new Set(['method', 'path', 'limiter'])

describe('shared/upstreams/hg.json', () => {
  it('lists exactly the expected routes', () => {
    const routes = Object.entries(UPSTREAMS).flatMap(([name, u]) =>
      u.routes.map((r) => `${name} ${r.method} ${u.host}${r.path} ${r.limiter}`),
    )
    expect(routes).toEqual(EXPECTED_ROUTES)
  })

  it('has valid fields only', () => {
    for (const upstream of Object.values(UPSTREAMS)) {
      expect(Object.keys(upstream).every((k) => UPSTREAM_KEYS.has(k))).toBe(true)
      expect(upstream.host).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.hypergryph\.com$/)
      expect(upstream.purpose.length).toBeGreaterThan(0)
      expect(upstream.reason.length).toBeGreaterThan(0)
      expect(upstream.routes.length).toBeGreaterThan(0)
      if (upstream.relayAkCookie !== undefined) expect(typeof upstream.relayAkCookie).toBe('boolean')
      for (const value of Object.values(upstream.extraHeaders ?? {})) expect(typeof value).toBe('string')
      const paths = new Set<string>()
      for (const route of upstream.routes) {
        expect(Object.keys(route).every((k) => ROUTE_KEYS.has(k))).toBe(true)
        expect(['GET', 'POST']).toContain(route.method)
        expect(['auth', 'data']).toContain(route.limiter)
        expect(route.path).toMatch(/^\/[\w/-]+$/)
        expect(paths.has(route.path)).toBe(false)
        paths.add(route.path)
      }
    }
  })
})

describe('findRoute', () => {
  it('finds whitelisted routes', () => {
    expect(findRoute('ak', '/user/api/inquiry/gacha/history')?.route.method).toBe('GET')
    expect(findRoute('as', '/user/oauth2/v2/grant')?.upstream.host).toBe('as.hypergryph.com')
  })

  it('rejects anything else', () => {
    expect(findRoute('ak', '/user/api/inquiry/gacha/history/')).toBeNull()
    expect(findRoute('ak', '/user/api/role/logout')).toBeNull()
    expect(findRoute('nope', '/')).toBeNull()
    expect(findRoute('__proto__', '/')).toBeNull()
    expect(findRoute('constructor', '/')).toBeNull()
    expect(findRoute('toString', '/')).toBeNull()
  })
})

/** 目录下所有源码文件 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|vue|js|mjs)$/.test(name) ? [path] : []
  })
}

describe('shared/upstreams/mhy.json', () => {
  // 米哈游的白名单只给桌面版的 Python 后端用：网页版和 Worker 不能引用它（网页版只有鹰角两款）
  it('is not referenced by the website or the Worker', () => {
    const offenders = ['src', 'worker']
      .flatMap(sourceFiles)
      .filter((file) => !file.endsWith('.test.ts') && readFileSync(file, 'utf8').includes('upstreams/mhy'))
    expect(offenders).toEqual([])
  })
})
