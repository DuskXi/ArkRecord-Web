import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 给搜索引擎和 AI 助手的文件（说明见 docs/rewrite/README.md 的“给搜索引擎和 AI 的文件”） */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const SITE = 'https://ark.kaltsit.dev'
const ROUTES = new Set([...read('src/router.ts').matchAll(/path: '([^':*]+)'/g)].map((m) => m[1]!))

describe('robots.txt', () => {
  it('正式环境：欢迎抓取，不抓 /api/ 和旧版，指向站点地图和 llms.txt', () => {
    const robots = read('src/crawler/robots.production.txt')
    expect(robots).toMatch(/^User-agent: \*$/m)
    expect(robots).toMatch(/^Allow: \/$/m)
    expect(robots).toMatch(/^Disallow: \/api\/$/m)
    expect(robots).toMatch(/^Disallow: \/legacy\/$/m)
    expect(robots).toMatch(/^Content-Signal: search=yes, ai-input=yes, ai-train=yes$/m)
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`)
    expect(robots).toContain(`${SITE}/llms.txt`)
  })

  it('测试环境：不收录', () => {
    const robots = read('src/crawler/robots.preview.txt')
    expect(robots).toMatch(/^User-agent: \*$/m)
    expect(robots).toMatch(/^Disallow: \/$/m)
    expect(robots).not.toMatch(/^Allow:/m)
    expect(robots).toMatch(/^Content-Signal: search=no, ai-input=no, ai-train=no$/m)
  })
})

describe('llms.txt', () => {
  it('按 llmstxt.org 的格式：标题、概括，链接都是完整的 https 地址', () => {
    for (const file of ['public/llms.txt', 'public/llms-full.txt']) {
      const text = read(file)
      expect(text, file).toMatch(/^# ArkRecord/)
      expect(text, file).toMatch(/^> /m)
      for (const [, url] of text.matchAll(/\]\(([^)]+)\)/g)) expect(url, `${file}: ${url}`).toMatch(/^https:\/\//)
      // 站内链接指向存在的页面
      for (const [, path] of text.matchAll(/https:\/\/ark\.kaltsit\.dev(\/[\w-]*)(?=[\s)，。]|$)/g)) {
        if (!/\.(txt|json|xml)$/.test(path!)) expect(ROUTES, `${file}: ${path}`).toContain(path)
      }
    }
    expect(read('public/llms.txt')).toContain(`${SITE}/llms-full.txt`)
  })
})

describe('sitemap.xml', () => {
  it('只列出存在的页面，地址是正式域名', () => {
    const locs = [...read('public/sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
    expect(locs.length).toBeGreaterThan(5)
    for (const loc of locs) {
      expect(loc.startsWith(`${SITE}/`)).toBe(true)
      expect(ROUTES).toContain(loc.slice(SITE.length))
    }
  })
})

describe('security.txt', () => {
  it('必填字段齐全；Expires 至少还有 30 天（快到期时这个测试会失败，提醒续期）', () => {
    const text = read('public/.well-known/security.txt')
    expect(text).toMatch(/^Contact: https:\/\//m)
    expect(text).toContain(`Canonical: ${SITE}/.well-known/security.txt`)
    const expires = /^Expires: (\S+)$/m.exec(text)?.[1]
    expect(Date.parse(expires!) - Date.now()).toBeGreaterThan(30 * 86_400_000)
    // RFC 9116 建议不超过一年
    expect(Date.parse(expires!) - Date.now()).toBeLessThan(400 * 86_400_000)
  })
})

describe('index.html', () => {
  const html = read('index.html')

  it('结构化数据是合法的 JSON', () => {
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1]
    const data = JSON.parse(json!)
    expect(data['@type']).toBe('WebApplication')
    expect(data.url).toBe(`${SITE}/`)
  })

  it('不运行 JavaScript 也能读到介绍：标题、描述、首屏文字、指向 llms.txt', () => {
    expect(html).toMatch(/<title>ArkRecord[^<]+<\/title>/)
    expect(html).toMatch(/<meta\s+name="description"\s+content="[^"]{20,}"/)
    expect(html).toMatch(/<div id="app"[^>]*>\s*<main class="boot">[\s\S]*明日方舟[\s\S]*<\/main>\s*<\/div>/)
    expect(html).toContain('href="/llms.txt"')
    // 介绍只给不运行 JavaScript 的读者：浏览器默认隐藏，只有关闭 JavaScript 时显示
    expect(html).toMatch(/\.boot \{ display: none;/)
    expect(html).toContain('<noscript><style>.boot { display: block; }</style></noscript>')
    expect(html).not.toContain('正在加载')
    expect(html).toContain(`<link rel="canonical" href="${SITE}/" />`)
  })
})

const json = (path: string) => JSON.parse(read(path))
/** 站内地址对应 public/ 里的文件 */
const local = (href: string) => `public${href.startsWith(SITE) ? href.slice(SITE.length) : href}`

describe('给 AI agent 的发现文件', () => {

  it('Agent Skills 索引：每个技能的文件存在，digest 和文件内容一致（改了 SKILL.md 要更新 index.json 里的 digest）', () => {
    const index = json('public/.well-known/agent-skills/index.json')
    expect(index.$schema).toMatch(/^https:\/\//)
    expect(index.skills.length).toBeGreaterThan(0)
    for (const skill of index.skills) {
      const file = local(skill.url)
      expect(existsSync(file), file).toBe(true)
      const content = readFileSync(file)
      expect(skill.digest, file).toBe(`sha256:${createHash('sha256').update(content).digest('hex')}`)
      // SKILL.md 的 name 和目录名、索引里的 name 一致；description 不超过 1024 字
      const text = content.toString('utf8')
      expect(text).toMatch(new RegExp(`^---\\nname: ${skill.name}\\n`))
      expect(file).toBe(`public/.well-known/agent-skills/${skill.name}/SKILL.md`)
      expect(/^description: (.+)$/m.exec(text)?.[1]?.length).toBeLessThanOrEqual(1024)
    }
  })

  it('API 目录（RFC 9727）和 OpenAPI 说明是合法的 JSON，指向的站内文件都存在', () => {
    const catalog = json('public/.well-known/api-catalog')
    const hrefs = catalog.linkset.flatMap((set: Record<string, unknown>) =>
      Object.values(set).flatMap((v) => (Array.isArray(v) ? v.map((link: { href: string }) => link.href) : [])),
    )
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs.filter((h: string) => h.startsWith(SITE))) {
      // build-manifest.json 在部署时生成
      if (!href.endsWith('/build-manifest.json')) expect(existsSync(local(href)), href).toBe(true)
    }
    const openapi = json('public/openapi.json')
    expect(openapi.openapi).toMatch(/^3\.1\./)
    // /api/ 只给网站自己用，不写进公开的接口说明
    expect(Object.keys(openapi.paths).some((p) => p.startsWith('/api/'))).toBe(false)
  })

  it('首页的 Link 响应头指向的文件都存在', () => {
    const headers = read('public/_headers')
    const rule = /^\/\n((?:[ \t]+.*\n)+)/m.exec(headers)?.[1] ?? ''
    const targets = [...rule.matchAll(/^\s+Link: <([^>]+)>/gm)].map((m) => m[1]!)
    expect(targets.length).toBeGreaterThan(1)
    for (const target of targets) expect(existsSync(`public${target}`), target).toBe(true)
  })
})
