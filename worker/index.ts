/**
 * ArkRecord 的 Cloudflare Worker。
 *
 * 只做一件事：把本站页面发出的请求原样转发给白名单内的鹰角接口（原因见 upstreams.ts）。
 * 不解析、不记录、不存储任何请求或响应内容；不访问 PRTS 或其他第三方。
 * 静态页面由 Cloudflare 直接返回，不经过这里的代码（见 wrangler.jsonc 的 run_worker_first）。
 */

import { type Env, handleRequest } from './proxy'

// 入口模块只能导出处理器
export default {
  fetch: (request, env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>
