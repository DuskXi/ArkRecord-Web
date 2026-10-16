<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import { computed, ref } from 'vue'
import EChart from '@/components/charts/EChart.vue'
import PlannerPanel from '@/components/PlannerPanel.vue'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { useChartTheme } from '@/composables/useChartTheme'
import { formatDate, formatDateTime, formatPercent } from '@/lib/format'
import { computeInsights } from '@/lib/stats/insights'
import { useRecordsStore } from '@/stores/records'

const records = useRecordsStore()
const palette = useChartTheme()
const s = computed(() => computeInsights(records.events, records.analysis))
const hard = computed(() => records.model.hardPity)

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

// ── 6★ 出货序列 ──
const sequenceOption = computed<EChartsOption>(() => {
  const p = palette.value
  const seq = s.value.sixSequence
  const mean = records.model.dist.mean
  return {
    grid: { left: 36, right: 12, top: 16, bottom: seq.length > 40 ? 56 : 28 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const list = params as unknown as { dataIndex: number }[]
        const item = seq[list[0]?.dataIndex ?? 0]
        if (!item) return ''
        const e = item.hit.event
        const tag = e.isUp === null ? '' : e.isUp ? '（UP）' : '（歪）'
        return `<b>${e.name}</b>${tag}<br/>${e.poolName}<br/>${formatDateTime(e.ts)}<br/>第 <b>${item.hit.pity}</b> 抽 · 累计平均 ${item.runningAvg.toFixed(1)}`
      },
    },
    xAxis: {
      type: 'category',
      data: seq.map((_, i) => String(i + 1)),
      axisLine: { lineStyle: { color: p.border } },
      axisLabel: { color: p.dimmed, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      max: hard.value,
      axisLabel: { color: p.dimmed, fontSize: 11 },
      splitLine: { lineStyle: { color: p.border, type: 'dashed' } },
    },
    dataZoom: seq.length > 40 ? [{ type: 'inside', startValue: seq.length - 40 }, { type: 'slider', height: 18, bottom: 6, borderColor: p.border, textStyle: { color: p.dimmed } }] : undefined,
    series: [
      {
        name: '抽数',
        type: 'bar',
        barMaxWidth: 18,
        data: seq.map(({ hit }) => ({
          value: hit.pity,
          itemStyle: {
            color: hit.event.isUp === null ? p.rarity6 : hit.event.isUp ? p.primary : p.dimmed,
            borderRadius: [2, 2, 0, 0],
          },
        })),
        markLine: {
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: p.muted, type: 'dashed' },
          data: [{ yAxis: Number(mean.toFixed(2)) }],
        },
      },
      {
        name: '累计平均',
        type: 'line',
        data: seq.map((x) => Number(x.runningAvg.toFixed(2))),
        symbol: 'none',
        smooth: true,
        lineStyle: { color: p.text, width: 2 },
        itemStyle: { color: p.text },
      },
    ],
  }
})

// ── 十连 ──
const tenRows = computed(() => {
  const t = s.value.tenByBest
  const total = s.value.tenPulls || 1
  return ([6, 5, 4] as const).map((star) => ({
    star,
    label: star === 6 ? '出了 6★' : star === 5 ? '最高 5★' : '最高 4★',
    count: t[star] + (star === 4 ? t[3] : 0),
    share: (t[star] + (star === 4 ? t[3] : 0)) / total,
  }))
})

// ── 抽卡时段 ──
const hourOption = computed<EChartsOption>(() => {
  const p = palette.value
  const data: [number, number, number][] = []
  let max = 1
  s.value.hourWeek.forEach((row, d) =>
    row.forEach((n, h) => {
      data.push([h, d, n])
      max = Math.max(max, n)
    }),
  )
  return {
    grid: { left: 40, right: 8, top: 8, bottom: 24 },
    tooltip: {
      formatter: (params) => {
        const [h, d, n] = (params as unknown as { value: [number, number, number] }).value
        return `${WEEKDAYS[d]} ${h}:00–${h + 1}:00<br/><b>${n}</b> 抽`
      },
    },
    xAxis: {
      type: 'category',
      data: Array.from({ length: 24 }, (_, h) => String(h)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: p.dimmed, fontSize: 10, interval: 2 },
      splitArea: { show: false },
    },
    yAxis: {
      type: 'category',
      data: WEEKDAYS,
      inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: p.dimmed, fontSize: 11 },
    },
    visualMap: { show: false, min: 0, max, inRange: { color: [p.bg, p.primary] } },
    series: [{ type: 'heatmap', data, itemStyle: { borderColor: p.bg, borderWidth: 2, borderRadius: 2 } }],
  }
})

const peakHour = computed(() => {
  let best = { d: 0, h: 0, n: 0 }
  s.value.hourWeek.forEach((row, d) => row.forEach((n, h) => n > best.n && (best = { d, h, n })))
  return best.n ? `${WEEKDAYS[best.d]} ${best.h}:00` : null
})

