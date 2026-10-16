import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { db } from '@/lib/db'
import { analyze, type PityModel } from '@/lib/stats/analyze'
import { normalizeArknights, normalizeEndfield } from '@/lib/stats/events'
import { arknightsGuarantees, endfieldGuarantees } from '@/lib/stats/guarantees'
import { computeInsights } from '@/lib/stats/insights'
import { arknightsRate, distribution, endfieldRate } from '@/lib/stats/pity'
import type { AkPull, EfPoolInfo, EfPull } from '@/lib/types'
import { useAppStore } from './app'

export const MODELS: Record<'arknights' | 'endfield' | 'endfieldWeapon', PityModel> = {
  arknights: { dist: distribution(arknightsRate), softPity: 50, hardPity: 99 },
  endfield: { dist: distribution(endfieldRate), softPity: 65, hardPity: 80 },
  // 终末地武器池：40 抽内必出 6★（见 research.md 2.3）；基础概率没有可靠来源，不建概率模型
  endfieldWeapon: { dist: null, softPity: 40, hardPity: 40 },
}

/** 终末地的角色池和武器池规则不同，分开查看；默认看角色 */
export type EfScope = 'char' | 'weapon'

/** 当前账号的记录与统计结果，所有页面共享，数据库变化时自动重新计算 */
export const useRecordsStore = defineStore('records', () => {
  const app = useAppStore()
  const accountId = computed(() => app.activeAccount?.id ?? '')

  const akPulls = useLiveQuery(
    () => (accountId.value.startsWith('arknights:') ? db.akPulls.where('accountId').equals(accountId.value).toArray() : []),
    [accountId],
    [] as AkPull[],
  )
  const efPulls = useLiveQuery(
    () => (accountId.value.startsWith('endfield:') ? db.efPulls.where('accountId').equals(accountId.value).toArray() : []),
    [accountId],
    [] as EfPull[],
  )
  const efPoolList = useLiveQuery(() => db.efPools.toArray(), [], [] as EfPoolInfo[])
  const efPools = computed(() => new Map(efPoolList.value.map((p) => [p.poolId, p])))

  const game = computed(() => app.activeAccount?.game ?? app.game)
  const efScope = ref<EfScope>('char')
  const weaponScope = computed(() => game.value === 'endfield' && efScope.value === 'weapon')
  const allEvents = computed(() =>
    game.value === 'arknights'
      ? normalizeArknights(akPulls.value, app.meta ?? { version: '', generatedAt: '', upAvailable: false, chars: {}, pools: {}, avatars: [] })
      : normalizeEndfield(efPulls.value, efPools.value, app.efMeta ?? undefined),
  )
  /** 当前查看范围内的记录：终末地只取角色或只取武器；武器视图里武器池就是“主模型” */
  const events = computed(() => {
    if (game.value !== 'endfield') return allEvents.value
    if (!weaponScope.value) return allEvents.value.filter((e) => !e.weapon)
    return allEvents.value.filter((e) => e.weapon).map((e) => ({ ...e, mainModel: true }))
  })
  const model = computed(() => (weaponScope.value ? MODELS.endfieldWeapon : MODELS[game.value]))
  const analysis = computed(() => analyze(events.value, model.value))
  const guarantees = computed(() =>
    game.value === 'arknights'
      ? app.meta
        ? arknightsGuarantees(analysis.value, app.meta)
        : []
      : endfieldGuarantees(analysis.value, efPools.value, app.efMeta ?? undefined),
  )

  /** 高级统计用的数据（计算较多，只有页面用到时才计算） */
  const insights = computed(() => computeInsights(events.value, analysis.value))

  return { game, efScope, weaponScope, events, model, analysis, guarantees, insights, efPools }
})
