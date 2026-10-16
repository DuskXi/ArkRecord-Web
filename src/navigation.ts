import type { NavigationMenuItem } from '@nuxt/ui'

/** 图标名必须写成字面量，构建时才能被扫描并打包 */
export const NAV_ITEMS: NavigationMenuItem[] = [
  { label: '总览', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: '寻访记录', icon: 'i-lucide-scroll-text', to: '/history' },
  { label: '卡池', icon: 'i-lucide-layers', to: '/banners' },
  { label: '分析', icon: 'i-lucide-chart-column-big', to: '/analysis' },
  { label: '高级统计', icon: 'i-lucide-telescope', to: '/stats' },
  { label: '时间线', icon: 'i-lucide-git-commit-vertical', to: '/timeline' },
  { label: '数据', icon: 'i-lucide-database', to: '/data' },
  { label: '关于', icon: 'i-lucide-shield-check', to: '/about' },
]

export const MOBILE_NAV_ITEMS = [
  { label: '总览', icon: 'i-lucide-layout-dashboard', to: '/' },
  { label: '记录', icon: 'i-lucide-scroll-text', to: '/history' },
  { label: '分析', icon: 'i-lucide-chart-column-big', to: '/analysis' },
  { label: '统计', icon: 'i-lucide-telescope', to: '/stats' },
  { label: '数据', icon: 'i-lucide-database', to: '/data' },
]
