/**
 * 原神、星铁的头像：用 BWIKI 的图（维护者 2026-10-20 的决定，“软件声明不拥有图片版权”，见“关于”页）。
 * 页面用到哪些名称，就把这些名称交给本机后端 mhy.icons 查图片路径（后端只查这些、缓存在本机，对 BWIKI 低频）；
 * 图片走 /api/img/bwiki/…，由后端按桌面版的白名单下载、只缓存在这台电脑上，不打包、不进网页版。
 * 只查带汉字的名称（简体中文的记录，和大小保底的判断一致）；对不上、还没查到时，CharAvatar 显示文字。
 */
import { reactive } from 'vue'
import type { MhyGame } from '@/lib/mhy/types'
import { desktopBridge } from '@/lib/transport'

/** 后端给的图片路径：只接受 images/ 下的相对路径，不含 ..、查询参数和锚点（后端还会再按白名单检查） */
const SAFE_TARGET = /^images\/[\w\-./%]+$/
const HAN = /\p{Script=Han}/u
/** 攒一会儿再查，一次最多 200 个（和后端一次调用的上限一致） */
const FLUSH_DELAY_MS = 200
const MAX_PER_CALL = 200
/** 后端说没查完（BWIKI 出错后在退避）时，过一会儿再问；后端在退避期间不会发请求 */
const RETRY_MS = 10 * 60 * 1000

interface GameState {
  /** 这次打开应用期间问过的名称 */
  asked: Set<string>
  pending: Set<string>
  busy: boolean
  timer?: ReturnType<typeof setTimeout>
  /** 后端没有这个方法、调用失败：这次打开应用期间只显示文字 */
  disabled: boolean
}

const urls = reactive<Partial<Record<MhyGame, Record<string, string>>>>({})
/** 没查到的名称“可以再问”时加一：用到头像的地方（CharAvatar）会重新取，不用等页面重新渲染 */
const retryRounds = reactive<Partial<Record<MhyGame, number>>>({})
const states: Partial<Record<MhyGame, GameState>> = {}

function stateOf(game: MhyGame): GameState {
  return (states[game] ??= { asked: new Set(), pending: new Set(), busy: false, disabled: false })
}

function schedule(game: MhyGame): void {
  const s = stateOf(game)
  if (s.timer || s.busy) return
  s.timer = setTimeout(() => {
    s.timer = undefined
    void flush(game)
  }, FLUSH_DELAY_MS)
}

async function flush(game: MhyGame): Promise<void> {
  const s = stateOf(game)
  const bridge = desktopBridge()
  if (!bridge) {
    s.disabled = true
    return
  }
  const names = [...s.pending].slice(0, MAX_PER_CALL)
  for (const name of names) s.pending.delete(name)
  if (!names.length) return
  s.busy = true
  try {
    const value = (await bridge.rpc('mhy.icons', { game, names })) as { items?: unknown; complete?: unknown } | null
    const items = value?.items
    const list = (urls[game] ??= {})
    if (items && typeof items === 'object') {
      for (const [name, target] of Object.entries(items)) {
        if (typeof target === 'string' && SAFE_TARGET.test(target) && !target.includes('..')) list[name] = `/api/img/bwiki/${target}`
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

/** 名称对应的头像地址；第一次用到某个名称时去查，查到之前和对不上时是 undefined */
export function mhyIconUrl(game: MhyGame, name: string): string | undefined {
  // 读一下计数：没查到的可以再问时，调用的地方会重新执行
  void retryRounds[game]
  const url = urls[game]?.[name]
  if (url) return url
  const s = stateOf(game)
  if (!s.disabled && !s.asked.has(name) && name.length <= 40 && HAN.test(name)) {
    s.asked.add(name)
    s.pending.add(name)
    schedule(game)
  }
  return undefined
}
