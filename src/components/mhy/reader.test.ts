import { afterEach, describe, expect, it, vi } from 'vitest'
import { MhySyncError, type MhySyncProgress, type MhySyncResult, type syncMhy } from '@/lib/mhy/sync'
import { type MhyAccount, type MhyGame, MHY_GAME_LABEL } from '@/lib/mhy/types'
import { createMhyReader, type MhyNotice } from './reader'

type SyncArgs = Parameters<typeof syncMhy>

/** 假的同步：每次调用留下一个可以手动结束的读取 */
function fakeSync() {
  const calls: { game: MhyGame; source: SyncArgs[2]; progress: (p: MhySyncProgress) => void; resolve: (r: MhySyncResult) => void; reject: (e: unknown) => void }[] = []
  const sync = ((_rpc, game, source, options) =>
    new Promise<MhySyncResult>((resolve, reject) => {
      calls.push({ game, source, progress: (p) => options?.onProgress?.(p), resolve, reject })
    })) as typeof syncMhy
  return { sync, calls }
}

const result = (game: MhyGame, uid: string, added = 1): MhySyncResult => ({
  account: { id: `${game}:${uid}`, uid } as MhyAccount,
  added,
  fetched: added,
  skipped: 0,
  pools: [],
  warnings: [],
})

function setup(stamps: Partial<Record<MhyGame, number>> = {}) {
  const { sync, calls } = fakeSync()
  const notices: MhyNotice[] = []
  const selected: [MhyGame, string][] = []
  const rpcCalls: [string, unknown][] = []
  const rpc = async (method: string, params?: unknown) => {
    rpcCalls.push([method, params])
    if (method === 'mhy.locate') return { dataDirs: [{ path: 'D:/game' }] }
    if (method === 'mhy.cacheStamp') return { mtime: stamps[(params as { game: MhyGame }).game] ?? 1 }
    throw new Error(`没有 ${method}`)
  }
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
  const reader = createMhyReader({ rpc, notify: (n) => notices.push(n), select: (g, id) => selected.push([g, id]), sync, storage })
  return { reader, calls, notices, selected, rpcCalls, store }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('createMhyReader', () => {
  it('两个游戏可以同时读取，进度和结果互不影响', async () => {
    const { reader, calls, selected, notices } = setup()
    reader.shown.value = 'genshin'
    const genshin = reader.readFromCache('genshin')
    await flush()
    reader.shown.value = 'starrail'
    const starrail = reader.readFromCache('starrail')
    await flush()

    expect(calls.map((c) => c.game)).toEqual(['genshin', 'starrail'])
    expect(reader.states.genshin.running).toBe(true)
    expect(reader.states.starrail.running).toBe(true)

    calls[0]!.progress({ stage: '正在读取', detail: '角色活动祈愿', fetched: 40 })
    expect(reader.states.genshin.progress?.fetched).toBe(40)
    expect(reader.states.starrail.progress).toEqual({ stage: '准备中', fetched: 0 })

    calls[1]!.resolve(result('starrail', '200'))
    await starrail
    expect(reader.states.starrail.running).toBe(false)
    expect(reader.states.genshin.running).toBe(true)

    calls[0]!.resolve(result('genshin', '100'))
    await genshin
    expect(reader.states.genshin.running).toBe(false)
    expect(selected).toEqual([
      ['starrail', 'starrail:200'],
      ['genshin', 'genshin:100'],
    ])
    expect(notices.map((n) => n.description)).toEqual([`${MHY_GAME_LABEL.starrail} · UID 200`, `${MHY_GAME_LABEL.genshin} · UID 100`])
  })

  it('同一个游戏读取中再点读取不会再读一次', async () => {
    const { reader, calls } = setup()
    void reader.readFromCache('genshin')
    await flush()
    await reader.readFromCache('genshin')
    expect(calls).toHaveLength(1)
  })

  it('出错只记在那个游戏上；不在那个游戏的页面时才弹提示', async () => {
    const { reader, calls, notices } = setup()
    reader.shown.value = 'genshin'
    const genshin = reader.readFromCache('genshin')
    await flush()
    calls[0]!.reject(new MhySyncError('link_expired', '抽卡链接已过期'))
    await genshin
    expect(reader.states.genshin.problem?.kind).toBe('link_expired')
    expect(reader.states.starrail.problem).toBeNull()
    expect(notices).toEqual([])

    const starrail = reader.readFromCache('starrail')
    await flush()
    calls[1]!.reject(new MhySyncError('cache_locked', '游戏正在使用缓存文件'))
    await starrail
    expect(reader.states.starrail.problem?.kind).toBe('cache_locked')
    expect(notices.map((n) => n.title)).toEqual([`${MHY_GAME_LABEL.starrail}没有读取完`])
  })

  it('中途出错时也选中已经保存的账号', async () => {
    const { reader, calls, selected } = setup()
    const run = reader.readFromCache('starrail')
    await flush()
    calls[0]!.reject(new MhySyncError('network', '连不上', result('starrail', '200')))
    await run
    expect(selected).toEqual([['starrail', 'starrail:200']])
    expect(reader.states.starrail.problem?.partial?.added).toBe(1)
  })

  it('手动选择的目录按游戏分开记', async () => {
    const { reader, calls, rpcCalls, store } = setup()
    reader.setDir('genshin', 'D:/Genshin Impact')
    expect(reader.states.starrail.dataDir).toBeNull()
    expect(store.get('arkrecord:mhy:genshin:dataDir')).toBe('D:/Genshin Impact')

    void reader.readFromCache('genshin')
    void reader.readFromCache('starrail')
    await flush()
    expect(calls.map((c) => c.source)).toEqual([{ kind: 'cache', dataDir: 'D:/Genshin Impact' }, { kind: 'cache' }])
    // 选过目录的不再找目录
    expect(rpcCalls.filter(([m]) => m === 'mhy.locate').map(([, p]) => p)).toEqual([{ game: 'starrail' }])

    reader.setDir('genshin', null)
    expect(store.has('arkrecord:mhy:genshin:dataDir')).toBe(false)
  })

  it('等待读取按游戏分开：只有缓存变了的那个游戏会读取', async () => {
    vi.useFakeTimers()
    const stamps: Partial<Record<MhyGame, number>> = { genshin: 1, starrail: 1 }
    const { reader, calls } = setup(stamps)
    await reader.startWaiting('genshin')
    await reader.startWaiting('starrail')
    expect(reader.states.genshin.waiting).toBe(true)
    expect(reader.states.starrail.waiting).toBe(true)

    stamps.starrail = 2
    await vi.advanceTimersByTimeAsync(3000 + 1500)
    expect(calls.map((c) => c.game)).toEqual(['starrail'])
    expect(reader.states.starrail.waiting).toBe(false)
    expect(reader.states.genshin.waiting).toBe(true)

    reader.stopWaiting('genshin')
    stamps.genshin = 2
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.map((c) => c.game)).toEqual(['starrail'])
  })

  it('停止后马上重新等待，旧的那轮不会接着跑', async () => {
    vi.useFakeTimers()
    const stamps: Partial<Record<MhyGame, number>> = { genshin: 1 }
    const { reader, rpcCalls } = setup(stamps)
    await reader.startWaiting('genshin')
    reader.stopWaiting('genshin')
    await reader.startWaiting('genshin')
    const before = rpcCalls.length
    await vi.advanceTimersByTimeAsync(3000)
    // 每 3 秒只查一次缓存的修改时间
    expect(rpcCalls.length - before).toBe(1)
  })
})
