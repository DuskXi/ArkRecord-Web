import type { NavigationMenuItem } from '@nuxt/ui'
import type { Game } from './lib/types'

/** 图标名必须写成字面量，构建时才能被扫描并打包 */
export const NAV_ITEMS: NavigationMenuItem[] = [
  { label: '总览', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: '寻访记录', icon: 'i-lucide-scroll-text', to: '/history' },
  { label: '卡池', icon: 'i-lucide-layers', to: '/banners' },
  { label: '分析', icon: 'i-lucide-chart-column-big', to: '/analysis' },
  { label: '高级统计', icon: 'i-lucide-telescope', to: '/stats' },
  { label: '时间线', icon: 'i-lucide-git-commit-vertical', to: '/timeline' },
  { label: '图鉴', icon: 'i-lucide-book-user', to: '/codex' },
  // 只有明日方舟有源石与充值记录（App.vue 按当前游戏过滤）
  { label: '源石与充值', icon: 'i-lucide-gem', to: '/ledger' },
  { label: '数据', icon: 'i-lucide-database', to: '/data' },
  { label: '更新公告', icon: 'i-lucide-megaphone', to: '/announcements' },
  { label: '反馈', icon: 'i-lucide-message-square-text', to: '/feedback' },
  { label: '关于', icon: 'i-lucide-shield-check', to: '/about' },
]

/** 只在某个游戏下显示的页面 */
const GAME_ONLY: Record<string, Game> = { '/ledger': 'arknights' }

export function navItemsFor(game: Game): NavigationMenuItem[] {
  return NAV_ITEMS.filter((item) => {
    const only = GAME_ONLY[String(item.to)]
    return !only || only === game
  })
}

export const MOBILE_NAV_ITEMS = [
  { label: '总览', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: '记录', icon: 'i-lucide-scroll-text', to: '/history' },
  { label: '分析', icon: 'i-lucide-chart-column-big', to: '/analysis' },
  { label: '统计', icon: 'i-lucide-telescope', to: '/stats' },
  { label: '数据', icon: 'i-lucide-database', to: '/data' },
]
