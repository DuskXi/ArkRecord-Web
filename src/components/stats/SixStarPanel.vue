<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import { computed } from 'vue'
import EChart from '@/components/charts/EChart.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { axisStyle, rarityColor, useChartTheme } from '@/composables/useChartTheme'
import { formatDateTime, formatPercent, rarityVar } from '@/lib/format'
import { quantile } from '@/lib/stats/pity'
import { analyzeUp, binPity, luckTrend } from '@/lib/stats/sixstar'
import { upTag } from '@/lib/stats/up-tag'
import { useRecords } from '@/composables/useRecords'

const records = useRecords()
/** 明日方舟叫“出金”，终末地叫“出红” */
const term = computed(() => records.profile.topTerm)
/** 最高星级：鹰角 6★，米哈游 5★ */
const top = computed(() => records.profile.topStar)
/** 理论分布是按官方数字推算的（米哈游）：图例和说明里标注推算 */
const derived = computed(() => !!records.model.derived)
/** 有软保底（第 X 抽起概率上升）才显示相关的统计；米哈游没有官方的软保底 */
const hasSoft = computed(() => records.model.softPity < records.model.hardPity)
const palette = useChartTheme()
const dist = computed(() => records.model.dist)
const intervals = computed(() => records.analysis.mainIntervals)

const pct = (xs: number[]) => xs.map((x) => Number((x * 100).toFixed(1)))

