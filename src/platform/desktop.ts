/**
 * 桌面版的厂商、游戏和页面：替代网页版的 ./index.ts（vite.config.ts 在桌面构建里把 '@/platform' 解析到这里）。
 * 这里和它引用的组件（src/components/mhy/）只会出现在桌面版的产物里。
 */
import { defineAsyncComponent } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { wikiIconUrl } from '@/components/mhy/icons'
import type { AvatarResolver, ExtraSource, ExtraVendor } from './index'

const MhyGamePage = () => import('@/components/mhy/MhyGamePage.vue')

export const EXTRA_VENDORS: ExtraVendor[] = [
  // 四款游戏的总览（维护者：“先做总览Dashboard”），排在厂商切换最前面；只有一页，不显示游戏切换
  {
    id: 'all',
    label: '总览',
    short: '总',
    games: [{ id: 'dashboard', label: '总览', short: '总览', to: '/home', subtitle: 'ALL GAMES' }],
    sidebar: defineAsyncComponent(() => import('@/components/desktop/DashboardSidebar.vue')),
    brand: 'GAMERECORD',
    first: true,
  },
  {
    id: 'mhy',
    label: '米哈游',
    short: '米',
    games: [
      { id: 'genshin', label: '原神', short: '原神', to: '/genshin' },
      { id: 'starrail', label: '星铁', short: '星铁', to: '/starrail' },
    ],
    sidebar: defineAsyncComponent(() => import('@/components/mhy/MhySidebar.vue')),
    // 维护者：切换为米哈游的时候，上面不写 ARKRECORD，写 GAMERECORD
    brand: 'GAMERECORD',
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

/**
 * 维护者 2026-10-20：“本地全走转发限速这条路”。桌面版的头像全部在运行时由本机后端按白名单转发、按来源站限速、只缓存在本机，
 * 安装包里不带镜像的头像（vite.config.ts 的 desktopWithoutMirroredAvatars）。米哈游的页面由 MhyGamePage 的 host.avatar 取图。
 */
const AK_CHAR_ID = /^char_\w{1,60}$/
export const AVATAR_RESOLVER: AvatarResolver = (game, itemId, name) => {
  // 明日方舟：只用 PRTS（PRTS 上没有的显示文字）
  if (game === 'arknights') return itemId && AK_CHAR_ID.test(itemId) ? `/api/img/prts-avatar/${itemId}` : undefined
  // 终末地：按名称查 BWIKI 的“<名称>头像 / 图标”，BWIKI 没有的新角色按物品 ID 用森空岛的图
  if (game === 'endfield') return wikiIconUrl('endfield', name, itemId)
  return undefined
}

/** “关于”页：桌面版的头像不是镜像到本站的，按需加载 */
export const SOURCE_NOTES: Record<string, string> = {
  PRTS: '明日方舟干员名单、UP 名单、卡池名称（构建时获取）；干员头像由你的电脑直接向 PRTS 请求，只缓存在本机',
  'yuanyan3060/ArknightsGameResource': '干员头像的备用来源（只用于网页版的镜像，桌面版不使用）',
  '明日方舟终末地 BWIKI': '终末地角色头像与武器图标：由你的电脑直接向 BWIKI 请求，只缓存在本机',
  森空岛:
    'BWIKI 暂缺的终末地角色头像：由你的电脑直接向森空岛请求，只缓存在本机；图片地址取自 cmyyx/cep 的索引（一天最多取一次，只读取其中的图片地址）',
}

/** 米哈游每个游戏的页面：都是 MhyGamePage，里面用鹰角的统计页面；路径和 MhySidebar 的导航对应 */
const VIEWS = [
  { path: '', view: 'overview' },
  { path: '/records', view: 'history' },
  { path: '/analysis', view: 'analysis' },
  { path: '/stats', view: 'stats' },
  { path: '/timeline', view: 'timeline' },
  { path: '/data', view: 'data' },
] as const

export const EXTRA_ROUTES: RouteRecordRaw[] = [
  // 四款游戏的总览
  { path: '/home', name: 'dashboard', component: () => import('@/components/desktop/DashboardPage.vue') },
  ...(['genshin', 'starrail'] as const).flatMap((game) =>
    VIEWS.map(({ path, view }) => ({
      path: `/${game}${path}`,
      name: path ? `${game}-${view}` : game,
      component: MhyGamePage,
      props: { game, view },
    })),
  ),
]
