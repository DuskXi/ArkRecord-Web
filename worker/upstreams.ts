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
 *   - Worker 不解析、不记录、不存储任何请求或响应内容（包括 token）；
 *   - 所有数据处理都在用户浏览器本地完成；
 *   - 只接受本站同源请求，不返回任何 CORS 头，其他网站无法借用这个转发（见 security.ts）。
 *
 * 新增上游时，必须写明原因和实测情况。
 */

export type Limiter = 'auth' | 'data'

export interface Route {
  method: 'GET' | 'POST'
  /** 完整路径，必须精确匹配 */
  path: string
  limiter: Limiter
}

export interface Upstream {
  host: string
  routes: readonly Route[]
  /** 需要把 `x-cookie` 中的 ak-user-center 转成 Cookie，并把 Set-Cookie 转成可读的响应头 */
  relayAkCookie?: boolean
  /** 转发时附加的固定请求头 */
  extraHeaders?: Readonly<Record<string, string>>
}

export const UPSTREAMS = {
  // 鹰角通行证：用账号 token 换取 OAuth token。
  // 原因：响应不带 Access-Control-Allow-Origin，POST 的 CORS 预检即失败（2026-10-16 实测）。
  as: {
    host: 'as.hypergryph.com',
    routes: [{ method: 'POST', path: '/user/oauth2/v2/grant', limiter: 'auth' }],
  },

  // 角色绑定：查询账号下绑定的游戏角色，并为指定角色换取游戏 u8 token。
  // 原因：响应不带 Access-Control-Allow-Origin（2026-10-16 实测：上游返回 400，仍被浏览器拦截）。
  binding: {
    host: 'binding-api-account-prod.hypergryph.com',
    routes: [
      { method: 'GET', path: '/account/binding/v1/binding_list', limiter: 'auth' },
      { method: 'POST', path: '/account/binding/v1/u8_token_by_uid', limiter: 'auth' },
    ],
  },

  // 明日方舟官网用户中心：角色登录与寻访记录。
  // 原因：响应不带 Access-Control-Allow-Origin（2026-10-16 实测：上游返回 401，仍被浏览器拦截）；
  //       另外数据接口依赖 Cookie ak-user-center，浏览器 JS 无法设置 Cookie，也读不到 Set-Cookie。
  ak: {
    host: 'ak.hypergryph.com',
    relayAkCookie: true,
    extraHeaders: { referer: 'https://ak.hypergryph.com/user/headhunting' },
    routes: [
      { method: 'POST', path: '/user/api/role/login', limiter: 'auth' },
      { method: 'GET', path: '/user/api/inquiry/gacha/cate', limiter: 'data' },
      { method: 'GET', path: '/user/api/inquiry/gacha/history', limiter: 'data' },
    ],
  },

  // 终末地游戏内网页（ef-webview）背后的寻访记录与卡池信息接口。
  // 原因：响应不带 Access-Control-Allow-Origin（2026-10-16 实测：上游返回 200，仍被浏览器拦截）。
  ef: {
    host: 'ef-webview.hypergryph.com',
    routes: [
      { method: 'GET', path: '/api/record/char', limiter: 'data' },
      { method: 'GET', path: '/api/record/char/meta', limiter: 'data' },
      { method: 'GET', path: '/api/record/char/pool', limiter: 'data' },
      { method: 'GET', path: '/api/record/weapon', limiter: 'data' },
      { method: 'GET', path: '/api/record/weapon/pool', limiter: 'data' },
      { method: 'GET', path: '/api/content', limiter: 'data' },
    ],
  },
} as const satisfies Record<string, Upstream>

export type UpstreamName = keyof typeof UPSTREAMS

export function findRoute(
  name: string,
  method: string,
  path: string,
): { upstream: Upstream; route: Route } | null {
  if (!Object.hasOwn(UPSTREAMS, name)) return null
  const upstream: Upstream = UPSTREAMS[name as UpstreamName]
  const route = upstream.routes.find((r) => r.method === method && r.path === path)
  return route ? { upstream, route } : null
}