// ── 出 6★ 的抽数分布 ──
const bins = computed(() => binPity(intervals.value, dist.value, records.model.hardPity, 5))
const median = computed(() => {
  const sorted = intervals.value.toSorted((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null
})
const afterSoft = computed(() =>
  intervals.value.length ? intervals.value.filter((n) => n > records.model.softPity).length / intervals.value.length : null,
)

const pityOption = computed<EChartsOption>(() => {
  const p = palette.value
  const b = bins.value
  return {
    grid: { left: 36, right: 44, top: 36, bottom: 28 },
    legend: { top: 0, textStyle: { color: p.muted }, itemWidth: 12, itemHeight: 8 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: b.labels, ...axisStyle(p), axisLabel: { color: p.dimmed, fontSize: 10, interval: 1 } },
    yAxis: [
      { type: 'value', minInterval: 1, ...axisStyle(p) },
      { type: 'value', max: 100, ...axisStyle(p), splitLine: { show: false }, axisLabel: { color: p.dimmed, fontSize: 10, formatter: '{value}%' } },
    ],
    series: [
      { name: `你的 ${top.value}★`, type: 'bar', data: b.actual, itemStyle: { color: rarityColor(p, top.value), borderRadius: [2, 2, 0, 0] }, barMaxWidth: 18 },
      ...(b.expected
        ? [{ name: derived.value ? '理论个数（推算）' : '理论个数', type: 'line' as const, data: b.expected.map((v) => Number(v.toFixed(2))), symbol: 'none', itemStyle: { color: p.primary }, lineStyle: { color: p.primary, width: 2 } }]
        : []),
      {
        name: '你的累计',
        type: 'line',
        yAxisIndex: 1,
        step: 'end',
        data: pct(b.cdfActual),
        symbol: 'none',
        itemStyle: { color: rarityColor(p, top.value) }, lineStyle: { color: rarityColor(p, top.value), width: 1.5, type: 'dashed' },
      },
      ...(b.cdfTheory
        ? [{ name: derived.value ? '理论累计（推算）' : '理论累计', type: 'line' as const, yAxisIndex: 1, data: pct(b.cdfTheory), symbol: 'none', itemStyle: { color: p.primary }, lineStyle: { color: p.primary, width: 1.5, type: 'dashed' as const } }]
        : []),
    ],
  }
})

// ── 6★ 出货序列 ──
const sequence = computed(() => records.insights.sixSequence)
const sequenceOption = computed<EChartsOption>(() => {
  const p = palette.value
  const seq = sequence.value
  const mean = dist.value?.mean
  return {
    grid: { left: 36, right: 12, top: 16, bottom: seq.length > 40 ? 56 : 28 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const item = seq[(params as unknown as { dataIndex: number }[])[0]?.dataIndex ?? 0]
        if (!item) return ''
        const e = item.hit.event
        const up = upTag(e)
        const tag = up ? `（${up.text}）` : ''
        const pity = item.hit.afterGap ? '抽数未知（前面有一段没有记录的空档）' : `第 <b>${item.hit.pity}</b> 抽`
        return `<b>${e.name}</b>${tag}<br/>${e.poolName}<br/>${formatDateTime(e.ts)}<br/>${pity} · 累计平均 ${item.runningAvg.toFixed(1)}`
      },
    },
    xAxis: { type: 'category', data: seq.map((_, i) => String(i + 1)), ...axisStyle(p) },
    yAxis: { type: 'value', max: records.model.hardPity, ...axisStyle(p) },
    dataZoom:
      seq.length > 40
        ? [{ type: 'inside', startValue: seq.length - 40 }, { type: 'slider', height: 18, bottom: 6, borderColor: p.border, textStyle: { color: p.dimmed } }]
        : undefined,
    series: [
      {
        name: '抽数',
        type: 'bar',
        barMaxWidth: 18,
        // 记录空档之后抽数未知的不画柱子
        data: seq.map(({ hit }) => ({
          value: hit.afterGap ? null : hit.pity,
          itemStyle: { color: hit.event.isUp === null ? rarityColor(p, top.value) : hit.event.isUp ? p.primary : p.dimmed, borderRadius: [2, 2, 0, 0] },
        })),
        markLine: mean
          ? { symbol: 'none', label: { show: false }, lineStyle: { color: p.muted, type: 'dashed' }, data: [{ yAxis: Number(mean.toFixed(2)) }] }
          : undefined,
      },
      { name: '累计平均', type: 'line', data: seq.map((x) => Number(x.runningAvg.toFixed(2))), symbol: 'none', smooth: true, itemStyle: { color: p.text }, lineStyle: { color: p.text, width: 2 } },
    ],
  }
})

// ── 歪不歪 ──
const up = computed(() => analyzeUp(records.analysis.hits))
/** 米哈游的大小保底：只算小保底，叫“小保底不歪率”（大保底必是 UP） */
const fiftyFifty = computed(() => records.profile.fiftyFifty)
const upOption = computed<EChartsOption>(() => {
  const p = palette.value
  const u = up.value
  // 只画概率不可忽略的区间
  const lo = Math.max(0, u.pmf.findIndex((x) => x > 1e-4))
  const hi = u.pmf.length - 1 - Math.max(0, u.pmf.toReversed().findIndex((x) => x > 1e-4))
  const ks = Array.from({ length: Math.max(1, hi - lo + 1) }, (_, i) => lo + i)
  return {
    grid: { left: 40, right: 12, top: 16, bottom: 36 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const k = ks[(params as unknown as { dataIndex: number }[])[0]?.dataIndex ?? 0] ?? 0
        const head = fiftyFifty.value ? `${u.total} 次小保底中恰有 <b>${k}</b> 次没歪` : `${u.total} 个 ${top.value}★ 中恰有 <b>${k}</b> 个 UP`
        return `${head}<br/>理论概率 ${formatPercent(u.pmf[k] ?? 0, 2)}${k === u.wins ? '<br/><b>← 你的结果</b>' : ''}`
      },
    },
    xAxis: { type: 'category', data: ks.map(String), name: fiftyFifty.value ? '没歪次数' : 'UP 个数', nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: p.dimmed, fontSize: 11 }, ...axisStyle(p) },
    yAxis: { type: 'value', ...axisStyle(p), axisLabel: { color: p.dimmed, fontSize: 10, formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 22,
        data: ks.map((k) => ({
          value: u.pmf[k] ?? 0,
          itemStyle: { color: k === u.wins ? rarityColor(p, top.value) : k < u.wins ? p.primary : p.border, borderRadius: [2, 2, 0, 0] },
        })),
      },
    ],
  }
})

