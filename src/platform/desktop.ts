/**
 * 桌面版的厂商、游戏和页面：替代网页版的 ./index.ts（vite.config.ts 在桌面构建里把 '@/platform' 解析到这里）。
 * 这里和它引用的组件（src/components/mhy/）只会出现在桌面版的产物里。
 */
import { defineAsyncComponent } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { ExtraSource, ExtraVendor } from './index'

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

export const EXTRA_SOURCES: ExtraSource[] = [
  { name: '米哈游', desc: '原神、崩坏：星穹铁道的抽卡记录（本机直接请求官方接口，不经过任何服务器）', url: 'https://www.mihoyo.com/' },
  { name: '原神 BWIKI', desc: '原神角色、武器的头像：由你的电脑直接向 BWIKI 的服务器请求，只缓存在本机（图片不来自本项目）', url: 'https://wiki.biligame.com/ys/' },
  { name: '崩坏：星穹铁道 BWIKI', desc: '星铁角色、光锥的头像（同上）', url: 'https://wiki.biligame.com/sr/' },
]

/**
 * 维护者 2026-10-20：“用 bwiki 的图，并且软件声明不拥有图片版权”；
 * “增加申明，图片全部不来自于本项目，并且请求由本机直接向社区服务器发送”
 */
export const EXTRA_NOTICES: string[] = [
  'ArkRecord 与米哈游无关。原神、崩坏：星穹铁道的名称与图像版权归米哈游所有。',
  '角色、武器、光锥的图片全部来自社区维基 BWIKI，不来自本项目，本项目也不拥有这些图片的版权；图片由你的电脑直接向 BWIKI 的服务器请求，只缓存在本机，不打包进安装包，也不经过本项目的任何服务器。',
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
