/**
 * 侧边栏的两层切换：厂商（鹰角 / 桌面版的其他厂商）→ 这个厂商的游戏。
 * 当前在哪个厂商、哪个游戏由页面路径决定（鹰角的页面不在任何 ExtraGame 的路径下）。
 * 两边各自记住上次选的游戏：鹰角是 app.game，其他厂商记在 localStorage。
 * 这个文件不引用任何桌面版专用的代码，网页版也用（EXTRA_VENDORS 是空的）。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { EXTRA_VENDORS, type ExtraGame, type ExtraVendor } from '@/platform'

export const HG_VENDOR = { id: 'hg', label: '鹰角', short: '鹰' } as const

const lastGameKey = (vendor: string) => `arkrecord:vendor:${vendor}:game`

function readLastGame(vendor: ExtraVendor): ExtraGame | undefined {
  try {
    const id = localStorage.getItem(lastGameKey(vendor.id))
    return vendor.games.find((g) => g.id === id)
  } catch {
    return undefined
  }
}

function rememberGame(vendor: ExtraVendor, game: ExtraGame): void {
  try {
    localStorage.setItem(lastGameKey(vendor.id), game.id)
  } catch {
    // 记不住也不影响使用
  }
}

/** 路径属于哪个其他厂商的哪个游戏；鹰角的页面返回 undefined */
export function extraGameOf(path: string): { vendor: ExtraVendor; game: ExtraGame } | undefined {
  for (const vendor of EXTRA_VENDORS) {
    const game = vendor.games.find((g) => path === g.to || path.startsWith(`${g.to}/`))
    if (game) return { vendor, game }
  }
  return undefined
}

export function useActiveVendor() {
  const route = useRoute()
  const router = useRouter()
  const extra = computed(() => extraGameOf(route.path))
  const vendorId = computed(() => extra.value?.vendor.id ?? HG_VENDOR.id)

  /** 进其他厂商的某个游戏，并记住它 */
  function openGame(vendor: ExtraVendor, game: ExtraGame) {
    rememberGame(vendor, game)
    if (extra.value?.game.id !== game.id) void router.push(game.to)
  }

  /** 切厂商：鹰角回到总览（app.game 还是上次的鹰角游戏）；其他厂商进上次看的游戏，没有就进第一个 */
  function openVendor(id: string) {
    if (id === vendorId.value) return
    if (id === HG_VENDOR.id) {
      void router.push('/')
      return
    }
    const vendor = EXTRA_VENDORS.find((v) => v.id === id)
    const game = vendor && (readLastGame(vendor) ?? vendor.games[0])
    if (vendor && game) openGame(vendor, game)
  }

  return { extra, vendorId, openGame, openVendor }
}
