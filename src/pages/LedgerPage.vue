<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { EChartsOption } from 'echarts'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EChart from '@/components/charts/EChart.vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatTile from '@/components/ui/StatTile.vue'
import { axisStyle, useChartTheme } from '@/composables/useChartTheme'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { db } from '@/lib/db'
import { dateStamp, downloadFile, toCsv } from '@/lib/download'
import { formatDate, formatDateTime, formatNumber, formatYuan } from '@/lib/format'
import {
  type LedgerSource,
  parseRecharge,
  parseStone,
  type RechargeRecord,
  type StoneRecord,
  summarizeRecharge,
  summarizeStone,
} from '@/lib/ledger'
import type { AkLedgerEntry } from '@/lib/types'
import { useAppStore } from '@/stores/app'

const app = useAppStore()
const route = useRoute()
const router = useRouter()
const palette = useChartTheme()

const account = computed(() => (app.activeAccount?.game === 'arknights' ? app.activeAccount : null))
const accountId = computed(() => account.value?.id ?? '')
const entries = useLiveQuery(
  () => (accountId.value ? db.akLedger.where('accountId').equals(accountId.value).toArray() : []),
  [accountId],
  [] as AkLedgerEntry[],
)

function parsed<T>(kind: AkLedgerEntry['kind'], parse: (raw: unknown) => T | null): T[] {
  return entries.value.flatMap((e) => (e.kind === kind ? (parse(e.raw) ?? []) : []))
}
/** 新的在前 */
const stone = computed(() => parsed('stone', parseStone).toSorted((a, b) => b.ts - a.ts))
const recharge = computed(() => parsed('recharge', parseRecharge).toSorted((a, b) => b.ts - a.ts))
const stoneSummary = computed(() => summarizeStone(stone.value))
const rechargeSummary = computed(() => summarizeRecharge(recharge.value))

const span = computed(() => {
  const all = [...stone.value, ...recharge.value].map((r) => r.ts)
  return all.length ? { first: Math.min(...all), last: Math.max(...all) } : null
})

/** 官网只能查到最近 30 天：太久没同步时提醒 */
const DAY = 86_400_000
const staleDays = computed(() => {
  const at = account.value?.lastSyncAt
  return at ? Math.floor((Date.now() - at) / DAY) : null
})

const TABS = [
  { label: '源石', value: 'stone', icon: 'i-lucide-gem' },
  { label: '充值', value: 'recharge', icon: 'i-lucide-receipt-text' },
]
const tab = computed({
  get: () => (route.query.tab === 'recharge' ? 'recharge' : 'stone'),
  set: (value: string) => void router.replace({ query: { ...route.query, tab: value } }),
})

const SOURCE_LABEL: Record<LedgerSource, string> = { legacy: '旧版', api: '官网' }

/** 导出当前 Tab 的明细（时间从早到晚） */
function exportCsv() {
  // 文件名只用 ASCII：部分浏览器会把含中文的下载文件名替换成“download”
  const uid = account.value?.uid ?? ''
  if (tab.value === 'stone') {
    const rows = stone.value.toReversed().map((r) => [formatDateTime(r.ts), r.operation, r.before, r.after, r.change, r.platform, SOURCE_LABEL[r.source]])
    downloadFile(`ArkRecord_${uid}_originium_${dateStamp()}.csv`, toCsv(['时间', '操作', '变化前', '变化后', '变化', '平台', '来源'], rows), 'text/csv')
  } else {
    const rows = recharge.value.toReversed().map((r) => [formatDateTime(r.ts), r.productName, r.yuan, r.platform, r.orderId, SOURCE_LABEL[r.source]])
    downloadFile(`ArkRecord_${uid}_recharge_${dateStamp()}.csv`, toCsv(['时间', '商品', '金额（元）', '平台', '订单号', '来源'], rows), 'text/csv')
  }
}

// ── 源石 ──
/** 相邻两条记录相隔太久（比如旧版数据和新接口数据之间）时断开折线，不把空白期画成一条平线 */
const GAP = 45 * DAY

