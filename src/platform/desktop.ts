/**
 * 桌面版的厂商、游戏和页面：替代网页版的 ./index.ts（vite.config.ts 在桌面构建里把 '@/platform' 解析到这里）。
 * 这里和它引用的组件（src/components/mhy/）只会出现在桌面版的产物里。
 */
import { defineAsyncComponent } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { ExtraVendor } from './index'

const MhyGamePage = () => import('@/components/mhy/MhyGamePage.vue')

export const EXTRA_VENDORS: ExtraVendor[] = [
  {
    id: 'mhy',
    label: '米哈游',
    short: '米',
    games: [{ id: 'genshin', label: '原神', short: '原神', to: '/genshin' }],
    sidebar: defineAsyncComponent(() => import('@/components/mhy/MhySidebar.vue')),
  },
]

export const EXTRA_ROUTES: RouteRecordRaw[] = [
  { path: '/genshin', name: 'genshin', component: MhyGamePage, props: { game: 'genshin', view: 'stats' } },
  { path: '/genshin/records', name: 'genshin-records', component: MhyGamePage, props: { game: 'genshin', view: 'records' } },
]
