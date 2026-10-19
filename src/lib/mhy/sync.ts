/**
 * 原神、星铁的增量同步：读取（或粘贴）抽卡链接 → 后端校验 → 每个卡池从新到旧翻页，遇到本地已有的记录就停。
 *
 * - 请求全部由本机的 Python 后端直连米哈游官方接口（mhy.* 方法，见 desktop/README.md），抽卡链接和 authkey
 *   只留在后端，这里拿到的是随机句柄；同步结束（包括出错）时让后端丢掉句柄。
 * - rpc 由调用方注入（界面里是 desktopBridge().rpc，测试里是假的后端）。
 * - 只保存拉完的卡池：一个卡池中途出错时整池不存，下次再从最新的拉起，不会留下“中间缺一段”的记录。
 */
import { dedupeBy, planWrites } from '../merge'
import { mhyDb, type MhyDB } from './db'
import { pickMhyPull, toMhyPull } from './record'
import { offsetFor, parseTimeZone, regionOffset } from './time'
import { MHY_GAME_LABEL, MHY_POOLS, type MhyAccount, type MhyGame, type MhyPoolInfo, type MhyPull, mhyAccountId } from './types'

/** 调用后端的方法；失败时 reject 一个 {code, message, data: {kind}}（见 src/lib/transport.ts 的 RpcErrorObject） */
export type MhyRpc = (method: string, params?: unknown) => Promise<unknown>

/** 抽卡链接从哪里来：游戏的网页缓存（可以手动指定游戏目录），或者用户粘贴的链接 */
export type MhyLinkSource = { kind: 'cache'; dataDir?: string } | { kind: 'url'; url: string }

export interface MhySyncProgress {
  stage: string
  detail?: string
  /** 到目前为止读到的新记录条数 */
  fetched: number
}

export interface MhyPoolResult {
  type: string
  name: string
  /** 这次读到的新记录 */
  fetched: number
  /** 拉完了（出错时为 false，这个卡池这次没有保存） */
  complete: boolean
}

export interface MhySyncResult {
  /** 没有任何记录、取不到 UID 时为 null */
  account: MhyAccount | null
  /** 新增的条数 */
  added: number
  /** 这次读到、写入前的条数 */
  fetched: number
  /** 格式不对、跳过的条数 */
  skipped: number
  pools: MhyPoolResult[]
  warnings: string[]
}

export class MhySyncError extends Error {
  readonly kind: string
  /** 出错前已经拉完、已经保存的部分 */
  readonly partial?: MhySyncResult

  constructor(kind: string, message: string, partial?: MhySyncResult) {
    super(message)
    this.name = 'MhySyncError'
    this.kind = kind
    this.partial = partial
  }
}

const PAGE_SIZE = 20
/** 每个卡池最多翻这么多页（2 万条），防止接口异常时无限翻页 */
const MAX_PAGES = 1000

/** 调用后端；后端的错误转成 MhySyncError（message 是后端给用户看的说明，不含凭据） */
async function call(rpc: MhyRpc, method: string, params: unknown): Promise<unknown> {
  try {
    return await rpc(method, params)
  } catch (error) {
    const e = error as { message?: unknown; data?: { kind?: unknown } } | undefined
    const kind = typeof e?.data?.kind === 'string' ? e.data.kind : 'backend'
    const message = typeof e?.message === 'string' && e.message ? e.message : '本机后端出错了'
    throw new MhySyncError(kind, message)
  }
}

interface LinkInfo {
  handle: string
  game: MhyGame
  gameBiz: string
  region: string
  uid: string | null
}

function parseLink(value: unknown): LinkInfo {
  const v = (value ?? {}) as Record<string, unknown>
  if (typeof v.handle !== 'string' || (v.game !== 'genshin' && v.game !== 'starrail') || typeof v.gameBiz !== 'string') {
    throw new MhySyncError('backend', '本机后端返回的内容不对')
  }
  return {
    handle: v.handle,
    game: v.game,
    gameBiz: v.gameBiz,
    region: typeof v.region === 'string' ? v.region : '',
    uid: typeof v.uid === 'string' && /^\d{1,12}$/.test(v.uid) ? v.uid : null,
  }
}

function parsePage(value: unknown): { list: unknown[]; timeZone?: number } {
  const v = (value ?? {}) as Record<string, unknown>
  if (!Array.isArray(v.list)) throw new MhySyncError('backend', '本机后端返回的内容不对')
  return { list: v.list, timeZone: parseTimeZone(v.regionTimeZone) }
}

