import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { db } from '@/lib/db'
import { analyze, type PityModel } from '@/lib/stats/analyze'
import { normalizeArknights, normalizeEndfield } from '@/lib/stats/events'
import { arknightsGuarantees, endfieldGuarantees } from '@/lib/stats/guarantees'
import { arknightsRate, distribution, endfieldRate } from '@/lib/stats/pity'
import type { AkPull, EfPoolInfo, EfPull } from '@/lib/types'
import { useAppStore } from './app'

export const MODELS: Record<'arknights' | 'endfield', PityModel> = {
  arknights: { dist: distribution(arknightsRate), softPity: 50, hardPity: 99 },
  endfield: { dist: distribution(endfieldRate), softPity: 65, hardPity: 80 },
}

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
  const events = computed(() =>
    game.value === 'arknights'
      ? normalizeArknights(akPulls.value, app.meta ?? { version: '', generatedAt: '', upAvailable: false, chars: {}, pools: {}, avatars: [] })
      : normalizeEndfield(efPulls.value, efPools.value, app.efMeta ?? undefined),
  )
  const model = computed(() => MODELS[game.value])
  const analysis = computed(() => analyze(events.value, model.value))
  const guarantees = computed(() =>
    game.value === 'arknights'
      ? app.meta
        ? arknightsGuarantees(analysis.value, app.meta)
        : []
      : endfieldGuarantees(analysis.value, efPools.value, app.efMeta ?? undefined),
  )

  return { game, events, model, analysis, guarantees, efPools }
})
