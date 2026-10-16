<script setup lang="ts">
import { refDebounced } from '@vueuse/core'
import type { EChartsOption } from 'echarts'
import { computed, ref, watch } from 'vue'
import EChart from '@/components/charts/EChart.vue'
import { useChartTheme } from '@/composables/useChartTheme'
import { formatPercent } from '@/lib/format'
import { arknightsRate, endfieldRate } from '@/lib/stats/pity'
import { AK_PRESETS, EF_PRESETS, plan } from '@/lib/stats/planner'
import { useRecordsStore } from '@/stores/records'

/**
 * 抽卡规划：按游戏的保底规则精确计算“再抽 N 抽”的出货概率。
 * 当前垫抽默认取自记录，可以手动修改。
 */
const records = useRecordsStore()
const palette = useChartTheme()

const presets = computed(() => (records.game === 'arknights' ? AK_PRESETS : EF_PRESETS))
const presetId = ref('any')
const preset = computed(() => presets.value.find((p) => p.id === presetId.value) ?? presets.value[0]!)

const groups = computed(() => records.analysis.pity.filter((p) => !p.isolated || records.game === 'arknights'))
const family = ref<string>()
const pity = ref(0)
const pulls = ref(100)
const upShare = ref(0)
const sparkAt = ref<number | null>(null)
const done = ref(0)

watch(
  groups,
  (list) => {
    if (family.value && list.some((g) => g.family === family.value)) return
    family.value = list.find((g) => !g.isolated)?.family ?? list[0]?.family
  },
  { immediate: true },
)
watch(family, (f) => (pity.value = groups.value.find((g) => g.family === f)?.current ?? 0), { immediate: true })
watch(
  preset,
  (p) => {
    upShare.value = Math.round(p.upShare * 100)
    sparkAt.value = p.sparkAt ?? null
  },
  { immediate: true },
)
watch(
  () => records.game,
  () => (presetId.value = 'any'),
)

// 明日方舟资源换算：600 合成玉 = 1 抽，1 源石 = 180 合成玉
const orundum = ref(0)
const originite = ref(0)
const tickets = ref(0)
const tenTickets = ref(0)
const fromResources = computed(
  () => Math.floor(((orundum.value || 0) + (originite.value || 0) * 180) / 600) + (tickets.value || 0) + (tenTickets.value || 0) * 10,
)

const groupOptions = computed(() => groups.value.map((g) => ({ label: `${g.label} · 已垫 ${g.current}`, value: g.family })))
const presetOptions = computed(() => presets.value.map((p) => ({ label: p.label, value: p.id })))
const custom = computed(() => presetId.value === 'custom')

const inputs = computed(() => ({
  pity: pity.value || 0,
  pulls: pulls.value || 0,
  share: (upShare.value || 0) / 100,
  spark: sparkAt.value ? { at: sparkAt.value, done: done.value || 0, gift: preset.value.gift } : undefined,
}))
const debounced = refDebounced(inputs, 120)
const result = computed(() =>
  plan({
    rate: records.game === 'arknights' ? arknightsRate : endfieldRate,
    hardPity: records.model.hardPity,
    pity: debounced.value.pity,
    pulls: debounced.value.pulls,
    upShare: debounced.value.share,
    spark: debounced.value.spark,
  }),
)

const atLeast = computed(() => {
  const pmf = result.value.sixCountPmf
  return [1, 2, 3, 4, 5].map((k) => ({ k, p: pmf.slice(k).reduce((a, b) => a + b, 0) }))
})