const idOf = (raw: unknown): string | undefined => {
  const id = (raw as { id?: unknown } | null)?.id
  return typeof id === 'string' && /^\d{1,24}$/.test(id) ? id : undefined
}

const uidOf = (raw: unknown): string | undefined => {
  const uid = (raw as { uid?: unknown } | null)?.uid
  return typeof uid === 'string' && /^\d{1,12}$/.test(uid) ? uid : undefined
}

/**
 * 同步一个游戏账号的抽卡记录。full：不在已有记录处停下，全部重新拉一遍（记录按规则合并，不会重复）。
 * 读取链接这一步出错时直接抛出；拉记录中途出错时，先保存已经拉完的卡池，再抛出带 partial 的 MhySyncError。
 */
export async function syncMhy(
  rpc: MhyRpc,
  game: MhyGame,
  source: MhyLinkSource,
  options: { full?: boolean; onProgress?: (p: MhySyncProgress) => void; db?: MhyDB; now?: () => number } = {},
): Promise<MhySyncResult> {
  const db = options.db ?? mhyDb
  const now = options.now ?? Date.now
  let fetchedCount = 0
  const report = (stage: string, detail?: string) => options.onProgress?.({ stage, detail, fetched: fetchedCount })

  report(source.kind === 'cache' ? '正在从游戏缓存里读取抽卡链接' : '正在校验抽卡链接')
  const link =
    source.kind === 'cache'
      ? parseLink(await call(rpc, 'mhy.readCache', { game, ...(source.dataDir ? { dataDir: source.dataDir } : {}) }))
      : parseLink(await call(rpc, 'mhy.useLink', { url: source.url }))

  if (link.game !== game) {
    await rpc('mhy.forget', { handle: link.handle }).catch(() => undefined)
    throw new MhySyncError('wrong_game', `这是${MHY_GAME_LABEL[link.game]}的抽卡链接，不是${MHY_GAME_LABEL[game]}的`)
  }

  const warnings: string[] = []
  const pools: MhyPoolResult[] = []
  const collected: { pool: MhyPoolInfo; raws: unknown[] }[] = []
  let uid = link.uid
  let offset = offsetFor(link.region)
  let known: Set<string> | undefined
  let failure: MhySyncError | undefined

  try {
    if (regionOffset(link.region) === undefined) warnings.push(`不认识的区服（${link.region || '空'}），时间按 UTC+8 换算`)

    for (const pool of MHY_POOLS[game]) {
      const raws: unknown[] = []
      let endId = '0'
      let pages = 0
      let done = false
      try {
        while (!done) {
          if (++pages > MAX_PAGES) throw new MhySyncError('too_many_pages', `${pool.name}的记录页数异常，已停止`)
          report(`正在读取${pool.name}`, `第 ${pages} 页`)
          const page = parsePage(await call(rpc, 'mhy.fetchPage', { handle: link.handle, gachaType: pool.type, endId }))
          if (page.timeZone !== undefined) offset = page.timeZone
          let last: string | undefined
          for (const raw of page.list) {
            const id = idOf(raw)
            if (!uid) uid = uidOf(raw) ?? null
            if (uid && !known) {
              known = options.full ? new Set() : await knownIds(db, mhyAccountId(game, uid))
            }
            if (id && known?.has(id)) {
              done = true
              break
            }
            raws.push(raw)
            fetchedCount++
            if (id) last = id
          }
          if (done || page.list.length < PAGE_SIZE) break
          // 下一页从这一页最后一条之后开始；id 必须一路变小，否则接口异常，停下来以免无限翻页
          if (!last || (endId !== '0' && BigInt(last) >= BigInt(endId))) {
            throw new MhySyncError('bad_page', `${pool.name}的记录顺序异常，已停止`)
          }
          endId = last
        }
        collected.push({ pool, raws })
        pools.push({ type: pool.type, name: pool.name, fetched: raws.length, complete: true })
      } catch (error) {
        pools.push({ type: pool.type, name: pool.name, fetched: raws.length, complete: false })
        throw error
      }
    }
  } catch (error) {
    failure = error instanceof MhySyncError ? error : new MhySyncError('unknown', String(error))
  } finally {
    // 不管成功与否，都让后端丢掉这个链接
    await rpc('mhy.forget', { handle: link.handle }).catch(() => undefined)
  }

  const result = await save(db, game, link, uid, offset, collected, pools, warnings, now(), !failure)
  if (failure) throw new MhySyncError(failure.kind, failure.message, result)
  return result
}

