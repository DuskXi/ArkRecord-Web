/**
 * 米哈游的记录 → 统一的“寻访事件”（src/lib/stats/events.ts），这样鹰角两款的统计引擎和页面可以直接用。
 *
 * 保底分组（同一组连续计数，跨期不清零）：原神角色活动（301 和 400 共用）、武器活动、常驻、集录各自一组；
 * 星铁角色活动、光锥活动、常驻、两个联动各自一组；新手池各自一组。
 * 武器（原神武器活动、星铁光锥 / 联动光锥）标成 weapon，和终末地一样分“角色 / 武器”两个范围看。
 * 角色、武器、光锥活动池的 5★ 按官方的大小保底规则判断歪没歪（up.ts）；其余卡池 isUp 为 null。
 */
import type { PullEvent } from '../stats/events'
import { compareMhyPulls } from './stats'
import { MHY_POOLS, type MhyGame, type MhyPull } from './types'
import { assignUp } from './up'

/** 武器 / 光锥的卡池组 */
const WEAPON_GROUPS = new Set(['weapon', 'lightcone', 'collab-lightcone'])
/** 用官方数字建了保底模型的卡池组（见 models.ts）；其余（新手、联动）不参与运气、期望 */
const MODELED_GROUPS = new Set(['character', 'standard', 'chronicled', 'weapon', 'lightcone'])

export function isWeaponGroup(group: string): boolean {
  return WEAPON_GROUPS.has(group)
}

export function normalizeMhy(game: MhyGame, pulls: readonly MhyPull[]): PullEvent[] {
  const pools = new Map(MHY_POOLS[game].map((p) => [p.type, p]))
  const sorted = pulls.toSorted(compareMhyPulls)
  const items: { event: PullEvent; pull: MhyPull; group: string }[] = []
  let lastTs = Number.NaN
  let order = 0
  for (const p of sorted) {
    const pool = pools.get(p.pool)
    if (!pool) continue
    order = p.ts === lastTs ? order + 1 : 0
    lastTs = p.ts
    const event: PullEvent = {
      key: p.id,
      ts: p.ts,
      order,
      star: p.rank,
      itemId: p.itemId || null,
      name: p.name,
      // 星铁每期卡池有 gacha_id；原神没有，按卡池类型
      poolId: p.gachaId ?? p.pool,
      poolName: pool.name,
      ruleType: p.pool,
      family: `${game}:${pool.group}`,
      familyLabel: pool.name,
      isolated: false,
      mainModel: MODELED_GROUPS.has(pool.group),
      isNew: false,
      countsForPity: true,
      isUp: null,
      weapon: WEAPON_GROUPS.has(pool.group),
    }
    items.push({ event, pull: p, group: pool.group })
  }
  assignUp(game, items)
  return items.map((x) => x.event)
}
