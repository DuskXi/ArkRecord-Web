/**
 * Worker 允许转发的全部上游。
 *
 * 为什么需要转发：
 *   下列鹰角接口都不允许浏览器跨域（CORS）请求——响应里没有 Access-Control-Allow-Origin，
 *   浏览器会直接拦截（2026-10-16 实测，详见 docs/rewrite/research.md 1.5）。
 *   明日方舟的数据接口还依赖 Cookie `ak-user-center`，而浏览器 JS 无法设置 Cookie，
 *   也读不到 Set-Cookie。网页因此无法直接调用这些接口。
 *
 * 转发只为绕过这一浏览器限制，不是为了获取任何信息：
 *   - Worker 只把浏览器请求体里的参数按白名单拼成上游请求（见 proxy.ts），不解析响应内容，
 *     不记录、不存储任何请求或响应内容（包括 token）；token 只在发给 Worker 的请求体里，不出现在网址和请求头里；
 *   - 所有数据处理都在用户浏览器本地完成；
 *   - 只接受本站同源请求，不返回任何 CORS 头，其他网站无法借用这个转发（见 security.ts）。
 *
 * 新增上游时，必须在 shared/upstreams/hg.json 的 reason 里写明原因和实测情况。
 */

import HG_UPSTREAMS from '../shared/upstreams/hg.json'

export type Limiter = 'auth' | 'data'

export interface Route {
  /** 上游实际使用的方法（浏览器发给 Worker 的请求一律是 POST，参数在请求体里，见 proxy.ts） */
  method: 'GET' | 'POST'
  /** 完整路径，必须精确匹配 */
  path: string
  limiter: Limiter
}

export interface Upstream {
  host: string
  /** 用途（同时显示在网站的“关于”页面） */
  purpose: string
  /** 需要转发的原因，以及实测情况（同时显示在网站的“关于”页面） */
  reason: string
  routes: readonly Route[]
  /** 需要把 `x-cookie` 中的 ak-user-center 转成 Cookie，并把 Set-Cookie 转成可读的响应头 */
  relayAkCookie?: boolean
  /** 转发时附加的固定请求头 */
  extraHeaders?: Readonly<Record<string, string>>
}

/**
 * 白名单本身在 shared/upstreams/hg.json：桌面版的 Python 后端读同一份文件，只发白名单内的请求。
 * 每个上游的 reason 写明需要转发的原因和实测情况（2026-10-16 实测，详见 docs/rewrite/research.md 1.5）。
 */
export const UPSTREAMS = HG_UPSTREAMS as Readonly<Record<keyof typeof HG_UPSTREAMS, Upstream>>

export type UpstreamName = keyof typeof UPSTREAMS

export function findRoute(name: string, path: string): { upstream: Upstream; route: Route } | null {
  if (!Object.hasOwn(UPSTREAMS, name)) return null
  const upstream: Upstream = UPSTREAMS[name as UpstreamName]
  const route = upstream.routes.find((r) => r.path === path)
  return route ? { upstream, route } : null
}
