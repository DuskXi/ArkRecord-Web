/**
 * ArkRecord 的 Cloudflare Worker。
 *
 * 只做三件事：
 *   - 把本站页面发出的请求转发给白名单内的鹰角接口（原因见 upstreams.ts，请求格式见 proxy.ts）；
 *   - 为本站页面缓存少量构建时拿不到的图片（见 images.ts），结果缓存在 Cloudflare，减少对来源站的请求；
 *   - 匿名使用人数统计（见 stats.ts），只维护计数器，不收集任何标识符，用户同意后才上报；
 *   - 站内反馈（见 feedback.ts），只保存用户主动提交的内容；
 *   - 云同步（见 cloud.ts、cloud-vault.ts），只保存浏览器加密后的密文；核实鹰角 token 的代码只在 hg-verify.ts。
 * 转发时不记录、不存储任何请求或响应内容。
 * 静态页面由 Cloudflare 直接返回，不经过这里的代码（见 wrangler.jsonc 的 run_worker_first）。
 *
 * 鹰角 token 只存在于处理请求时的内存里：
 *   - 浏览器把 token 放在请求体里（不放在网址和请求头里），平台的统计、安全事件和实时日志都不包含请求体；
 *   - Workers Logs 已关闭（wrangler.jsonc 的 observability），代码里没有 console 输出（CI 检查，见 token-fields.test.ts）；
 *   - 未预料的异常在这里统一变成不带任何细节的 500，异常信息（可能含有带 token 的上游地址）不会交给平台；
 *   - 不写入任何存储（云同步的 Durable Object 只收到白名单字段，见 cloud.ts）。
 */

import { type Env, handleRequest } from './proxy'

// 入口模块只能导出处理器和 Durable Object 类
export { CloudVault } from './cloud-vault'
export { FeedbackStore } from './feedback'
export { UsageStats } from './stats'

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx)
    } catch {
      return new Response('{"error":"internal_error"}', {
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
  },
} satisfies ExportedHandler<Env>