const balanceOption = computed<EChartsOption>(() => {
  const p = palette.value
  const points = stone.value.filter((r) => r.after !== null).toReversed()
  const data: { value: [number, number | null]; record?: StoneRecord }[] = []
  points.forEach((r, i) => {
    const prev = points[i - 1]
    if (prev && r.ts - prev.ts > GAP) data.push({ value: [prev.ts + 1, null] })
    data.push({ value: [r.ts, r.after], record: r })
  })
  return {
    grid: { left: 52, right: 16, top: 16, bottom: points.length > 60 ? 56 : 28 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const r = data[(params as unknown as { dataIndex: number }[])[0]?.dataIndex ?? 0]?.record
        if (!r) return ''
        const change = r.change === null ? '' : `（${r.change > 0 ? '+' : ''}${r.change}）`
        return `${formatDateTime(r.ts)}<br/>${r.operation}${change}<br/>之后 <b>${r.after}</b> 源石`
      },
    },
    xAxis: { type: 'time', ...axisStyle(p), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle(p), minInterval: 1 },
    dataZoom: points.length > 60 ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }] : undefined,
    series: [
      {
        type: 'line',
        step: 'end',
        showSymbol: points.length <= 60,
        symbolSize: 5,
        data: data.map((d) => d.value),
        lineStyle: { color: p.primary, width: 2 },
        itemStyle: { color: p.primary },
        areaStyle: { color: p.primary, opacity: 0.08 },
      },
    ],
  }
})

const maxOperation = computed(() => Math.max(1, ...stoneSummary.value.byOperation.map((o) => Math.max(o.spent, o.gained))))

const stoneColumns: TableColumn<StoneRecord>[] = [
  { accessorKey: 'ts', header: '时间', meta: { class: { td: 'w-40 font-display text-xs text-muted tabular-nums' } } },
  { accessorKey: 'operation', header: '操作' },
  { accessorKey: 'change', header: '变化', meta: { class: { td: 'w-24 text-right', th: 'text-right' } } },
  { accessorKey: 'after', header: '之后', meta: { class: { td: 'w-24 text-right', th: 'text-right' } } },
  { accessorKey: 'source', header: '来源', meta: { class: { td: 'w-20 max-sm:hidden', th: 'max-sm:hidden' } } },
]

// ── 充值 ──
const monthOption = computed<EChartsOption>(() => {
  const p = palette.value
  const months = rechargeSummary.value.byMonth
  return {
    grid: { left: 56, right: 16, top: 16, bottom: months.length > 24 ? 56 : 28 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const m = months[(params as unknown as { dataIndex: number }[])[0]?.dataIndex ?? 0]
        return m ? `${m.month}<br/><b>${formatYuan(m.yuan)}</b>，${m.count} 笔` : ''
      },
    },
    xAxis: { type: 'category', data: months.map((m) => m.month), ...axisStyle(p) },
    yAxis: { type: 'value', ...axisStyle(p), axisLabel: { color: p.dimmed, fontSize: 11, formatter: (v: number) => `¥${v}` } },
    dataZoom: months.length > 24 ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }] : undefined,
    series: [{ type: 'bar', barMaxWidth: 28, data: months.map((m) => m.yuan), itemStyle: { color: p.primary, borderRadius: [3, 3, 0, 0] } }],
  }
})

const rechargeColumns: TableColumn<RechargeRecord>[] = [
  { accessorKey: 'ts', header: '时间', meta: { class: { td: 'w-40 font-display text-xs text-muted tabular-nums' } } },
  { accessorKey: 'productName', header: '商品' },
  { accessorKey: 'yuan', header: '金额', meta: { class: { td: 'w-28 text-right', th: 'text-right' } } },
  { accessorKey: 'platform', header: '平台', meta: { class: { td: 'w-20 max-sm:hidden', th: 'max-sm:hidden' } } },
  { accessorKey: 'orderId', header: '订单号', meta: { class: { td: 'max-lg:hidden font-mono text-xs text-dimmed', th: 'max-lg:hidden' } } },
  { accessorKey: 'source', header: '来源', meta: { class: { td: 'w-20 max-sm:hidden', th: 'max-sm:hidden' } } },
]
</script>

