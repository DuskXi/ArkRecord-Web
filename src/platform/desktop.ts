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
    games: [
      { id: 'genshin', label: '原神', short: '原神', to: '/genshin' },
      { id: 'starrail', label: '星铁', short: '星铁', to: '/starrail' },
    ],
    sidebar: defineAsyncComponent(() => import('@/components/mhy/MhySidebar.vue')),
  },
]

/** 米哈游每个游戏的页面：都是 MhyGamePage，里面用鹰角的统计页面；路径和 MhySidebar 的导航对应 */
const VIEWS = [
  { path: '', view: 'overview' },
  { path: '/records', view: 'history' },
  { path: '/analysis', view: 'analysis' },
  { path: '/stats', view: 'stats' },
  { path: '/timeline', view: 'timeline' },
] as const

export const EXTRA_ROUTES: RouteRecordRaw[] = (['genshin', 'starrail'] as const).flatMap((game) =>
  VIEWS.map(({ path, view }) => ({
    path: `/${game}${path}`,
    name: path ? `${game}-${view}` : game,
    component: MhyGamePage,
    props: { game, view },
  })),
)
