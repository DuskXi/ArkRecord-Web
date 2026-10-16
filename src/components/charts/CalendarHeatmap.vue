<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import { computed } from 'vue'
import { heatPieces, mixRgb, useChartTheme } from '@/composables/useChartTheme'
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
  return {
    tooltip: {
      formatter: (params) => {
        const [d, n] = (params as unknown as { value: [string, number] }).value
        return `${d}<br/><b>${n}</b> 抽`
      },
    },
    // 分档配色，少量抽卡的日子也清晰可见；没有抽卡的日子显示为浅色格子
    visualMap: { type: 'piecewise', show: false, dimension: 1, pieces: heatPieces(data.map(([, n]) => n), p, p.primary) },
    calendar: {
      range: range.value,
      cellSize: ['auto', 13],
      top: 24,
      left: 28,
      right: 8,
      splitLine: { show: false },
      itemStyle: { color: mixRgb(p.border, p.bg, 0.5), borderColor: p.bg, borderWidth: 2 },
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