const chartOption = computed<EChartsOption>(() => {
  const p = palette.value
  const r = result.value
  const span = Math.min(
    Math.max(r.sixCdf.length, r.targetCdf.length),
    Math.max(debounced.value.pulls, r.targetP90 ?? 0, records.model.hardPity) + 10,
  )
  const xs = Array.from({ length: span }, (_, i) => i + 1)
  const pct = (arr: number[]) => xs.map((n) => (arr[n - 1] === undefined ? null : Number((arr[n - 1]! * 100).toFixed(2))))
  return {
    grid: { left: 40, right: 16, top: 32, bottom: 28 },
    legend: { top: 0, textStyle: { color: p.muted }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => (v === null || v === undefined ? '—' : `${v as number}%`) },
    xAxis: {
      type: 'category',
      data: xs,
      axisLine: { lineStyle: { color: p.border } },
      axisLabel: { color: p.dimmed, fontSize: 11, interval: Math.max(0, Math.ceil(span / 8) - 1) },
    },
    yAxis: {
      type: 'value',
      max: 100,
      axisLabel: { color: p.dimmed, fontSize: 11, formatter: '{value}%' },
      splitLine: { lineStyle: { color: p.border, type: 'dashed' } },
    },
    series: [
      {
        name: '至少 1 个 6★',
        type: 'line',
        data: pct(r.sixCdf),
        symbol: 'none',
        itemStyle: { color: p.rarity6 },
        lineStyle: { color: p.rarity6, width: 2 },
        markLine:
          debounced.value.pulls > 0 && debounced.value.pulls <= span
            ? {
                symbol: 'none',
                label: { formatter: '计划', color: p.muted },
                lineStyle: { color: p.muted, type: 'dashed' },
                data: [{ xAxis: String(debounced.value.pulls) }],
              }
            : undefined,
      },
      ...(r.targetCdf.length
        ? [{ name: '得到目标', type: 'line' as const, data: pct(r.targetCdf), symbol: 'none', itemStyle: { color: p.primary }, lineStyle: { color: p.primary, width: 2 } }]
        : []),
    ],
  }
})
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-5">
    <div class="space-y-4 lg:col-span-2">
      <UFormField label="保底分组" help="当前垫抽取自你的记录，可以修改">
        <div class="flex gap-2">
          <USelect v-model="family" :items="groupOptions" class="min-w-0 flex-1" placeholder="没有记录" />
          <UInputNumber v-model="pity" :min="0" :max="records.model.hardPity - 1" class="w-28" />
        </div>
      </UFormField>

      <UFormField label="计划抽数">
        <UInputNumber v-model="pulls" :min="0" :max="2000" :step="10" class="w-full" />
      </UFormField>

      <UCollapsible v-if="records.game === 'arknights'" class="rounded-(--ui-radius) border border-default">
        <UButton label="按资源换算" icon="i-lucide-calculator" color="neutral" variant="ghost" size="sm" trailing-icon="i-lucide-chevron-down" block class="justify-start" />
        <template #content>
          <div class="grid grid-cols-2 gap-2 border-t border-default p-3">
            <UFormField label="合成玉" size="xs"><UInputNumber v-model="orundum" :min="0" :step="600" size="sm" /></UFormField>
            <UFormField label="源石" size="xs"><UInputNumber v-model="originite" :min="0" size="sm" /></UFormField>
            <UFormField label="寻访凭证" size="xs"><UInputNumber v-model="tickets" :min="0" size="sm" /></UFormField>
            <UFormField label="十连寻访凭证" size="xs"><UInputNumber v-model="tenTickets" :min="0" size="sm" /></UFormField>
            <div class="col-span-2 flex items-center justify-between gap-2 pt-1">
              <span class="text-xs text-muted">共 <b class="font-display text-highlighted">{{ fromResources }}</b> 抽（600 合成玉 = 1 抽，1 源石 = 180 合成玉）</span>
              <UButton label="填入" size="xs" :disabled="!fromResources" @click="pulls = fromResources" />
            </div>
          </div>
        </template>
      </UCollapsible>

      <UFormField label="目标" :help="preset.note">
        <USelect v-model="presetId" :items="presetOptions" class="w-full" />
      </UFormField>

      <div v-if="upShare > 0 || custom" class="grid grid-cols-3 gap-2">
        <UFormField label="UP 占 6★" size="xs">
          <UInputNumber v-model="upShare" :min="0" :max="100" :disabled="!custom" size="sm" />
        </UFormField>
        <UFormField label="第几抽必得" size="xs">
          <UInputNumber v-model="sparkAt" :min="0" :disabled="!custom" size="sm" placeholder="无" />
        </UFormField>
        <UFormField label="本池已抽" size="xs">
          <UInputNumber v-model="done" :min="0" :disabled="!sparkAt" size="sm" />
        </UFormField>
      </div>
    </div>

    <div class="space-y-4 lg:col-span-3">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div class="rounded-(--ui-radius) border border-default p-3">
          <p class="eyebrow">AT LEAST ONE 6★</p>
          <p class="mt-1 font-display text-2xl font-semibold" :style="{ color: 'var(--color-rarity-6)' }">{{ formatPercent(result.pSix, 1) }}</p>
          <p class="text-xs text-muted">至少出 1 个 6★</p>
        </div>
        <div class="rounded-(--ui-radius) border border-default p-3">
          <p class="eyebrow">EXPECTED</p>
          <p class="mt-1 font-display text-2xl font-semibold text-highlighted">{{ result.expectedSix.toFixed(2) }}</p>
          <p class="text-xs text-muted">期望 6★ 个数</p>
        </div>
        <div v-if="result.pTarget !== null" class="col-span-2 rounded-(--ui-radius) border border-primary/40 bg-primary/5 p-3 sm:col-span-1">
          <p class="eyebrow">TARGET</p>
          <p class="mt-1 font-display text-2xl font-semibold text-primary">{{ formatPercent(result.pTarget, 1) }}</p>
          <p class="text-xs text-muted">
            得到目标<template v-if="result.targetMedian">；一半的情况 {{ result.targetMedian }} 抽内，90% 的情况 {{ result.targetP90 ?? '—' }} 抽内</template>
          </p>
        </div>
      </div>

      <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span v-for="a in atLeast" :key="a.k">
          ≥ {{ a.k }} 个 6★：<b class="font-display text-highlighted">{{ formatPercent(a.p, a.p > 0.999 || a.p < 0.001 ? 2 : 1) }}</b>
        </span>
      </div>

      <div class="rounded-(--ui-radius) border border-default p-3">
        <p class="text-xs text-muted">n 抽内的累计概率</p>
        <EChart :option="chartOption" height="240px" />
      </div>
      <p class="text-xs leading-relaxed text-dimmed">
        按游戏公布的概率和保底规则逐抽精确计算，不是模拟抽样。卡池规则以游戏内公告为准，特殊卡池请选择“自定义”自行设置。
      </p>
    </div>
  </div>
</template>
