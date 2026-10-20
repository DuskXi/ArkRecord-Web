/**
 * 原神、星铁的记录来源（给 provideRecords，见 src/composables/useRecords.ts）：鹰角的统计页面直接用它。
 * 记录先由 normalizeMhy 变成寻访事件，保底模型是按官方数字推算的 mhyModel（src/lib/mhy/），再交给同一个统计引擎。
 * 和终末地一样分“角色 / 武器”两个范围看（原神武器、星铁光锥算武器），范围放在 efScope 里，页面右上角的切换直接改它。
 * 总览的保底卡片是各活动池的大小保底（mhyGuarantees），抽卡规划的预设按范围换（mhyPlanner）。
 * 米哈游没有累计赠送、截图识别，这两项给空值。
 */
import { computed, reactive, ref, watch } from 'vue'
import type { RecordsSource } from '@/composables/useRecords'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { mhyDb } from '@/lib/mhy/db'
import { normalizeMhy } from '@/lib/mhy/events'
import { mhyModel } from '@/lib/mhy/models'
import { mhyPlanner } from '@/lib/mhy/planner'
import { mhyGuarantees } from '@/lib/mhy/up'
import type { MhyGame, MhyPull } from '@/lib/mhy/types'
import { analyze } from '@/lib/stats/analyze'
import { computeInsights } from '@/lib/stats/insights'
import type { EfScope } from '@/stores/records'
import { useMhyAccounts } from './accounts'
import { MHY_PROFILES } from './profile'

export function useMhyRecords(game: () => MhyGame): RecordsSource {
  const { account } = useMhyAccounts(game)
  const pulls = useLiveQuery(
    () => (account.value ? mhyDb.pulls.where('accountId').equals(account.value.id).toArray() : []),
    [() => account.value?.id],
    [] as MhyPull[],
  )
  const efScope = ref<EfScope>('char')
  // 换游戏时回到“角色”
  watch(game, () => (efScope.value = 'char'))
  const weaponScope = computed(() => efScope.value === 'weapon')

  const allEvents = computed(() => normalizeMhy(game(), pulls.value))
  const events = computed(() => allEvents.value.filter((e) => e.weapon === weaponScope.value))
  const model = computed(() => mhyModel(game(), efScope.value))
  const analysis = computed(() => analyze(events.value, model.value))
  const insights = computed(() => computeInsights(events.value, analysis.value))
  const guarantees = computed(() => mhyGuarantees(game(), analysis.value, events.value))

  const source: RecordsSource = reactive({
    accountId: computed(() => account.value?.id ?? ''),
    game: computed(() => game()),
    // 抽卡规划的预设分角色 / 武器
    profile: computed(() => ({ ...MHY_PROFILES[game()], planner: mhyPlanner(game(), efScope.value) })),
    efScope,
    weaponScope,
    events,
    gifts: [],
    roster: [],
    model,
    analysis,
    guarantees,
    insights,
    efPools: new Map(),
  })
  return source
}
