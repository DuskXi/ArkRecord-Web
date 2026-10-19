/**
 * 接口的一条记录 → MhyPull，以及同一条记录有多个版本时保留哪个（和 merge.ts 的规则一致：与顺序无关）。
 */
import { fieldCount, pickBetter } from '../merge'
import { toTimestamp } from './time'
import { type MhyGame, type MhyPull, poolOf } from './types'

const ID_RE = /^\d{1,24}$/
const RANK_RE = /^[1-5]$/

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * 校验并转换一条接口记录；缺了主键、星级、时间这些必需的字段时返回 null（调用方计入“跳过”）。
 * utcOffset：区服的 UTC 偏移（小时）。
 */
export function toMhyPull(game: MhyGame, accountId: string, raw: unknown, utcOffset: number): MhyPull | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const gachaType = str(r.gacha_type)
  const rank = str(r.rank_type)
  const time = str(r.time)
  if (!id || !ID_RE.test(id) || !gachaType || !rank || !RANK_RE.test(rank) || !time) return null
  const ts = toTimestamp(time, utcOffset)
  if (!Number.isFinite(ts)) return null
  const count = Number(str(r.count) ?? '1')
  const pull: MhyPull = {
    accountId,
    id,
    gachaType,
    pool: poolOf(game, gachaType),
    itemId: str(r.item_id) ?? '',
    name: str(r.name) ?? '',
    itemType: str(r.item_type) ?? '',
    rank: Number(rank),
    count: Number.isSafeInteger(count) && count > 0 ? count : 1,
    time,
    ts,
    lang: str(r.lang) ?? '',
    source: 'api',
  }
  const opGachaType = str(r.op_gacha_type)
  if (opGachaType) pull.opGachaType = opGachaType
  const gachaId = str(r.gacha_id)
  if (gachaId) pull.gachaId = gachaId
  return pull
}

const SOURCE_RANK: Record<MhyPull['source'], number> = { api: 1, import: 0 }
export const mhyPullRank = (p: MhyPull) => [SOURCE_RANK[p.source] ?? -1, fieldCount(p)] as const
/** 接口 > 导入 → 字段更全的 → 规范编码更小的 */
export const pickMhyPull = (a: MhyPull, b: MhyPull) => pickBetter(a, b, mhyPullRank)
