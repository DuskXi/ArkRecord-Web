/**
 * 原神 / 星铁的读取状态和操作：每个游戏一份，两个游戏可以同时读取。
 *
 * 状态不放在读取面板（MhySyncPanel）里：切换原神 / 星铁时页面组件是复用的（只是 props 变了），放在面板里，
 * 进度、出错提示、等待读取和手动选的目录都会串到另一个游戏。放在这里（useMhyReader 全局只有一份），
 * 切走再切回来还能看到那个游戏的进度；读完或出错时不在那个游戏的页面上，也会弹提示。
 */
import { reactive, ref } from 'vue'
import { MHY_GAME_LABEL, type MhyGame } from '@/lib/mhy/types'
import {
  type MhyLinkSource,
  type MhyRpc,
  MhySyncError,
  type MhySyncProgress,
  type MhySyncResult,
  mhyCacheStamp,
  mhyLocate,
  syncMhy,
} from '@/lib/mhy/sync'
import { desktopBridge } from '@/lib/transport'
import { selectMhyAccount } from './accounts'

export interface MhyReadProblem {
  kind: string
  message: string
  /** 中途出错时已经保存的部分 */
  partial?: MhySyncResult
}

export interface MhyReadState {
  running: boolean
  progress: MhySyncProgress | null
  problem: MhyReadProblem | null
  /** 正在“等待读取” */
  waiting: boolean
  /** 手动选择的游戏目录（记在本机，不是敏感信息）；null 是自动查找 */
  dataDir: string | null
}

export interface MhyNotice {
  title: string
  description?: string
  color: 'success' | 'warning'
  icon: string
  duration?: number
}

type DirStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface MhyReaderDeps {
  rpc: MhyRpc
  /** 弹提示（界面里是 useToast） */
  notify: (notice: MhyNotice) => void
  /** 读到记录后选中这个账号 */
  select: (game: MhyGame, accountId: string) => void
  /** 测试时换掉；默认 syncMhy */
  sync?: typeof syncMhy
  /** 记手动选择的目录；默认 localStorage */
  storage?: DirStorage | null
}

const GAMES = Object.keys(MHY_GAME_LABEL) as MhyGame[]
const dirKey = (game: MhyGame) => `arkrecord:mhy:${game}:dataDir`

/** 原神叫“祈愿记录”，星铁叫“跃迁记录” */
export const mhyRecordName = (game: MhyGame) => (game === 'genshin' ? '祈愿记录' : '跃迁记录')

const WAIT_INTERVAL_MS = 3000
const WAIT_LIMIT_MS = 10 * 60_000
/** 缓存刚变时链接可能还没写完，稍等一下再读 */
const SETTLE_MS = 1500