async function knownIds(db: MhyDB, accountId: string): Promise<Set<string>> {
  const keys = await db.pulls.where('accountId').equals(accountId).primaryKeys()
  return new Set(keys.map((k) => k[1]))
}

async function save(
  db: MhyDB,
  game: MhyGame,
  link: LinkInfo,
  uid: string | null,
  offset: number,
  collected: { pool: MhyPoolInfo; raws: unknown[] }[],
  pools: MhyPoolResult[],
  warnings: string[],
  at: number,
  complete: boolean,
): Promise<MhySyncResult> {
  const fetched = collected.reduce((n, c) => n + c.raws.length, 0)
  if (!uid) {
    if (complete) warnings.push('这个账号还没有任何抽卡记录')
    return { account: null, added: 0, fetched, skipped: 0, pools, warnings }
  }
  const accountId = mhyAccountId(game, uid)
  // 出错、又没有拉完任何有记录的卡池：什么都不写（不建空账号）
  if (!complete && fetched === 0) {
    return { account: (await db.accounts.get(accountId)) ?? null, added: 0, fetched, skipped: 0, pools, warnings }
  }
  const pulls: MhyPull[] = []
  let skipped = 0
  let otherUid = 0
  for (const { raws } of collected) {
    for (const raw of raws) {
      const rawUid = uidOf(raw)
      if (rawUid && rawUid !== uid) {
        otherUid++
        continue
      }
      const pull = toMhyPull(game, accountId, raw, offset)
      if (pull) pulls.push(pull)
      else skipped++
    }
  }
  if (skipped) warnings.push(`有 ${skipped} 条记录格式不对，已跳过`)
  if (otherUid) warnings.push(`有 ${otherUid} 条记录属于别的 UID，已跳过`)

  let added = 0
  const account = await db.transaction('rw', db.accounts, db.pulls, async () => {
    const existing = await db.accounts.get(accountId)
    const next: MhyAccount = {
      id: accountId,
      game,
      uid,
      region: link.region || existing?.region || '',
      gameBiz: link.gameBiz,
      utcOffset: offset,
      createdAt: existing?.createdAt ?? at,
      ...(complete ? { lastSyncAt: at } : existing?.lastSyncAt ? { lastSyncAt: existing.lastSyncAt } : {}),
    }
    await db.accounts.put(next)
    const incoming = dedupeBy(pulls, (p) => p.id, pickMhyPull)
    const current = await db.pulls.bulkGet(incoming.map((p) => [p.accountId, p.id] as [string, string]))
    const plan = planWrites(incoming, current, pickMhyPull)
    await db.pulls.bulkPut(plan.writes)
    added = plan.added
    return next
  })
  return { account, added, fetched, skipped, pools, warnings }
}

// ───────────── 给界面用的小工具 ─────────────

export interface MhyLocateResult {
  /** 找到的游戏数据目录（含 webCaches 的 *_Data 目录） */
  dataDirs: { path: string; versions: string[] }[]
  /** 找到的日志 */
  logs: string[]
}

/** 找游戏目录（读日志，不读缓存、不发请求） */
export async function mhyLocate(rpc: MhyRpc, game: MhyGame): Promise<MhyLocateResult> {
  const v = ((await call(rpc, 'mhy.locate', { game })) ?? {}) as Record<string, unknown>
  const dataDirs = Array.isArray(v.dataDirs)
    ? v.dataDirs
        .filter((d): d is { path: string; versions?: unknown } => typeof (d as { path?: unknown })?.path === 'string')
        .map((d) => ({ path: d.path, versions: Array.isArray(d.versions) ? d.versions.filter((x): x is string => typeof x === 'string') : [] }))
    : []
  const logs = Array.isArray(v.logs) ? v.logs.filter((x): x is string => typeof x === 'string') : []
  return { dataDirs, logs }
}

/** 最新的网页缓存修改时间（秒）。“等待读取”时轮询，变了再同步；没有缓存时为 null */
export async function mhyCacheStamp(rpc: MhyRpc, game: MhyGame, dataDir?: string): Promise<number | null> {
  const v = ((await call(rpc, 'mhy.cacheStamp', { game, ...(dataDir ? { dataDir } : {}) })) ?? {}) as Record<string, unknown>
  return typeof v.mtime === 'number' && Number.isFinite(v.mtime) ? v.mtime : null
}
