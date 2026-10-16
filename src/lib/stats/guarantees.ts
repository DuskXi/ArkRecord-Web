/** 定向保底与累计奖励的进度（只显示仍在开放 / 近期有活动的卡池） */
import type { AkMeta, EfMeta } from '../meta'
import type { EfPoolInfo } from '../types'
import type { Analysis, PoolSummary } from './analyze'

export interface Guarantee {
  poolName: string
  label: string
  current: number
  target: number
  done: boolean
}

const RECENT_MS = 21 * 24 * 3600 * 1000

function upCount(pool: PoolSummary): number {
  return pool.sixStars.filter((h) => h.event.isUp).length
}

/** 自上一个 UP 之后在该池内抽了多少（循环保底用） */
function sinceLastUp(pool: PoolSummary): number {
  const lastUp = pool.sixStars.findLast((h) => h.event.isUp)
  return lastUp ? pool.paid - lastUp.poolPull : pool.paid
}

export function arknightsGuarantees(analysis: Analysis, meta: AkMeta, now = Date.now()): Guarantee[] {
  const out: Guarantee[] = []
  for (const pool of analysis.pools) {
    const pm = pool.poolId ? meta.pools[pool.poolId] : undefined
    if (!pm || now / 1000 > pm.e) continue
    const ups = upCount(pool)
    switch (pm.t) {
      case 'SINGLE':
        out.push({ poolName: pool.poolName, label: '150 抽必得 UP 干员', current: pool.paid, target: 150, done: ups >= 1 })
        break
      case 'DOUBLE':
      case 'CLASSIC_DOUBLE':
        out.push({ poolName: pool.poolName, label: '150 抽必得一名 UP 干员', current: pool.paid, target: 150, done: ups >= 1 })
        out.push({ poolName: pool.poolName, label: '300 抽必得另一名 UP 干员', current: pool.paid, target: 300, done: ups >= 2 })
        break
      case 'LINKAGE': {
        const target = pm.loop6 ?? pm.g6
        if (target) {
          out.push({
            poolName: pool.poolName,
            label: pm.loop6 ? `每 ${target} 抽必得联动干员` : `${target} 抽内必得联动干员`,
            current: pm.loop6 ? sinceLastUp(pool) : pool.paid,
            target,
            done: !pm.loop6 && ups >= 1,
          })
        }
        break
      }
      case 'LIMITED':
        if (pm.free) {
          out.push({ poolName: pool.poolName, label: `累计 ${pm.free} 抽赠送限定干员`, current: pool.paid, target: pm.free, done: pool.paid >= pm.free })
        }
        break
    }
  }
  return out
}

export function endfieldGuarantees(analysis: Analysis, pools: Map<string, EfPoolInfo>, meta?: EfMeta, now = Date.now()): Guarantee[] {
  const out: Guarantee[] = []
  for (const pool of analysis.pools) {
    if (!pool.poolId || now - pool.lastTs > RECENT_MS) continue
    const info = pools.get(pool.poolId)
    if (pool.weapon) {
      out.push({ poolName: pool.poolName, label: '80 抽必得 UP 武器', current: pool.paid, target: 80, done: upCount(pool) >= 1 })
    } else if ((meta?.pools[pool.poolId]?.t ?? info?.poolType) === 'special' || (!meta?.pools[pool.poolId] && pool.poolId.startsWith('special'))) {
      out.push({ poolName: pool.poolName, label: '120 抽必得当期 UP（不继承）', current: pool.paid, target: 120, done: upCount(pool) >= 1 })
    }
  }
  return out
}