// ── 欧非走势 ──
const trend = computed(() => luckTrend(records.events, dist.value, undefined, top.value))
const trendOption = computed<EChartsOption>(() => {
  const p = palette.value
  const t = trend.value
  return {
    grid: { left: 36, right: 12, top: 36, bottom: 28 },
    legend: { top: 0, textStyle: { color: p.muted }, itemWidth: 12, itemHeight: 8 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const point = t[(params as unknown as { dataIndex: number }[])[0]?.dataIndex ?? 0]
        if (!point) return ''
        const diff = point.actual - point.expected
        return `第 ${point.pulls} 抽<br/>实际 ${top.value}★ <b>${point.actual}</b> · 理论 ${point.expected.toFixed(1)}<br/>${diff >= 0 ? '多出' : '少了'} ${Math.abs(diff).toFixed(1)} 个`
      },
    },
    xAxis: { type: 'category', data: t.map((x) => String(x.pulls)), ...axisStyle(p), axisLabel: { color: p.dimmed, fontSize: 10 } },
    yAxis: { type: 'value', ...axisStyle(p) },
    series: [
      {
        name: `实际 ${top.value}★`,
        type: 'line',
        step: 'end',
        data: t.map((x) => x.actual),
        symbol: 'none',
        itemStyle: { color: rarityColor(p, top.value) },
        lineStyle: { color: rarityColor(p, top.value), width: 2 },
      },
      {
        name: `理论 ${top.value}★${derived.value ? '（推算）' : ''}`,
        type: 'line',
        data: t.map((x) => Number(x.expected.toFixed(2))),
        symbol: 'none',
        itemStyle: { color: p.primary }, lineStyle: { color: p.primary, width: 2 },
        areaStyle: { color: p.primary, opacity: 0.06 },
      },
    ],
  }
})
const trendLast = computed(() => trend.value.at(-1) ?? null)
const theoryMedian = computed(() => (dist.value ? quantile(dist.value.pmf, 0.5) : null))
</script>