// ── 收集 ──
const collectionTab = ref('6')
const collectionTabs = computed(() => {
  const c = s.value.collection
  const tabs = [
    { label: `6★ · ${c.filter((x) => x.star === 6 && !x.weapon).length}`, value: '6' },
    { label: `5★ · ${c.filter((x) => x.star === 5 && !x.weapon).length}`, value: '5' },
  ]
  if (c.some((x) => x.weapon)) tabs.push({ label: `武器 · ${c.filter((x) => x.weapon).length}`, value: 'w' })
  return tabs
})
const collectionShown = computed(() =>
  s.value.collection.filter((x) => (collectionTab.value === 'w' ? x.weapon : !x.weapon && String(x.star) === collectionTab.value)),
)
</script>

<template>
  <PageShell id="stats" title="高级统计" eyebrow="INSIGHTS">
    <div v-if="!records.analysis.total" class="mt-10">
      <UEmpty icon="i-lucide-telescope" title="还没有可以统计的记录" description="同步或导入记录后，这里会显示十连、纪录、收集、抽卡时段与抽卡规划。" />
    </div>
    <div v-else class="space-y-10">
      <section>
        <SectionHeader index="01" eyebrow="RECORDS" title="纪录" />
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div v-if="s.fastestSix" class="flex items-center gap-3 rounded-(--ui-radius) border border-default p-4">
            <CharAvatar :char-id="s.fastestSix.event.itemId" :name="s.fastestSix.event.name" :star="6" :size="52" :game="records.game" />
            <div class="min-w-0">
              <p class="eyebrow">FASTEST 6★</p>
              <p class="truncate font-medium text-highlighted">{{ s.fastestSix.event.name }}</p>
              <p class="text-xs text-muted">第 <b class="font-display text-success">{{ s.fastestSix.pity }}</b> 抽 · {{ formatDate(s.fastestSix.event.ts) }}</p>
            </div>
          </div>
          <div v-if="s.slowestSix" class="flex items-center gap-3 rounded-(--ui-radius) border border-default p-4">
            <CharAvatar :char-id="s.slowestSix.event.itemId" :name="s.slowestSix.event.name" :star="6" :size="52" :game="records.game" />
            <div class="min-w-0">
              <p class="eyebrow">LONGEST WAIT</p>
              <p class="truncate font-medium text-highlighted">{{ s.slowestSix.event.name }}</p>
              <p class="text-xs text-muted">第 <b class="font-display text-error">{{ s.slowestSix.pity }}</b> 抽 · {{ formatDate(s.slowestSix.event.ts) }}</p>
            </div>
          </div>
          <div v-if="s.firstSix" class="flex items-center gap-3 rounded-(--ui-radius) border border-default p-4">
            <CharAvatar :char-id="s.firstSix.event.itemId" :name="s.firstSix.event.name" :star="6" :size="52" :game="records.game" />
            <div class="min-w-0">
              <p class="eyebrow">FIRST 6★ ON RECORD</p>
              <p class="truncate font-medium text-highlighted">{{ s.firstSix.event.name }}</p>
              <p class="text-xs text-muted">{{ formatDate(s.firstSix.event.ts) }} · {{ s.firstSix.event.poolName }}</p>
            </div>
          </div>
          <div v-if="s.bestTen" class="rounded-(--ui-radius) border border-default p-4">
            <p class="eyebrow">BEST TEN-PULL</p>
            <div class="mt-2 flex -space-x-2">
              <CharAvatar
                v-for="e in s.bestTen.events.filter((x) => x.star >= 5).toSorted((a, b) => b.star - a.star)"
                :key="e.key"
                :char-id="e.itemId"
                :name="e.name"
                :star="e.star"
                :size="36"
                :game="records.game"
                class="ring-2 ring-(--ui-bg)"
              />
            </div>
            <p class="mt-1.5 truncate text-xs text-muted">{{ formatDate(s.bestTen.ts) }} · {{ s.bestTen.poolName }}</p>
          </div>
          <div v-if="s.busiestDay" class="rounded-(--ui-radius) border border-default p-4">
            <p class="eyebrow">BUSIEST DAY</p>
            <p class="mt-1 font-display text-2xl font-semibold text-highlighted">{{ s.busiestDay.pulls }} <span class="text-sm font-normal text-muted">抽</span></p>
            <p class="text-xs text-muted">{{ s.busiestDay.day.replaceAll('-', '/') }} · 出了 {{ s.busiestDay.six }} 个 6★</p>
          </div>
          <div v-if="s.luckiestDay" class="rounded-(--ui-radius) border border-default p-4">
            <p class="eyebrow">LUCKIEST DAY</p>
            <p class="mt-1 font-display text-2xl font-semibold" style="color: var(--color-rarity-6)">{{ s.luckiestDay.six }} <span class="text-sm font-normal text-muted">个 6★</span></p>
            <p class="text-xs text-muted">{{ s.luckiestDay.day.replaceAll('-', '/') }} · 共 {{ s.luckiestDay.pulls }} 抽</p>
          </div>
          <div class="rounded-(--ui-radius) border border-default p-4">
            <p class="eyebrow">5★+ INTERVAL</p>
            <p class="mt-1 font-display text-2xl font-semibold text-highlighted">
              {{ s.fivePlus.avgGap === null ? '—' : s.fivePlus.avgGap.toFixed(1) }} <span class="text-sm font-normal text-muted">抽</span>
            </p>
            <p class="text-xs text-muted">平均每个 5★ 及以上；最长 {{ s.fivePlus.longestGap }} 抽，当前已 {{ s.fivePlus.current }} 抽</p>
          </div>
          <div class="rounded-(--ui-radius) border border-default p-4">
            <p class="eyebrow">TEN-PULLS</p>
            <p class="mt-1 font-display text-2xl font-semibold text-highlighted">
              {{ s.tenPulls }} <span class="text-sm font-normal text-muted">次十连 · {{ s.singles }} 次单抽</span>
            </p>
            <p class="text-xs text-muted">其中 {{ s.multiSixTens.length }} 次十连出了 2 个及以上 6★</p>
          </div>
        </div>
      </section>

      <section v-if="s.sixSequence.length">
        <SectionHeader index="02" eyebrow="6★ SEQUENCE" title="6★ 出货序列" />
        <div class="rounded-(--ui-radius) border border-default p-4">
          <div class="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span class="flex items-center gap-1.5"><i class="size-2.5 rounded-sm bg-primary" />当期 UP</span>
            <span class="flex items-center gap-1.5"><i class="size-2.5 rounded-sm bg-(--ui-text-dimmed)" />歪了</span>
            <span class="flex items-center gap-1.5"><i class="size-2.5 rounded-sm" style="background: var(--color-rarity-6)" />常驻 / UP 未知</span>
            <span class="flex items-center gap-1.5"><i class="h-0.5 w-4 rounded-full bg-(--ui-text-highlighted)" />累计平均</span>
            <span class="flex items-center gap-1.5"><i class="w-4 border-t border-dashed border-(--ui-text-muted)" />理论平均 {{ records.model.dist.mean.toFixed(1) }}</span>
          </div>
          <EChart :option="sequenceOption" height="280px" />
        </div>
      </section>

      <section class="grid gap-3 lg:grid-cols-5">
        <div class="rounded-(--ui-radius) border border-default p-4 lg:col-span-2">
          <SectionHeader index="03" eyebrow="TEN-PULLS" title="十连" class="!mb-3" />
          <p v-if="!s.tenPulls" class="py-6 text-center text-sm text-muted">没有十连记录</p>
          <ul v-else class="space-y-3">
            <li v-for="row in tenRows" :key="row.star">
              <div class="flex justify-between text-sm">
                <span class="text-highlighted">{{ row.label }}</span>
                <span class="font-display text-muted">{{ row.count }} 次 · {{ formatPercent(row.share, 1) }}</span>
              </div>
              <div class="mt-1 h-2 overflow-hidden rounded-full bg-elevated">
                <div class="h-full rounded-full" :style="{ width: `${row.share * 100}%`, background: `var(--color-rarity-${row.star})` }" />
              </div>
            </li>
          </ul>
        </div>
        <div class="rounded-(--ui-radius) border border-default p-4 lg:col-span-3">
          <SectionHeader index="04" eyebrow="WHEN YOU PULL" title="抽卡时段" class="!mb-1" />
          <p class="text-xs text-muted">北京时间<template v-if="peakHour">，最常在 <b class="text-highlighted">{{ peakHour }}</b> 前后抽卡</template></p>
          <EChart :option="hourOption" height="220px" />
        </div>
      </section>

      <section>
        <SectionHeader index="05" eyebrow="COLLECTION" title="收集">
          <UTabs v-model="collectionTab" :items="collectionTabs" :content="false" size="xs" variant="link" />
        </SectionHeader>
        <p v-if="!collectionShown.length" class="py-6 text-center text-sm text-muted">暂无</p>
        <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(4.75rem,1fr))] gap-3">
          <div v-for="c in collectionShown" :key="c.id" class="min-w-0">
            <div class="relative">
              <CharAvatar :char-id="c.itemId" :name="c.name" :star="c.star" :size="76" :game="records.game" class="!size-full aspect-square" />
              <span v-if="c.count > 1" class="absolute top-1 right-1 rounded-sm bg-black/65 px-1 font-display text-[11px] font-semibold text-white">×{{ c.count }}</span>
            </div>
            <p class="mt-1 truncate text-xs font-medium text-highlighted">{{ c.name }}</p>
            <p class="truncate text-[10px] text-dimmed">{{ formatDate(c.lastTs) }}</p>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader index="06" eyebrow="PLANNER" title="抽卡规划" />
        <PlannerPanel />
      </section>
    </div>
  </PageShell>
</template>
