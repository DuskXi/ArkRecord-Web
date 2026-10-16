/**
 * 把两个游戏的原始记录统一成同一种“寻访事件”，后续的统计逻辑只处理事件。
 * 保底分组规则见 docs/rewrite/research.md 1.8 与 2.3。
 */
import type { AkMeta } from '../meta'
import type { AkPull, EfPoolInfo, EfPull } from '../types'

export interface PullEvent {
  key: string
  ts: number
  /** 同一时间内的顺序（十连内的位置） */
  order: number
  /** 星级 3–6 */
  star: number
  itemId: string | null
  name: string
  poolId: string | null
  poolName: string
  /** 卡池规则类型（明日方舟 gachaRuleType / 终末地卡池类型） */
  ruleType: string
  /** 保底计数分组：共享计数的卡池使用同一个分组 id */
  family: string
  familyLabel: string
  /** 该分组的计数是否在卡池结束时清零 */
  isolated: boolean
  /** 是否适用主保底模型（用于运气百分位） */
  mainModel: boolean
  isNew: boolean
  /** 是否计入保底（终末地的免费十连、赠送条目不计入） */
  countsForPity: boolean
  /** 6★ 是否为当期 UP；UP 名单未知时为 null */
  isUp: boolean | null
  weapon: boolean
}

// ───────────────────────── 明日方舟 ─────────────────────────

const STANDARD_RULES = new Set(['NORMAL', 'SINGLE', 'DOUBLE', 'SPECIAL'])
const KERNEL_RULES = new Set(['CLASSIC', 'CLASSIC_DOUBLE', 'FESCLASSIC'])

export function akRuleType(poolId: string | null, poolName: string, meta: AkMeta): string {
  if (poolId) {
    const known = meta.pools[poolId]
    if (known) return known.t
    if (poolId.startsWith('BOOT')) return 'BOOT'
    if (poolId.startsWith('CLASSIC_ATTAIN')) return 'CLASSIC_ATTAIN'
    if (poolId.startsWith('CLASSIC_DOUBLE')) return 'CLASSIC_DOUBLE'
    const prefix = poolId.split('_')[0] ?? ''
    if (prefix === 'NORM') return 'NORMAL'
    return prefix
  }
  // 旧版数据只有卡池名
  if (poolName.includes('中坚')) return 'CLASSIC'
  if (poolName.includes('标准')) return 'NORMAL'
  return 'UNKNOWN'
}

export function akFamily(ruleType: string, poolId: string | null, poolName: string): {
  family: string
  label: string
  isolated: boolean
} {
  if (STANDARD_RULES.has(ruleType)) return { family: 'standard', label: '标准寻访', isolated: false }
  if (KERNEL_RULES.has(ruleType)) return { family: 'kernel', label: '中坚寻访', isolated: false }
  return { family: `pool:${poolId ?? poolName}`, label: poolName, isolated: true }
}

export function normalizeArknights(pulls: AkPull[], meta: AkMeta): PullEvent[] {
  return pulls
    .map((p) => {
      const ruleType = akRuleType(p.poolId, p.poolName, meta)
      const { family, label, isolated } = akFamily(ruleType, p.poolId, p.poolName)
      const star = p.rarity + 1
      const up6 = p.poolId ? meta.pools[p.poolId]?.up?.['6'] : undefined
      return {
        key: p.key,
        ts: p.gachaTs,
        order: p.pos,
        star,
        itemId: p.charId,
        name: p.charName,
        poolId: p.poolId,
        poolName: (p.poolId && meta.pools[p.poolId]?.n) || p.poolName,
        ruleType,
        family,
        familyLabel: label,
        isolated,
        mainModel: true,
        isNew: p.isNew,
        countsForPity: true,
        isUp: star === 6 && up6 && p.charId ? up6.includes(p.charId) : null,
        weapon: false,
      } satisfies PullEvent
    })
    .toSorted(byTime)
}

// ───────────────────────── 终末地 ─────────────────────────

export function efCharFamily(poolType: string, poolId: string): { family: string; label: string; isolated: boolean; main: boolean } {
  const type = poolType.replace('E_CharacterGachaPoolType_', '').toLowerCase()
  if (type === 'special' || poolId.startsWith('special')) return { family: 'ef:special', label: '特许寻访', isolated: false, main: true }
  if (type === 'rerun' || poolId.startsWith('rerun')) return { family: 'ef:rerun', label: '重构寻访', isolated: false, main: true }
  if (type === 'standard' || poolId === 'standard') return { family: 'ef:standard', label: '基础寻访', isolated: false, main: true }
  if (type === 'beginner' || poolId === 'beginner') return { family: 'ef:beginner', label: '启程寻访', isolated: false, main: false }
  return { family: `ef:pool:${poolId}`, label: poolType, isolated: true, main: false }
}

export function normalizeEndfield(pulls: EfPull[], pools: Map<string, EfPoolInfo>): PullEvent[] {
  return pulls
    .map((p) => {
      const info = pools.get(p.poolId)
      const weapon = p.type === 'weapon'
      const fam = weapon
        ? { family: `ef:weapon:${p.poolId}`, label: p.poolName, isolated: true, main: false }
        : efCharFamily(p.poolType, p.poolId)
      const up6 = info?.up6Name
      return {
        key: p.key,
        ts: p.gachaTs,
        order: Number(p.seqId) || 0,
        star: p.rarity,
        itemId: p.itemId || null,
        name: p.itemName,
        poolId: p.poolId,
        poolName: p.poolName,
        ruleType: weapon ? `weapon:${p.poolType}` : p.poolType,
        family: fam.family,
        familyLabel: fam.label,
        isolated: fam.isolated,
        mainModel: fam.main,
        isNew: p.isNew,
        countsForPity: p.kind === 'draw' && !p.isFree,
        isUp: p.rarity === 6 && up6 ? p.itemName === up6 : null,
        weapon,
      } satisfies PullEvent
    })
    .filter((e) => e.countsForPity || !e.weapon)
    .toSorted(byTime)
}

function byTime(a: PullEvent, b: PullEvent): number {
  return a.ts - b.ts || a.order - b.order
}
