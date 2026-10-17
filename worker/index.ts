/**
 * ArkRecord 的 Cloudflare Worker。
 *
 * 只做三件事：
 *   - 把本站页面发出的请求原样转发给白名单内的鹰角接口（原因见 upstreams.ts）；
 *   - 为本站页面缓存少量构建时拿不到的图片（见 images.ts），结果缓存在 Cloudflare，减少对来源站的请求；
 *   - 匿名使用人数统计（见 stats.ts），只维护计数器，不收集任何标识符，用户同意后才上报；
 *   - 站内反馈（见 feedback.ts），只保存用户主动提交的内容；
 *   - 云同步（见 cloud.ts、cloud-vault.ts），只保存浏览器加密后的密文；核实鹰角 token 的代码只在 hg-verify.ts。
 * 转发时不解析、不记录、不存储任何请求或响应内容。
 * 静态页面由 Cloudflare 直接返回，不经过这里的代码（见 wrangler.jsonc 的 run_worker_first）。
 */

import { type Env, handleRequest } from './proxy'

// 入口模块只能导出处理器和 Durable Object 类
export { CloudVault } from './cloud-vault'
export { FeedbackStore } from './feedback'
export { UsageStats } from './stats'

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
} satisfies ExportedHandler<Env>