<template>
  <div class="space-y-10">
    <p v-if="!intervals.length" class="py-10 text-center text-sm text-muted">还没有 {{ top }}★ 记录</p>
    <template v-else>
      <section>
        <SectionHeader eyebrow="PITY DISTRIBUTION" :title="`${term}抽数分布`" />
        <div class="grid gap-3 lg:grid-cols-4">
          <div class="space-y-3 lg:col-span-1">
            <div class="rounded-(--ui-radius) border border-default p-4">
              <p class="eyebrow">YOUR MEDIAN</p>
              <p class="mt-1 font-display text-3xl font-semibold text-highlighted">{{ median ?? '—' }} <span class="text-sm font-normal text-muted">抽</span></p>
              <p class="text-xs text-muted">一半的 {{ top }}★ 在这个抽数之前出{{ theoryMedian ? `；理论中位数 ${theoryMedian} 抽${derived ? '（推算）' : ''}` : '' }}</p>
            </div>
            <div v-if="hasSoft" class="rounded-(--ui-radius) border border-default p-4">
              <p class="eyebrow">AFTER SOFT PITY</p>
              <p class="mt-1 font-display text-3xl font-semibold text-highlighted">{{ afterSoft === null ? '—' : formatPercent(afterSoft, 0) }}</p>
              <p class="text-xs text-muted">在第 {{ records.model.softPity }} 抽之后才出的 {{ top }}★ 占比</p>
            </div>
          </div>
          <div class="rounded-(--ui-radius) border border-default p-4 lg:col-span-3">
            <p class="text-xs text-muted">每 5 抽一个区间。虚线是累计比例（右轴）：曲线越靠左上，{{ term }}越早。</p>
            <EChart :option="pityOption" height="260px" />
          </div>
        </div>
      </section>

      <section>
        <SectionHeader eyebrow="UP OR NOT" :title="fiftyFifty ? '小保底不歪率' : `${term}歪不歪`" />
        <p v-if="!up.total" class="rounded-(--ui-radius) border border-default p-4 text-sm text-muted">
          {{ records.weaponScope && !derived ? '武器池的 UP 概率没有可靠来源，暂不计算。' : records.profile.upUnknownNote }}
        </p>
        <div v-else class="grid gap-3 lg:grid-cols-4">
          <div class="space-y-3 lg:col-span-1">
            <div class="rounded-(--ui-radius) border border-default p-4">
              <p class="eyebrow">UP LUCK</p>
              <p class="mt-1 font-display text-3xl font-semibold" :style="{ color: rarityVar(top) }">{{ up.luck === null ? '—' : formatPercent(up.luck, 0) }}</p>
              <p v-if="fiftyFifty" class="text-xs text-muted">
                {{ up.total }} 次小保底中 {{ up.wins }} 次没歪（理论期望 {{ up.expected.toFixed(1) }} 次），小保底不歪的运气超过这个比例的玩家
              </p>
              <p v-else class="text-xs text-muted">{{ up.total }} 个 {{ top }}★ 中 {{ up.wins }} 个 UP（理论期望 {{ up.expected.toFixed(1) }} 个），不歪的运气超过这个比例的玩家</p>
            </div>
            <div class="rounded-(--ui-radius) border border-default p-4">
              <p class="eyebrow">OFF-BANNER STREAK</p>
              <p class="mt-1 font-display text-3xl font-semibold text-highlighted">{{ up.longestOffStreak }} <span class="text-sm font-normal text-muted">连歪</span></p>
              <p class="text-xs text-muted">最长连续歪了 {{ up.longestOffStreak }} 次；当前已连歪 {{ up.currentOffStreak }} 次</p>
            </div>
          </div>
          <div class="rounded-(--ui-radius) border border-default p-4 lg:col-span-3">
            <p class="text-xs text-muted">
              <template v-if="fiftyFifty">
                只算小保底：按官方规则，角色活动池的小保底 50% 是 UP，武器 / 光锥活动池 75%，由此精确算出“N 次小保底中有 k 次没歪”的概率分布。高亮的是你的结果，蓝色是比你少的情况。大保底必是 UP，不计入。
              </template>
              <template v-else>
                每个 6★ 按所在卡池的规则有各自的 UP 概率（单 UP 50%、限定 70% 等），由此精确算出“N 个 6★ 中有 k 个 UP”的概率分布。橙色是你的结果，蓝色是比你少的情况。不计入定向保底。
              </template>
            </p>
            <EChart :option="upOption" height="220px" />
            <table class="mt-2 w-full text-sm">
              <thead class="text-left text-xs text-muted">
                <tr>
                  <th class="py-1 font-medium">{{ fiftyFifty ? '卡池' : '卡池类型' }}</th>
                  <th class="py-1 text-right font-medium">{{ fiftyFifty ? '小保底' : `${top}★` }}</th>
                  <th class="py-1 text-right font-medium">{{ fiftyFifty ? '不歪' : 'UP' }}</th>
                  <th class="py-1 text-right font-medium">实际 / 理论</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="t in up.byType" :key="t.key">
                  <td class="py-1.5 text-highlighted">{{ t.label }}</td>
                  <td class="py-1.5 text-right font-display">{{ t.total }}</td>
                  <td class="py-1.5 text-right font-display">{{ t.wins }}</td>
                  <td class="py-1.5 text-right font-display text-muted">{{ formatPercent(t.wins / t.total, 0) }} / {{ formatPercent(t.share, 0) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader :eyebrow="`${top}★ SEQUENCE`" :title="`${top}★ 出货序列`" />
        <div class="rounded-(--ui-radius) border border-default p-4">
          <div class="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span class="flex items-center gap-1.5"><i class="size-2.5 rounded-sm bg-primary" />当期 UP</span>
            <span class="flex items-center gap-1.5"><i class="size-2.5 rounded-sm bg-(--ui-text-dimmed)" />歪了</span>
            <span class="flex items-center gap-1.5"><i class="size-2.5 rounded-sm" :style="{ background: rarityVar(top) }" />常驻 / UP 未知</span>
            <span class="flex items-center gap-1.5"><i class="h-0.5 w-4 rounded-full bg-(--ui-text-highlighted)" />累计平均</span>
            <span v-if="dist" class="flex items-center gap-1.5"><i class="w-4 border-t border-dashed border-(--ui-text-muted)" />理论平均 {{ dist.mean.toFixed(1) }}{{ derived ? '（推算）' : '' }}</span>
          </div>
          <EChart :option="sequenceOption" height="280px" />
        </div>
      </section>

      <section v-if="trend.length">
        <SectionHeader eyebrow="LUCK TREND" title="欧非走势" />
        <div class="rounded-(--ui-radius) border border-default p-4">
          <p class="text-xs text-muted">
            按你每一抽当时的垫抽，累计理论上应出的 {{ top }}★ 个数，与实际出的个数对比：实际线在上方就是偏欧。<template v-if="derived">理论个数按官方数字推算，非官方。</template>
            <template v-if="trendLast">
              目前实际 <b class="text-highlighted">{{ trendLast.actual }}</b> 个，理论 {{ trendLast.expected.toFixed(1) }} 个。
            </template>
          </p>
          <EChart :option="trendOption" height="260px" />
        </div>
      </section>
    </template>
  </div>
</template>
