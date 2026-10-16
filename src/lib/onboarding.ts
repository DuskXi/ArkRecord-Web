/**
 * 第一次访问时的引导顺序：欢迎窗口 → 旧版数据迁移（有旧数据时）→ 统计同意（见 consent.ts，选择之前不启用任何统计）。
 * 欢迎窗口只显示一次；localStorage 不可用时不显示，避免每次打开都弹。
 */
const WELCOME_KEY = 'arkrecord:welcome'

export function welcomeSeen(): boolean {
  try {
    return localStorage.getItem(WELCOME_KEY) === '1'
  } catch {
    return true
  }
}

export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(WELCOME_KEY, '1')
  } catch {
    // 忽略
  }
}
