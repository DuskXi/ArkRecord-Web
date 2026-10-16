/**
 * 统计同意（Cookie 同意）。
 *
 * 本站不用 Cookie 追踪访客。需要征得同意的是两项可选统计（“全部接受”）：
 *   - 本站的匿名使用人数统计（src/lib/usage.ts、worker/stats.ts）
 *   - Cloudflare Web Analytics（不使用 Cookie 的访问量统计，见 src/lib/analytics.ts）
 * “仅必要”指网站功能本身需要的存储：在浏览器里保存用户自己的寻访记录、账号和设置，不会上传。
 * 用户做出选择之前，两项统计都不启用。
 */
export type Consent = 'all' | 'essential'

const KEY = 'arkrecord:consent'
/** 旧的“不参与统计”开关，迁移为“仅必要” */
const LEGACY_OPT_OUT_KEY = 'arkrecord:usage-optout'

export function readConsent(): Consent | null {
  try {
    const value = localStorage.getItem(KEY)
    if (value === 'all' || value === 'essential') return value
    return localStorage.getItem(LEGACY_OPT_OUT_KEY) === '1' ? 'essential' : null
  } catch {
    return null
  }
}

export function writeConsent(consent: Consent): void {
  try {
    localStorage.setItem(KEY, consent)
    localStorage.removeItem(LEGACY_OPT_OUT_KEY)
  } catch {
    // localStorage 不可用时只在本次访问内生效
  }
}