function toProblem(error: unknown): MhyReadProblem {
  if (error instanceof MhySyncError) return { kind: error.kind, message: error.message, partial: error.partial }
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

function defaultStorage(): DirStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function createMhyReader(deps: MhyReaderDeps) {
  const sync = deps.sync ?? syncMhy
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage

  function readDir(game: MhyGame): string | null {
    try {
      return storage?.getItem(dirKey(game)) ?? null
    } catch {
      return null
    }
  }

  const states = reactive(
    Object.fromEntries(GAMES.map((game) => [game, { running: false, progress: null, problem: null, waiting: false, dataDir: readDir(game) }])),
  ) as Record<MhyGame, MhyReadState>
  /** 现在显示着哪个游戏的读取面板（面板挂载时设置） */
  const shown = ref<MhyGame | null>(null)

  /** 记下出了什么问题；不在那个游戏的页面上时再弹个提示 */
  function fail(game: MhyGame, problem: MhyReadProblem) {
    states[game].problem = problem
    if (shown.value !== game) {
      deps.notify({ title: `${MHY_GAME_LABEL[game]}没有读取完`, description: problem.message, color: 'warning', icon: 'i-lucide-triangle-alert', duration: 10_000 })
    }
  }

  function setDir(game: MhyGame, value: string | null) {
    states[game].dataDir = value
    try {
      if (value) storage?.setItem(dirKey(game), value)
      else storage?.removeItem(dirKey(game))
    } catch {
      // 存不了也不影响这次使用
    }
  }

  const cacheSource = (game: MhyGame): MhyLinkSource => {
    const dataDir = states[game].dataDir
    return { kind: 'cache', ...(dataDir ? { dataDir } : {}) }
  }

  async function run(game: MhyGame, source: MhyLinkSource): Promise<void> {
    const state = states[game]
    if (state.running) return
    const label = MHY_GAME_LABEL[game]
    state.running = true
    state.problem = null
    state.progress = { stage: '准备中', fetched: 0 }
    try {
      const result = await sync(deps.rpc, game, source, { onProgress: (p) => (state.progress = p) })
      deps.notify({
        title: result.added ? `同步完成，新增 ${result.added} 条记录` : '同步完成，没有新记录',
        description: result.account ? `${label} · UID ${result.account.uid}` : `${label}的这个账号还没有任何${mhyRecordName(game)}`,
        color: 'success',
        icon: 'i-lucide-circle-check',
      })
      if (result.warnings.length) {
        deps.notify({ title: '有些地方需要注意', description: `${label}：${result.warnings.join('；')}`, color: 'warning', icon: 'i-lucide-triangle-alert', duration: 10_000 })
      }
      if (result.account) deps.select(game, result.account.id)
    } catch (error) {
      const problem = toProblem(error)
      if (problem.partial?.account) deps.select(game, problem.partial.account.id)
      fail(game, problem)
    } finally {
      state.running = false
      state.progress = null
    }
  }

  /** 从游戏缓存读取：没有手动选过目录时先找目录，找不到就提示手动选择 */
  async function readFromCache(game: MhyGame): Promise<void> {
    const state = states[game]
    if (state.running) return
    stopWaiting(game)
    state.problem = null
    if (!state.dataDir) {
      try {
        const located = await mhyLocate(deps.rpc, game)
        if (!located.dataDirs.length) {
          fail(game, { kind: 'game_not_found', message: `没有找到${MHY_GAME_LABEL[game]}的游戏目录。` })
          return
        }
      } catch (error) {
        fail(game, toProblem(error))
        return
      }
    }
    await run(game, cacheSource(game))
  }

  async function pickDir(game: MhyGame): Promise<void> {
    if (states[game].running) return
    let picked: unknown
    try {
      picked = await deps.rpc('app.pickDirectory', { title: `选择${MHY_GAME_LABEL[game]}的游戏目录` })
    } catch {
      states[game].problem = { kind: 'unknown', message: '打不开选择目录的窗口' }
      return
    }
    const path = (picked as { path?: unknown } | null)?.path
    if (typeof path !== 'string') return
    setDir(game, path)
    await run(game, cacheSource(game))
  }

  /** 粘贴的链接：交给后端后就不再留着 */
  async function readUrl(game: MhyGame, url: string): Promise<void> {
    stopWaiting(game)
    await run(game, { kind: 'url', url })
  }

  // ───── 等待读取：在游戏里打开抽卡记录后，缓存的修改时间会变，变了就自动读取 ─────
  const timers = new Map<MhyGame, ReturnType<typeof setTimeout>>()
  /** 每次开始等待加一：停止后又马上开始时，旧的那轮不会接着跑 */
  const rounds = Object.fromEntries(GAMES.map((game) => [game, 0])) as Record<MhyGame, number>

  function stopWaiting(game: MhyGame) {
    states[game].waiting = false
    rounds[game]++
    clearTimeout(timers.get(game))
    timers.delete(game)
  }

  async function startWaiting(game: MhyGame): Promise<void> {
    const state = states[game]
    if (state.waiting || state.running) return
    state.problem = null
    state.waiting = true
    const round = ++rounds[game]
    const alive = () => state.waiting && rounds[game] === round
    const deadline = Date.now() + WAIT_LIMIT_MS
    let baseline: number | null
    try {
      baseline = await mhyCacheStamp(deps.rpc, game, state.dataDir ?? undefined)
    } catch (error) {
      if (!alive()) return
      stopWaiting(game)
      fail(game, toProblem(error))
      return
    }
    const tick = () => {
      timers.set(
        game,
        setTimeout(async () => {
          if (!alive()) return
          if (Date.now() > deadline) {
            stopWaiting(game)
            fail(game, { kind: 'wait_timeout', message: `等了 10 分钟，没有发现新的${mhyRecordName(game)}。` })
            return
          }
          const stamp = await mhyCacheStamp(deps.rpc, game, state.dataDir ?? undefined).catch(() => undefined)
          if (!alive()) return
          if (stamp != null && stamp !== baseline) {
            stopWaiting(game)
            await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
            await run(game, cacheSource(game))
            return
          }
          tick()
        }, WAIT_INTERVAL_MS),
      )
    }
    if (alive()) tick()
  }

  return { states, shown, setDir, readFromCache, pickDir, readUrl, startWaiting, stopWaiting }
}

export type MhyReader = ReturnType<typeof createMhyReader>

let shared: MhyReader | undefined

/** 界面用的那一份（第一次调用要在组件的 setup 里，用到 useToast） */
export function useMhyReader(): MhyReader {
  if (!shared) {
    const toast = useToast()
    const bridge = desktopBridge()
    shared = createMhyReader({
      rpc: (method, params) => (bridge ? bridge.rpc(method, params) : Promise.reject({ code: -32000, message: '只有桌面版能读取' })),
      notify: (notice) => toast.add(notice),
      select: selectMhyAccount,
    })
  }
  return shared
}
