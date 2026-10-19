/**
 * 桌面版的游戏入口和页面：替代网页版的 ./index.ts（vite.config.ts 在桌面构建里把 '@/platform' 解析到这里）。
 * 这里和它引用的页面（src/pages/mhy/）只会出现在桌面版的产物里。
 */
import type { RouteRecordRaw } from 'vue-router'
import type { ExtraGame } from './index'

export const EXTRA_GAMES: ExtraGame[] = [{ id: 'genshin', label: '原神', short: '原神', to: '/genshin' }]

export const EXTRA_ROUTES: RouteRecordRaw[] = [{ path: '/genshin', name: 'genshin', component: () => import('@/pages/mhy/GenshinPage.vue') }]
