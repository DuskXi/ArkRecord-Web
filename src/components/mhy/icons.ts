/**
 * 桌面版按名称查头像：原神、星铁（维护者 2026-10-20 的决定：用 BWIKI 的图，“软件声明不拥有图片版权”，见“关于”页），
 * 以及终末地（维护者：“本地全走转发限速这条路”，见 src/platform/desktop.ts 的 AVATAR_RESOLVER）。
 * 页面用到哪些名称，就把这些名称交给本机后端 wiki.icons 查图片路径（后端只查这些、缓存在本机，对 BWIKI 低频）；
 * 后端返回“来源/路径”（bwiki/images/… 或 skland/image/…），图片走 /api/img/<来源>/<路径>，由后端按桌面版的白名单下载、
 * 只缓存在这台电脑上，不打包、不进网页版。终末地还带上物品 ID：BWIKI 没有的新角色，后端按 ID 用森空岛的图
 * （和网页版构建脚本一样“BWIKI 为主、森空岛为备”，docs/rewrite/data-sources.md）。
 * 只查带汉字的名称（简体中文的记录，和大小保底的判断一致）；对不上、还没查到时，CharAvatar 显示文字。
 */
import { reactive } from 'vue'
import type { MhyGame } from '@/lib/mhy/types'
import { desktopBridge } from '@/lib/transport'

export type WikiGame = MhyGame | 'endfield'

/** 后端给的“来源/路径”：只认这两种来源下的相对路径，不含 ..、查询参数和锚点（后端还会再按白名单检查） */
const SAFE_TARGET = /^(?:bwiki\/images|skland\/image)\/[\w\-./%]+$/
const HAN = /\p{Script=Han}/u
/** 后端接受的物品 ID（终末地，用来查森空岛的后备） */
const ITEM_ID = /^[a-z0-9_-]{1,64}$/
/** 攒一会儿再查 */
const FLUSH_DELAY_MS = 200
/**
 * 一次调用最多交给后端几个名称：后端一次调用最多 2 个请求、每个请求 50 个文件名。
 * 原神、星铁一个名称查 1 个文件名；终末地查“头像”“图标”，去掉空格下划线再试一次，一个名称占 2～4 个，所以少给一些，
 * 剩下的马上接着查（后端按每分钟上限排队），不用等“没查完”的 10 分钟。
 */
const MAX_PER_CALL: Record<WikiGame, number> = { genshin: 100, starrail: 100, endfield: 25 }
/** 后端说没查完（BWIKI 出错后在退避）时，过一会儿再问；后端在退避期间不会发请求 */
const RETRY_MS = 10 * 60 * 1000

interface GameState {
  /** 这次打开应用期间问过的名称 */
  asked: Set<string>
  pending: Set<string>
  /** 名称对应的物品 ID（只有终末地会传给后端） */
  ids: Map<string, string>
  busy: boolean
  timer?: ReturnType<typeof setTimeout>
  /** 后端没有这个方法、调用失败：这次打开应用期间只显示文字 */
  disabled: boolean
}

const urls = reactive<Partial<Record<WikiGame, Record<string, string>>>>({})
/** 没查到的名称“可以再问”时加一：用到头像的地方（CharAvatar）会重新取，不用等页面重新渲染 */
const retryRounds = reactive<Partial<Record<WikiGame, number>>>({})
const states: Partial<Record<WikiGame, GameState>> = {}

function stateOf(game: WikiGame): GameState {
  return (states[game] ??= { asked: new Set(), pending: new Set(), ids: new Map(), busy: false, disabled: false })
}

function schedule(game: WikiGame): void {
  const s = stateOf(game)
  if (s.timer || s.busy) return
  s.timer = setTimeout(() => {
    s.timer = undefined
    void flush(game)
  }, FLUSH_DELAY_MS)
}

async function flush(game: WikiGame): Promise<void> {
  const s = stateOf(game)
  const bridge = desktopBridge()
  if (!bridge) {
    s.disabled = true
    return
  }
  const names = [...s.pending].slice(0, MAX_PER_CALL[game])
  for (const name of names) s.pending.delete(name)
  if (!names.length) return
  s.busy = true
  try {
    const ids = Object.fromEntries(names.flatMap((name) => (s.ids.has(name) ? [[name, s.ids.get(name)!]] : [])))
    const params = game === 'endfield' && Object.keys(ids).length ? { game, names, ids } : { game, names }
    const value = (await bridge.rpc('wiki.icons', params)) as { items?: unknown; complete?: unknown } | null
    const items = value?.items
    const list = (urls[game] ??= {})
    if (items && typeof items === 'object') {
      for (const [name, target] of Object.entries(items)) {
        if (typeof target === 'string' && SAFE_TARGET.test(target) && !target.includes('..')) list[name] = `/api/img/${target}`
      }
    }
    if (value?.complete === false) {
      // 没查到的过一会儿可以再问
      setTimeout(() => {
        for (const name of names) if (!urls[game]?.[name]) s.asked.delete(name)
        retryRounds[game] = (retryRounds[game] ?? 0) + 1
      }, RETRY_MS)
    }
  } catch {
    s.disabled = true
    s.pending.clear()
  } finally {
    s.busy = false
    if (s.pending.size && !s.disabled) schedule(game)
  }
}

/** 名称对应的头像地址；第一次用到某个名称时去查，查到之前和对不上时是 undefined。itemId 只有终末地用得上 */
export function wikiIconUrl(game: WikiGame, name: string, itemId?: string | null): string | undefined {
  // 读一下计数：没查到的可以再问时，调用的地方会重新执行
  void retryRounds[game]
  const url = urls[game]?.[name]
  if (url) return url
  const s = stateOf(game)
  if (!s.disabled && !s.asked.has(name) && name.length <= 40 && HAN.test(name)) {
    if (itemId && ITEM_ID.test(itemId)) s.ids.set(name, itemId)
    s.asked.add(name)
    s.pending.add(name)
    schedule(game)
  }
  return undefined
}
