/**
 * 桌面版的使用人数统计：交给本机的 Python 后端（desktop/backend/arkrecord_backend/stats.py），页面只告诉它有哪些账号。
 * 默认开启，“关于”页可以关闭；上报什么、服务器保存什么见 SECURITY.md 的“桌面版的使用人数统计”。
 * 网页版不用这个文件（网页版的匿名统计见 usage.ts，要用户同意后才上报）。
 */
import { DEMO_ACCOUNT_ID } from './demo-account'
import { desktopBridge } from './transport'
import type { Account } from './types'

export interface DesktopStatsStatus {
  enabled: boolean
  /** 后端能不能上报（开发环境没设置上报地址时为 false） */
  available: boolean
}

export async function desktopStatsStatus(): Promise<DesktopStatsStatus | null> {
  const bridge = desktopBridge()
  if (!bridge) return null
  try {
    const result = (await bridge.rpc('stats.status')) as Partial<DesktopStatsStatus> | null
    return { enabled: result?.enabled === true, available: result?.available === true }
  } catch {
    return null
  }
}

export async function setDesktopStatsEnabled(enabled: boolean): Promise<boolean> {
  const bridge = desktopBridge()
  if (!bridge) return false
  try {
    await bridge.rpc('stats.setEnabled', { enabled })
    return true
  } catch {
    return false
  }
}

/** 交给后端的账号：只有游戏和 UID，演示账号不算。后端负责加盐哈希、每天去重、分开上报 */
export function accountsForDesktopStats(accounts: readonly Pick<Account, 'id' | 'game' | 'uid'>[]): { game: string; uid: string }[] {
  return accounts.filter((a) => a.id !== DEMO_ACCOUNT_ID).map((a) => ({ game: a.game, uid: a.uid }))
}

/**
 * 把这台电脑上的账号和同步识别码（开通过云同步才有，见 sync-user.ts）告诉后端；关闭了统计时后端什么都不发。
 * 后端负责哈希、每天去重、分开上报。失败不影响任何功能
 */
export function reportDesktopStats(accounts: readonly Pick<Account, 'id' | 'game' | 'uid'>[], syncUser?: string): void {
  desktopBridge()
    ?.rpc('stats.report', { accounts: accountsForDesktopStats(accounts), ...(syncUser ? { user: syncUser } : {}) })
    .catch(() => undefined)
}
