/**
 * 原神、星铁的头像：用 BWIKI 的图（维护者 2026-10-20 的决定，“软件声明不拥有图片版权”，见“关于”页）。
 * 名单（中文名 → 图片路径）由本机后端 mhy.icons 从 BWIKI 拉取、缓存在本机；图片走 /api/img/bwiki/…，
 * 由后端按桌面版的白名单下载、只缓存在这台电脑上，不打包、不进网页版。
 * 只认简体中文的名称（和大小保底的判断一致）；对不上、后端还拿不到名单时，CharAvatar 显示文字。
 */
import { reactive } from 'vue'
import type { MhyGame } from '@/lib/mhy/types'
import { desktopBridge } from '@/lib/transport'

/** 后端给的图片路径：只接受 images/ 下的相对路径，不含 ..、查询参数和锚点（后端还会再按白名单检查） */
const SAFE_TARGET = /^images\/[\w\-./%]+$/

const lists = reactive<Partial<Record<MhyGame, Record<string, string>>>>({})
const loading = new Set<MhyGame>()

function load(game: MhyGame): void {
  if (game in lists || loading.has(game)) return
  const bridge = desktopBridge()
  if (!bridge) return
  loading.add(game)
  bridge
    .rpc('mhy.icons', { game })
    .then((value) => {
      const items = (value as { items?: unknown } | null)?.items
      const list: Record<string, string> = {}
      if (items && typeof items === 'object') {
        for (const [name, target] of Object.entries(items)) {
          if (typeof target === 'string' && SAFE_TARGET.test(target) && !target.includes('..')) list[name] = target
        }
      }
      lists[game] = list
    })
    // 后端还没有这个方法、拉不到名单：这次打开应用期间只显示文字
    .catch(() => (lists[game] = {}))
    .finally(() => loading.delete(game))
}

/** 名称对应的头像地址；第一次用到某个游戏时去拿名单，拿到之前和对不上时是 undefined */
export function mhyIconUrl(game: MhyGame, name: string): string | undefined {
  load(game)
  const target = lists[game]?.[name]
  return target ? `/api/img/bwiki/${target}` : undefined
}
