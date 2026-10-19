<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import { computed } from 'vue'
import EChart from '@/components/charts/EChart.vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { useChartTheme } from '@/composables/useChartTheme'
import { formatPercent } from '@/lib/format'
import { luckLabel } from '@/lib/stats/analyze'
import { useRecords } from '@/composables/useRecords'

const records = useRecords()
const palette = useChartTheme()
const a = computed(() => records.analysis)

function axisStyle() {
  const p = palette.value
  return {
    axisLine: { lineStyle: { color: p.border } },
    axisLabel: { color: p.dimmed, fontSize: 11 },
    splitLine: { lineStyle: { color: p.border, type: 'dashed' as const } },
  }
}

// ── 6★ 出货分布：实际 vs 理论 ──
const BIN = 10
const pityOption = computed<EChartsOption>(() => {
  const p = palette.value
  const intervals = a.value.mainIntervals
  const hard = records.model.hardPity
  const bins = Math.ceil(hard / BIN)
  const actual = Array.from({ length: bins }, () => 0)
  for (const n of intervals) actual[Math.min(bins - 1, Math.floor((n - 1) / BIN))]!++
  const expected = Array.from({ length: bins }, () => 0)
  const dist = records.model.dist
  dist?.pmf.forEach((prob, i) => (expected[Math.min(bins - 1, Math.floor(i / BIN))]! += prob * intervals.length))
  const labels = Array.from({ length: bins }, (_, i) => `${i * BIN + 1}–${Math.min(hard, (i + 1) * BIN)}`)
  return {
    grid: { left: 36, right: 12, top: 36, bottom: 28 },
    legend: { top: 0, textStyle: { color: p.muted }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: labels, ...axisStyle() },
    yAxis: { type: 'value', minInterval: 1, ...axisStyle() },
    series: [
      { name: '你的 6★', type: 'bar', data: actual, itemStyle: { color: p.rarity6, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 28 },
      // 没有概率模型（终末地武器池）时不画理论曲线
      ...(dist
        ? [
            {
              name: '理论期望',
              type: 'line' as const,
              data: expected.map((v) => Number(v.toFixed(2))),
              symbol: 'none',
              itemStyle: { color: p.primary }, lineStyle: { color: p.primary, width: 2 },
              areaStyle: { color: p.primary, opacity: 0.08 },
            },
          ]
        : []),
    ],
  }
})

// ── 每月抽数与 6★ ──
const monthlyOption = computed<EChartsOption>(() => {
  const p = palette.value
  const months = [...a.value.perMonth.keys()].toSorted()
  const sixByMonth = new Map<string, number>()
  for (const h of a.value.hits) {
    const m = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(h.event.ts).slice(0, 7)
    sixByMonth.set(m, (sixByMonth.get(m) ?? 0) + 1)
  }
  return {
    grid: { left: 44, right: 36, top: 36, bottom: 28 },
    legend: { top: 0, textStyle: { color: p.muted }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: months, ...axisStyle() },
    yAxis: [
      { type: 'value', ...axisStyle() },
      { type: 'value', minInterval: 1, ...axisStyle(), splitLine: { show: false } },
    ],
    series: [
      { name: '抽数', type: 'bar', data: months.map((m) => a.value.perMonth.get(m) ?? 0), itemStyle: { color: p.primary, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 22 },
      { name: '6★', type: 'line', yAxisIndex: 1, data: months.map((m) => sixByMonth.get(m) ?? 0), symbolSize: 6, lineStyle: { color: p.rarity6 }, itemStyle: { color: p.rarity6 } },
    ],
  }
})

// ── 星级分布 ──
const expectedRates = computed(() => {
  const dist = records.model.dist
  if (!dist) return null
  const six = 1 / dist.mean
  return records.game === 'arknights' ? { 6: six, 5: 0.08, 4: 0.5, 3: 0.42 - six } : { 6: six, 5: 0.08, 4: 0.92 - six, 3: 0 }
})
const rarityOption = computed<EChartsOption>(() => {
  const p = palette.value
  const colors: Record<number, string> = { 6: p.rarity6, 5: p.rarity5, 4: p.rarity4, 3: p.rarity3 }
  const data = ([6, 5, 4, 3] as const)
    .filter((s) => a.value.stars[s] > 0)
    .map((s) => ({ name: `${s}★`, value: a.value.stars[s], itemStyle: { color: colors[s] } }))
  return {
    tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' },
    series: [
      {
        type: 'pie',
        radius: ['58%', '82%'],
        padAngle: 2,
        itemStyle: { borderRadius: 3 },
        label: { color: p.muted, formatter: '{b}\n{d}%' },
        data,
      },
    ],
  }
})

const luck = computed(() => luckLabel(a.value.luck))

const families = computed(() => {
  const map = new Map<string, { label: string; count: number; total: number; max: number; min: number }>()
  for (const h of a.value.hits) {
    const f = map.get(h.event.family) ?? { label: h.event.familyLabel, count: 0, total: 0, max: 0, min: Infinity }
    f.count++
    f.total += h.pity
    f.max = Math.max(f.max, h.pity)
    f.min = Math.min(f.min, h.pity)
    map.set(h.event.family, f)
  }
  return [...map.values()].toSorted((x, y) => y.count - x.count)
})
</script>

<template>
  <PageShell id="analysis" title="分析" eyebrow="ANALYTICS">
    <div v-if="!a.total" class="mt-10">
      <UEmpty icon="i-lucide-chart-no-axes-column" title="还没有可以分析的记录" description="同步或导入记录后，这里会显示出货分布、运气评估等统计。" />
    </div>
    <div v-else class="space-y-8">
      <section class="grid gap-3 lg:grid-cols-3">
        <div class="rounded-(--ui-radius) border border-default p-5 lg:col-span-1">
          <p class="eyebrow">LUCK PERCENTILE</p>
          <p class="mt-2 font-display text-5xl font-semibold text-highlighted">{{ a.luck === null ? '—' : formatPercent(a.luck, 0) }}</p>
          <p class="mt-1 text-sm font-medium" style="color: var(--color-rarity-6)">{{ luck.text }}</p>
          <p v-if="records.model.dist" class="mt-3 text-xs leading-relaxed text-muted">
            根据游戏的保底规则精确计算：和同样出了 {{ a.mainIntervals.length }} 个 6★ 的理论玩家相比，你花的总抽数比这个比例的人更少。
            50% 表示正好符合期望。计算全部在你的浏览器里完成，不依赖任何人的数据。
          </p>
          <p v-else class="mt-3 text-xs leading-relaxed text-muted">
            武器池只公布了“{{ records.model.hardPity }} 抽内必出 6★”，没有可靠的基础概率，因此不计算运气百分位和理论分布。
          </p>
        </div>
        <div class="rounded-(--ui-radius) border border-default p-4 lg:col-span-2">
          <p class="eyebrow">6★ PITY DISTRIBUTION</p>
          <p class="text-sm font-medium text-highlighted">每个 6★ 花了多少抽</p>
          <EChart :option="pityOption" height="240px" />
        </div>
      </section>

      <section>
        <SectionHeader index="01" eyebrow="BY PITY GROUP" title="各保底分组" />
        <div class="overflow-x-auto rounded-(--ui-radius) border border-default">
          <table class="w-full text-sm">
            <thead class="bg-elevated/50 text-left text-xs text-muted">
              <tr>
                <th class="px-4 py-2 font-medium">分组</th>
                <th class="px-4 py-2 text-right font-medium">6★</th>
                <th class="px-4 py-2 text-right font-medium">平均抽数</th>
                <th class="px-4 py-2 text-right font-medium">最欧</th>
                <th class="px-4 py-2 text-right font-medium">最非</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr v-for="f in families" :key="f.label">
                <td class="px-4 py-2 text-highlighted">{{ f.label }}</td>
                <td class="px-4 py-2 text-right font-display">{{ f.count }}</td>
                <td class="px-4 py-2 text-right font-display">{{ (f.total / f.count).toFixed(1) }}</td>
                <td class="px-4 py-2 text-right font-display text-success">{{ f.min }}</td>
                <td class="px-4 py-2 text-right font-display text-error">{{ f.max }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="grid gap-3 lg:grid-cols-3">
        <div class="rounded-(--ui-radius) border border-default p-4 lg:col-span-2">
          <p class="eyebrow">MONTHLY</p>
          <p class="text-sm font-medium text-highlighted">每月抽数</p>
          <EChart :option="monthlyOption" height="260px" />
        </div>
        <div class="rounded-(--ui-radius) border border-default p-4">
          <p class="eyebrow">RARITY</p>
          <p class="text-sm font-medium text-highlighted">星级分布</p>
          <EChart :option="rarityOption" height="200px" />
          <ul class="mt-2 space-y-1 text-xs">
            <li v-for="s in [6, 5, 4, 3] as const" :key="s" class="flex justify-between text-muted">
              <span>{{ s }}★ 实际 / 理论</span>
              <span class="font-display">
                {{ a.total ? formatPercent(a.stars[s] / a.total, 2) : '—' }} / {{ expectedRates ? formatPercent(expectedRates[s], 2) : '—' }}
              </span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </PageShell>
</template>