<template>
  <PageShell id="ledger" title="源石与充值" eyebrow="ORIGINIUM" :scoped="false">
    <template #actions>
      <UButton
        v-if="app.game === 'arknights' && entries.length"
        label="导出 CSV"
        icon="i-lucide-download"
        color="neutral"
        variant="ghost"
        class="max-sm:hidden"
        @click="exportCsv"
      />
    </template>
    <UEmpty
      v-if="app.game !== 'arknights'"
      icon="i-lucide-gem"
      title="终末地暂不支持源石与充值记录"
      description="官方目前没有提供终末地的查询接口。切换到明日方舟可以查看源石与充值记录。"
      :actions="[{ label: '切换到明日方舟', icon: 'i-lucide-repeat', onClick: () => (app.game = 'arknights') }]"
      class="mt-16"
    />
    <div v-else class="space-y-6">
      <UAlert
        :color="staleDays !== null && staleDays >= 20 ? 'warning' : 'neutral'"
        variant="subtle"
        icon="i-lucide-calendar-clock"
        title="官网只能查询最近 30 天的记录"
        :description="`源石最多 100 条、充值最多 30 条。每次同步都会把新记录保存在本地，旧版 ArkRecord 的记录也已合并，所以这里比官网看到的更全；建议至少每个月同步一次。${
          staleDays !== null && staleDays >= 20 ? `距离上次同步已经 ${staleDays} 天了。` : ''
        }`"
      />

      <UEmpty
        v-if="!entries.length"
        icon="i-lucide-gem"
        title="还没有源石与充值记录"
        description="同步时会自动读取官网最近 30 天的源石与充值记录；旧版 ArkRecord 的记录可以在“数据”页导入。"
        :actions="[{ label: '导入旧数据', icon: 'i-lucide-upload', color: 'neutral', variant: 'outline', to: '/data' }]"
        class="mt-10"
      />

      <template v-else>
        <section class="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatTile label="累计充值" :value="formatYuan(rechargeSummary.yuan)" :hint="`${rechargeSummary.count} 笔订单`" icon="i-lucide-receipt-text" />
          <StatTile
            label="当前源石"
            :value="stoneSummary.balance === null ? '—' : formatNumber(stoneSummary.balance)"
            :hint="stone[0] ? `截至 ${formatDate(stone[0].ts)}` : '没有源石记录'"
            icon="i-lucide-gem"
          />
          <StatTile label="消耗源石" :value="formatNumber(stoneSummary.spent)" :hint="`获得 ${formatNumber(stoneSummary.gained)}`" icon="i-lucide-flame" />
          <StatTile
            label="记录"
            :value="formatNumber(entries.length)"
            :hint="span ? `${formatDate(span.first)} – ${formatDate(span.last)}` : ''"
            icon="i-lucide-calendar-range"
          />
        </section>

        <UTabs v-model="tab" :items="TABS" :content="false" class="w-full" />

        <template v-if="tab === 'stone'">
          <p v-if="!stone.length" class="rounded-(--ui-radius) border border-default p-4 text-sm text-muted">还没有源石记录。</p>
          <template v-else>
            <section class="grid gap-3 xl:grid-cols-3">
              <div class="rounded-(--ui-radius) border border-default p-4 xl:col-span-2">
                <SectionHeader eyebrow="BALANCE" title="源石数量变化" class="!mb-1" />
                <p class="text-xs text-muted">每条记录之后的源石数量（北京时间）</p>
                <EChart :option="balanceOption" height="260px" />
              </div>
              <div class="rounded-(--ui-radius) border border-default p-4">
                <SectionHeader eyebrow="BY OPERATION" title="按操作汇总" class="!mb-3" />
                <ul class="space-y-2.5">
                  <li v-for="o in stoneSummary.byOperation.slice(0, 8)" :key="o.operation" class="text-sm">
                    <div class="flex items-baseline justify-between gap-2">
                      <span class="truncate text-highlighted">{{ o.operation || '（未知操作）' }}</span>
                      <span class="shrink-0 font-display text-xs tabular-nums text-muted">
                        {{ o.count }} 次<template v-if="o.spent"> · <span class="text-error">-{{ formatNumber(o.spent) }}</span></template
                        ><template v-if="o.gained"> · <span class="text-success">+{{ formatNumber(o.gained) }}</span></template>
                      </span>
                    </div>
                    <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-elevated">
                      <div
                        class="h-full rounded-full"
                        :class="o.spent >= o.gained ? 'bg-error/70' : 'bg-success/70'"
                        :style="{ width: `${(Math.max(o.spent, o.gained) / maxOperation) * 100}%` }"
                      />
                    </div>
                  </li>
                </ul>
              </div>
            </section>

            <UTable
              :data="stone"
              :columns="stoneColumns"
              virtualize
              sticky
              class="h-[calc(100dvh-24rem)] min-h-96 rounded-(--ui-radius) border border-default"
              :ui="{ td: 'py-1.5' }"
            >
              <template #ts-cell="{ row }">{{ formatDateTime(row.original.ts) }}</template>
              <template #operation-cell="{ row }">
                <span class="text-highlighted">{{ row.original.operation }}</span>
              </template>
              <template #change-cell="{ row }">
                <span
                  v-if="row.original.change !== null"
                  class="font-display font-semibold tabular-nums"
                  :class="row.original.change > 0 ? 'text-success' : row.original.change < 0 ? 'text-error' : 'text-muted'"
                >
                  {{ row.original.change > 0 ? '+' : '' }}{{ row.original.change }}
                </span>
              </template>
              <template #after-cell="{ row }">
                <span class="font-display tabular-nums">{{ row.original.after ?? '—' }}</span>
              </template>
              <template #source-cell="{ row }">
                <UBadge :label="SOURCE_LABEL[row.original.source]" :color="row.original.source === 'api' ? 'primary' : 'neutral'" variant="subtle" size="sm" />
              </template>
            </UTable>
          </template>
        </template>

        <template v-else>
          <p v-if="!recharge.length" class="rounded-(--ui-radius) border border-default p-4 text-sm text-muted">还没有充值记录。</p>
          <template v-else>
            <section class="grid gap-3 xl:grid-cols-3">
              <div class="rounded-(--ui-radius) border border-default p-4 xl:col-span-2">
                <SectionHeader eyebrow="MONTHLY" title="每月充值" class="!mb-1" />
                <p class="text-xs text-muted">按北京时间的自然月汇总</p>
                <EChart :option="monthOption" height="260px" />
              </div>
              <div class="rounded-(--ui-radius) border border-default p-4">
                <SectionHeader eyebrow="BY PRODUCT" title="按商品汇总" class="!mb-3" />
                <ul class="divide-y divide-default text-sm">
                  <li v-for="p in rechargeSummary.byProduct.slice(0, 10)" :key="p.productName" class="flex items-baseline justify-between gap-2 py-1.5">
                    <span class="truncate text-highlighted">{{ p.productName || '（未知商品）' }}</span>
                    <span class="shrink-0 font-display text-xs tabular-nums text-muted">{{ p.count }} 笔 · {{ formatYuan(p.yuan) }}</span>
                  </li>
                </ul>
              </div>
            </section>

            <UTable
              :data="recharge"
              :columns="rechargeColumns"
              virtualize
              sticky
              class="h-[calc(100dvh-24rem)] min-h-96 rounded-(--ui-radius) border border-default"
              :ui="{ td: 'py-1.5' }"
            >
              <template #ts-cell="{ row }">{{ formatDateTime(row.original.ts) }}</template>
              <template #productName-cell="{ row }">
                <span class="text-highlighted">{{ row.original.productName }}</span>
              </template>
              <template #yuan-cell="{ row }">
                <span class="font-display font-semibold tabular-nums">{{ row.original.yuan === null ? '—' : formatYuan(row.original.yuan) }}</span>
              </template>
              <template #platform-cell="{ row }">
                <span class="text-muted">{{ row.original.platform ?? '—' }}</span>
              </template>
              <template #source-cell="{ row }">
                <UBadge :label="SOURCE_LABEL[row.original.source]" :color="row.original.source === 'api' ? 'primary' : 'neutral'" variant="subtle" size="sm" />
              </template>
            </UTable>
          </template>
        </template>
      </template>
    </div>
  </PageShell>
</template>
