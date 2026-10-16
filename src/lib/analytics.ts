/**
 * Cloudflare Web Analytics：不使用 Cookie 的访问量统计，只在用户“全部接受”之后加载（见 consent.ts）。
 * Cloudflare 后台需要关闭这个站点的“自动注入”，否则边缘会把脚本直接插进每个页面，网页无法按用户的选择控制。
 */

/** kaltsit.dev 站点的 Web Analytics token：每个页面里本来就会带上它，是公开的，不是密钥 */
const CF_BEACON_TOKEN = 'c8e2c46f20374ee0b102e4d0bdcd5f98'
const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js'

export function loadCloudflareAnalytics(): void {
  // 只在正式与测试域名上加载，本地开发不统计
  if (!/(^|\.)kaltsit\.dev$/.test(location.hostname)) return
  if (document.querySelector('script[src^="https://static.cloudflareinsights.com/"]')) return
  const script = document.createElement('script')
  script.defer = true
  script.src = BEACON_SRC
  script.dataset.cfBeacon = JSON.stringify({ token: CF_BEACON_TOKEN })
  document.head.append(script)
}
