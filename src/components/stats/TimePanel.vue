<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import { computed } from 'vue'
import EChart from '@/components/charts/EChart.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { axisStyle, type ChartPalette, heatPieces, useChartTheme } from '@/composables/useChartTheme'
import { formatPercent } from '@/lib/format'
import { useRecordsStore } from '@/stores/records'

const records = useRecordsStore()
const palette = useChartTheme()
const s = computed(() => records.insights)

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function heatmap(grid: number[][], p: ChartPalette, accent: string, unit: string): EChartsOption {
  const data: [number, number, number][] = []
  grid.forEach((row, d) => row.forEach((n, h) => data.push([h, d, n])))
  return {
    grid: { left: 40, right: 8, top: 8, bottom: 24 },
    tooltip: {
      formatter: (params) => {
        const [h, d, n] = (params as unknown as { value: [number, number, number] }).value
        return `${WEEKDAYS[d]} ${h}:00–${h + 1}:00<br/><b>${n}</b> ${unit}`
      },
    },
    xAxis: {
      type: 'category',
      data: Array.from({ length: 24 }, (_, h) => String(h)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: p.dimmed, fontSize: 10, interval: 2 },
    },
    yAxis: { type: 'category', data: WEEKDAYS, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: p.dimmed, fontSize: 11 } },
    visualMap: { type: 'piecewise', show: false, dimension: 2, pieces: heatPieces(grid.flat(), p, accent) },
    series: [{ type: 'heatmap', data, itemStyle: { borderColor: p.bg, borderWidth: 2, borderRadius: 2 } }],
  }
}

const pullOption = computed(() => heatmap(s.value.hourWeek, palette.value, palette.value.primary, '抽'))
const sixOption = computed(() => heatmap(s.value.sixHourWeek, palette.value, palette.value.rarity6, '个 6★'))

const peak = (grid: number[][]) => {
  let best = { d: 0, h: 0, n: 0 }
  grid.forEach((row, d) => row.forEach((n, h) => n > best.n && (best = { d, h, n })))
  return best.n ? `${WEEKDAYS[best.d]} ${best.h}:00` : null
}
const peakPull = computed(() => peak(s.value.hourWeek))
const peakSix = computed(() => peak(s.value.sixHourWeek))

// ── 各小时出红率 ──
const totals = computed(() => s.value.byHour.reduce((a, x) => ({ pulls: a.pulls + x.pulls, six: a.six + x.six }), { pulls: 0, six: 0 }))
/** 抽数太少的小时出红率没有参考意义，不参与“最欧时段” */
const minPulls = computed(() => Math.max(30, Math.round(totals.value.pulls / 48)))
const luckiestHour = computed(() => {
  let best: { h: number; rate: number; pulls: number } | null = null
  s.value.byHour.forEach((x, h) => {
    if (x.pulls < minPulls.value) return
    const rate = x.six / x.pulls
    if (!best || rate > best.rate) best = { h, rate, pulls: x.pulls }
  })
  return best as { h: number; rate: number; pulls: number } | null
})

const rateOption = computed<EChartsOption>(() => {
  const p = palette.value
  const avg = totals.value.pulls ? totals.value.six / totals.value.pulls : 0
  return {
    grid: { left: 44, right: 12, top: 16, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const h = (params as unknown as { dataIndex: number }[])[0]?.dataIndex ?? 0
        const x = s.value.byHour[h]!
        return `${h}:00–${h + 1}:00<br/>${x.pulls} 抽，${x.six} 个 6★<br/>出红率 <b>${x.pulls ? formatPercent(x.six / x.pulls, 2) : '—'}</b>`
      },
    },
    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, h) => String(h)), ...axisStyle(p), axisLabel: { color: p.dimmed, fontSize: 10, interval: 1 } },
    yAxis: { type: 'value', ...axisStyle(p), axisLabel: { color: p.dimmed, fontSize: 10, formatter: (v: number) => `${(v * 100).toFixed(1)}%` } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 16,
        data: s.value.byHour.map((x) => ({
          value: x.pulls ? x.six / x.pulls : 0,
          // 样本太少的小时画成浅色
          itemStyle: { color: x.pulls >= minPulls.value ? p.rarity6 : p.border, borderRadius: [2, 2, 0, 0] },
        })),
        markLine: { symbol: 'none', label: { show: false }, lineStyle: { color: p.muted, type: 'dashed' }, data: [{ yAxis: avg }] },
      },
    ],
  }
})
</script>

<template>
  <div class="space-y-10">
    <section class="grid gap-3 xl:grid-cols-2">
      <div class="rounded-(--ui-radius) border border-default p-4">
        <SectionHeader eyebrow="WHEN YOU PULL" title="抽卡时段" class="!mb-1" />
        <p class="text-xs text-muted">北京时间<template v-if="peakPull">，最常在 <b class="text-highlighted">{{ peakPull }}</b> 前后抽卡</template></p>
        <EChart :option="pullOption" height="220px" />
      </div>
      <div class="rounded-(--ui-radius) border border-default p-4">
        <SectionHeader eyebrow="WHEN 6★ APPEARS" title="出红时段" class="!mb-1" />
        <p class="text-xs text-muted">
          每个格子出了几个 6★<template v-if="peakSix">；出红最多的是 <b class="text-highlighted">{{ peakSix }}</b></template>
        </p>
        <EChart :option="sixOption" height="220px" />
      </div>
    </section>

    <section>
      <SectionHeader eyebrow="6★ RATE BY HOUR" title="各时段出红率" />
      <div class="rounded-(--ui-radius) border border-default p-4">
        <p class="text-xs leading-relaxed text-muted">
          每个小时内出 6★ 的比例，虚线是你的整体出红率 {{ totals.pulls ? formatPercent(totals.six / totals.pulls, 2) : '—' }}。
          <template v-if="luckiestHour">
            抽数不少于 {{ minPulls }} 抽的时段里，<b class="text-highlighted">{{ luckiestHour.h }}:00–{{ luckiestHour.h + 1 }}:00</b> 最欧（{{ formatPercent(luckiestHour.rate, 2) }}，{{ luckiestHour.pulls }} 抽）。
          </template>
          出红概率只由保底规则决定，与时间无关，时段之间的差别来自样本的随机波动；浅色柱子的样本太少，仅供参考。
        </p>
        <EChart :option="rateOption" height="240px" />
      </div>
    </section>
  </div>
</template>
