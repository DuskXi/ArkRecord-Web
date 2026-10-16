<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import { computed } from 'vue'
import { useChartTheme } from '@/composables/useChartTheme'
import { dayKey } from '@/lib/stats/analyze'
import EChart from './EChart.vue'

const props = defineProps<{ perDay: Map<string, number> }>()
const palette = useChartTheme()

const range = computed<[string, string]>(() => {
  const end = Date.now()
  return [dayKey(end - 364 * 86_400_000), dayKey(end)]
})

const option = computed<EChartsOption>(() => {
  const p = palette.value
  const data = [...props.perDay.entries()].filter(([d]) => d >= range.value[0])
  const max = Math.max(10, ...data.map(([, n]) => n))
  return {
    tooltip: {
      formatter: (params) => {
        const [d, n] = (params as unknown as { value: [string, number] }).value
        return `${d}<br/><b>${n}</b> 抽`
      },
    },
    visualMap: {
      show: false,
      min: 0,
      max,
      inRange: { color: [p.dark ? '#1f2329' : '#eef1f4', p.primary] },
    },
    calendar: {
      range: range.value,
      cellSize: ['auto', 13],
      top: 24,
      left: 28,
      right: 8,
      splitLine: { show: false },
      itemStyle: { color: 'transparent', borderColor: p.bg, borderWidth: 2 },
      yearLabel: { show: false },
      dayLabel: { color: p.dimmed, nameMap: 'ZH', firstDay: 1, fontSize: 10 },
      monthLabel: { color: p.dimmed, nameMap: 'ZH', fontSize: 10 },
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
  }
})
</script>

<template>
  <EChart :option="option" height="150px" />
</template>
