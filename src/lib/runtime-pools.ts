/**
 * 明日方舟新卡池的 UP 名单：运行时从 PRTS 的卡池表补上（维护者 2026-11-03：“前端要有算法能够解析 PRTS 的新的卡池，
 * 不要全部都依赖于构建”）。
 *
 * 构建时的卡池数据（public/gamedata/ak-meta.json）只到部署那天；之后开放的卡池，记录里有、构建数据里没有 UP 名单。
 * 这时页面经本站的缓存转发（worker/gamedata.ts）取 PRTS 的卡池表，用和构建脚本同一份的解析代码（shared/ak-pools.js）
 * 取出 UP 名单和限定干员，补进内存里的卡池数据，统计（歪没歪、得到 UP）照常计算。
 *
 * - 只在需要时取：记录里出现了构建数据里没有 UP 名单、而这种卡池本该有 UP 的卡池（近期开放的限定、联动、单 / 双 UP、中坚等）；
 * - 解析结果存在这台设备上（IndexedDB 的 kv 表），之后打开直接用；还有没补上的卡池时，最多每 6 小时再取一次；
 * - PRTS 一直没有某个卡池（满 7 天）就不再为它取，免得反复下载；
 * - 取不到（离线、桌面版还没有这个地址）时照旧显示“UP 未知”，不影响别的功能。
 */
import { extractUpLists, inferRuleType, limitedChars, type UpLists } from '../../shared/ak-pools.js'
import type { AkMeta, AkPoolMeta } from './meta'

export const RUNTIME_POOLS_URL = '/api/gamedata/prts-gacha'
export const RUNTIME_POOLS_KEY = 'prts-ak-pools'
/** 还有没补上的卡池时，两次取卡池表至少间隔多久 */
export const REFRESH_MS = 6 * 3600_000
/** PRTS 一直没有某个卡池多久后放弃 */
export const GIVE_UP_MS = 7 * 86_400_000
/** 构建数据里有、但开放超过这么久的卡池不再补（例如以前的“联合行动”本来就没有 UP 名单） */
const RECENT_MS = 60 * 86_400_000
/**
 * 有 UP 名单的卡池类型（按构建数据统计：这几类的卡池都有 UP 名单，只有以前的“联合行动”标准池例外）。
 * 新手、回流、甄选、SPECIAL、ATTAIN 等本来就没有，不去取。
 */
const UP_TYPES: ReadonlySet<string> = new Set(['LIMITED', 'LINKAGE', 'SINGLE', 'DOUBLE', 'NORMAL', 'CLASSIC', 'CLASSIC_DOUBLE'])
const POOL_ID = /^[A-Z][A-Z0-9_]{0,63}$/

/** 存在这台设备上的解析结果 */
export interface RuntimePools {
  /** 上次取到卡池表的时间（毫秒） */
  fetchedAt: number
  /** 卡池表里全部卡池的 UP 名单 */
  ups: UpLists
  /** 限定干员 */
  lims: Record<string, string>
  /** 需要、但 PRTS 还没有的卡池，第一次发现没有的时间（毫秒） */
  missingSince: Record<string, number>
}

/** 记录里出现、构建数据里没有 UP 名单、而本该有 UP 的卡池 */
export function wantedPools(meta: AkMeta, poolIds: Iterable<string | null | undefined>, now: number): string[] {
  const out: string[] = []
  for (const id of new Set(poolIds)) {
    if (typeof id !== 'string' || !POOL_ID.test(id)) continue
    const pool = meta.pools[id]
    if (pool?.up) continue
    if (!UP_TYPES.has(pool?.t ?? inferRuleType(id))) continue
    if (pool && pool.o > 0 && now - pool.o * 1000 > RECENT_MS) continue
    out.push(id)
  }
  return out
}

/** 还要不要取卡池表：有没补上、也没放弃的卡池，并且离上次取已经够久 */
export function needsFetch(cache: RuntimePools | null, ids: readonly string[], now: number): boolean {
  const open = ids.filter((id) => {
    if (cache?.ups[id]) return false
    const since = cache?.missingSince[id]
    return since === undefined || now - since < GIVE_UP_MS
  })
  if (!open.length) return false
  return !cache || now - cache.fetchedAt >= REFRESH_MS
}

/** 解析取到的卡池表；记下这次需要、但 PRTS 还没有的卡池 */
export function parseTable(table: unknown, previous: RuntimePools | null, ids: readonly string[], now: number): RuntimePools {
  const ups = extractUpLists(table)
  const missingSince: Record<string, number> = {}
  for (const id of ids) if (!ups[id]) missingSince[id] = previous?.missingSince[id] ?? now
  return { fetchedAt: now, ups, lims: limitedChars(table), missingSince }
}

/** 把补上的 UP 名单合进卡池数据（返回新对象，不改原来的）；没有可补的时原样返回 */
export function applyRuntimePools(meta: AkMeta, cache: RuntimePools, ids: readonly string[]): AkMeta {
  let pools: Record<string, AkPoolMeta> | null = null
  for (const id of ids) {
    const up = cache.ups[id]
    if (!up) continue
    pools ??= { ...meta.pools }
    const base: AkPoolMeta = meta.pools[id] ?? { n: '', t: inferRuleType(id), o: 0, e: 0 }
    const lim = base.lim ?? cache.lims[id]
    pools[id] = { ...base, up, ...(lim ? { lim } : {}) }
  }
  return pools ? { ...meta, pools, upAvailable: true } : meta
}

const isMap = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x)

/** 读回存着的结果：格式不对时当作没有 */
export function readCache(value: unknown): RuntimePools | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<RuntimePools>
  if (typeof v.fetchedAt !== 'number' || !isMap(v.ups) || !isMap(v.lims) || !isMap(v.missingSince)) return null
  return v as RuntimePools
}

export interface RuntimePoolsDeps {
  fetch: typeof fetch
  load: () => Promise<unknown>
  save: (value: RuntimePools) => Promise<void>
  now?: () => number
}

/**
 * 按记录里出现的卡池补上 UP 名单。需要时取一次卡池表（经本站转发）；失败时用存着的结果，都没有就原样返回。
 */
export async function withRuntimePools(meta: AkMeta, poolIds: Iterable<string | null | undefined>, deps: RuntimePoolsDeps): Promise<AkMeta> {
  const now = deps.now?.() ?? Date.now()
  const ids = wantedPools(meta, poolIds, now)
  if (!ids.length) return meta
  let cache = readCache(await deps.load().catch(() => null))
  if (needsFetch(cache, ids, now)) {
    try {
      const res = await deps.fetch(RUNTIME_POOLS_URL, { headers: { 'x-arkrecord-client': '1' } })
      if (res.ok) {
        cache = parseTable(await res.json(), cache, ids, now)
        await deps.save(cache).catch(() => undefined)
      }
    } catch {
      // 离线、转发出错：下次打开再试
    }
  }
  return cache ? applyRuntimePools(meta, cache, ids) : meta
}
