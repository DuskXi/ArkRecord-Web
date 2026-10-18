/**
 * 页面地址的内容协商：AI agent 在请求头 Accept 里要 text/markdown（并且比 text/html 优先）时，
 * 返回这个页面的 Markdown 说明，而不是需要 JavaScript 才能看懂的网页；其余请求照常返回网页。
 *
 * Markdown 的内容只来自公开的静态文件（/llms-full.txt），前面加上这个页面的一段简介；不接触任何用户数据。
 * 只有 PAGE_PATHS 里的地址会经过这里（wrangler.jsonc 的 run_worker_first），静态文件仍由 Cloudflare 直接返回。
 */

/** 网站的各个页面（和 src/router.ts、public/sitemap.xml 一致，测试会检查） */
export const PAGES: Record<string, { title: string; summary: string }> = {
  '/': { title: '总览', summary: '当前保底、预计还需抽数、定向保底与累计奖励的进度、最近的 6★。' },
  '/history': { title: '寻访记录', summary: '按十连分组的寻访记录，可以按星级、卡池、干员筛选；赠送的干员单独标出。' },
  '/banners': { title: '卡池', summary: '每个卡池的抽数与出货。' },
  '/analysis': { title: '分析', summary: '出金（终末地叫“出红”）间隔、UP 与歪的情况。' },
  '/stats': {
    title: '高级统计',
    summary: '出金抽数分布与理论分布对比、歪不歪的概率分布（按保底规则精确计算）、运气百分位、欧非走势、抽卡时段、抽卡规划。',
  },
  '/timeline': { title: '时间线', summary: '以 6★ 分段的时间线，可以一键生成分享图片。' },
  '/codex': { title: '图鉴', summary: '抽到过哪些干员、各抽到几次；可以导入森空岛 App 的干员截图补全（截图在浏览器里识别，不上传）。' },
  '/ledger': { title: '源石与充值', summary: '明日方舟的源石与充值记录。' },
  '/data': { title: '数据', summary: '导入导出、自动快照、持久化存储，以及可选的加密云同步。' },
  '/announcements': { title: '更新公告', summary: '每次更新改了什么。' },
  '/feedback': { title: '反馈', summary: '给维护者留言（也可以在 GitHub Issues 反馈）。' },
  '/about': { title: '关于', summary: '数据来源、隐私说明，以及“线上代码审计”：怎样核对这个网站运行的就是公开的源码。' },
}

export const PAGE_PATHS = Object.keys(PAGES)

const SITE = 'https://ark.kaltsit.dev'
/** Markdown 的正文（llmstxt.org 格式的完整说明） */
const SOURCE = '/llms-full.txt'

/** 媒体类型在 Accept 里的权重（q 值）；没有列出时为 0 */
function weight(accept: string, matches: (type: string) => boolean): number {
  let best = 0
  for (const part of accept.split(',')) {
    const [type = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase())
    if (!matches(type)) continue
    const q = params.find((p) => p.startsWith('q='))
    const value = q === undefined ? 1 : Number(q.slice(2))
    if (Number.isFinite(value)) best = Math.max(best, Math.min(Math.max(value, 0), 1))
  }
  return best
}

/**
 * 请求方明确要 Markdown，并且不比网页更想要 HTML 时才返回 Markdown。
 * 浏览器的 Accept 里没有 text/markdown，所以普通访问不受影响。
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false
  const markdown = weight(accept, (t) => t === 'text/markdown' || t === 'text/x-markdown')
  if (markdown === 0) return false
  const html = weight(accept, (t) => t === 'text/html' || t === 'application/xhtml+xml')
  return markdown >= html
}

export function pageMarkdown(path: string, body: string): string {
  const page = PAGES[path]
  if (!page || path === '/') return body
  const intro = [
    `# ArkRecord · ${page.title}`,
    '',
    `> ${SITE}${path} ：${page.summary}`,
    '>',
    '> 网页需要 JavaScript；下面是整个网站的说明。The page needs JavaScript; below is the description of the whole site.',
    '',
    '---',
    '',
  ]
  return `${intro.join('\n')}\n${body}`
}

/** 粗略估计 token 数（中文按字、其他按约 4 个字符一个），只作参考 */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[　-鿿＀-￯]/g)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

export async function handlePage(request: Request, assets: Fetcher, url: URL): Promise<Response> {
  const negotiable = request.method === 'GET' || request.method === 'HEAD'
  if (negotiable && prefersMarkdown(request.headers.get('accept'))) {
    const source = await assets.fetch(new Request(new URL(SOURCE, url)))
    if (source.ok) {
      const text = pageMarkdown(url.pathname, await source.text())
      return new Response(request.method === 'HEAD' ? null : text, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          vary: 'Accept',
          'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff',
          'x-markdown-tokens': String(estimateTokens(text)),
          link: `<${SITE}${url.pathname}>; rel="canonical", <${SITE}${SOURCE}>; rel="describedby"; type="text/markdown"`,
        },
      })
    }
  }
  // 网页：静态资源的响应头（_headers 里的安全策略等）由 Cloudflare 照常加上，这里只补充 Vary
  const response = await assets.fetch(request)
  const page = new Response(response.body, response)
  page.headers.append('vary', 'Accept')
  return page
}
