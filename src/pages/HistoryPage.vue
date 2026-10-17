<script setup lang="ts">
import type { TableColumn, TableRow } from '@nuxt/ui'
import { useIntersectionObserver, useLocalStorage } from '@vueuse/core'
import { computed, ref, useTemplateRef, watch } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDateTime, formatDayHeader, formatNumber, formatPercent, formatTime, rarityTextVar, rarityVar } from '@/lib/format'
import { dayKey } from '@/lib/stats/analyze'
import type { PullEvent } from '@/lib/stats/events'
import type { GiftEvent } from '@/lib/stats/gifts'
import { type Batch, bestStar, groupBatches } from '@/lib/stats/insights'
import { useRecordsStore } from '@/stores/records'

const records = useRecordsStore()

const view = useLocalStorage<'batch' | 'list'>('arkrecord:history-view', 'batch')
/** 终末地没有 3★ */
const starOptions = computed(() => (records.game === 'endfield' ? [6, 5, 4] : [6, 5, 4, 3]))
const stars = ref<number[]>([6, 5, 4, 3])
const pool = ref<string | undefined>()
const search = ref('')
const onlyNew = ref(false)
/** 终末地的赠送条目（信物赠礼等）：不是抽出来的，单独标出，不计入汇总 */
const showGifts = useLocalStorage('arkrecord:history-gifts', true)

const pityByKey = computed(() => new Map(records.analysis.hits.map((h) => [h.event.key, h.pity])))
const poolOptions = computed(() => [
  { label: '全部卡池', value: undefined },
  ...records.analysis.pools.map((p) => ({ label: p.poolName, value: p.poolId ?? `name:${p.poolName}` })),
])

function inPool(e: Pick<PullEvent, 'poolId' | 'poolName'>): boolean {
  return !pool.value || (e.poolId ?? `name:${e.poolName}`) === pool.value
}

function matches(e: PullEvent): boolean {
  const q = search.value.trim()
  return (
    stars.value.includes(e.star) &&
    inPool(e) &&
    (!onlyNew.value || e.isNew) &&
    (!q || e.name.includes(q) || e.poolName.includes(q))
  )
}

const filtered = computed(() => records.events.filter(matches))

function giftMatches(g: GiftEvent): boolean {
  const q = search.value.trim()
  return (
    showGifts.value &&
    !onlyNew.value &&
    (!g.star || stars.value.includes(g.star)) &&
    inPool(g) &&
    (!q || g.name.includes(q) || g.poolName.includes(q) || g.label.includes(q))
  )
}
const shownGifts = computed(() => records.gifts.filter(giftMatches))
function giftTitle(g: GiftEvent): string {
  return g.inferred
    ? `按规则推算：本池累计寻访 ${g.at} 次时赠送（记录里没有这一条，官方记录只保留约 90 天）。不是抽出来的，不计入统计。`
    : `${g.label}：累计寻访赠送，不是抽出来的，不计入统计。`
}

// ── 汇总 ──
const summary = computed(() => {
  const counts: Record<number, number> = { 6: 0, 5: 0, 4: 0, 3: 0 }
  let up = 0
  let off = 0
  for (const e of filtered.value) {
    counts[e.star] = (counts[e.star] ?? 0) + 1
    if (e.star === 6 && e.isUp === true) up++
    if (e.star === 6 && e.isUp === false) off++
  }
  const total = filtered.value.length
  const gifts = shownGifts.value.length
  const inferred = shownGifts.value.filter((g) => g.inferred).length
  return { total, counts, up, off, gifts, inferred, segments: [6, 5, 4, 3].map((s) => ({ star: s, share: total ? (counts[s] ?? 0) / total : 0 })) }
})

// ── 按批次（十连 / 单抽）查看 ──
interface DayGroup {
  day: string
  ts: number
  /** 按时间倒序：一次寻访（十连 / 单抽），或者一条赠送 */
  items: ({ type: 'batch'; key: string; batch: Batch } | { type: 'gift'; key: string; gift: GiftEvent })[]
  pulls: number
  six: number
  five: number
}

const days = computed<DayGroup[]>(() => {
  const out: DayGroup[] = []
  const batches = groupBatches(records.events.filter(inPool)).filter((b) => b.events.some(matches))
  const items: DayGroup['items'] = [
    ...batches.map((batch) => ({ type: 'batch' as const, key: batch.key, batch, ts: batch.ts, order: batch.events[0]?.order ?? 0 })),
    ...shownGifts.value.map((gift) => ({ type: 'gift' as const, key: gift.key, gift, ts: gift.ts, order: gift.order })),
  ]
    .toSorted((a, b) => b.ts - a.ts || b.order - a.order)
    .map(({ ts: _ts, order: _order, ...item }) => item)
  for (const item of items) {
    const ts = item.type === 'batch' ? item.batch.ts : item.gift.ts
    const day = dayKey(ts)
    let group = out.at(-1)
    if (!group || group.day !== day) {
      group = { day, ts, items: [], pulls: 0, six: 0, five: 0 }
      out.push(group)
    }
    group.items.push(item)
    if (item.type === 'gift') continue
    const b = item.batch
    group.pulls += b.events.length
    group.six += b.events.filter((e) => e.star === 6).length
    group.five += b.events.filter((e) => e.star === 5).length
  }
  return out
})

const PAGE = 14
const shownDays = ref(PAGE)
watch([stars, pool, search, onlyNew, showGifts, () => records.events], () => (shownDays.value = PAGE), { deep: true })
const sentinel = useTemplateRef<HTMLElement>('sentinel')
useIntersectionObserver(
  sentinel,
  ([entry]) => {
    if (entry?.isIntersecting && shownDays.value < days.value.length) shownDays.value += PAGE
  },
  { rootMargin: '600px' },
)

function batchClass(b: Batch): string {
  const best = bestStar(b)
  return best === 6 ? 'rarity-tint-6 border-[color-mix(in_oklab,var(--color-rarity-6)_45%,transparent)]' : best === 5 ? 'rarity-tint-5' : ''
}

// ── 列表 ──
/** 列表的一行：一次抽取，或者一条赠送（gift） */
type Row = Pick<PullEvent, 'key' | 'ts' | 'itemId' | 'name' | 'star' | 'poolName' | 'isNew' | 'isUp'> & { order: number; gift?: GiftEvent }
const columns: TableColumn<Row>[] = [
  { accessorKey: 'ts', header: '时间', meta: { class: { td: 'w-40 font-display text-xs text-muted tabular-nums' } } },
  { accessorKey: 'name', header: '干员' },
  { accessorKey: 'star', header: '星级', meta: { class: { td: 'w-24 max-sm:hidden', th: 'max-sm:hidden' } } },
  { accessorKey: 'poolName', header: '卡池', meta: { class: { th: 'max-md:hidden', td: 'max-md:hidden' } } },
  { id: 'pity', header: '保底', meta: { class: { td: 'w-20 text-right', th: 'text-right' } } },
]
const rows = computed<Row[]>(() =>
  [
    ...filtered.value,
    ...shownGifts.value.map((g) => ({ key: g.key, ts: g.ts, order: g.order, itemId: g.itemId, name: g.name, star: g.star, poolName: g.poolName, isNew: false, isUp: null, gift: g })),
  ].toSorted((a, b) => b.ts - a.ts || b.order - a.order),
)
const tableMeta = {
  class: { tr: (row: TableRow<Row>) => (row.original.gift ? 'bg-elevated/40' : row.original.star >= 5 ? `rarity-tint-${row.original.star}` : '') },
}

function toggleStar(s: number) {
  stars.value = stars.value.includes(s) ? stars.value.filter((x) => x !== s) : [...stars.value, s]
}
</script>

<template>
  <PageShell id="history" title="寻访记录" eyebrow="RECORDS">
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <UFieldGroup>
          <UButton
            v-for="s in starOptions"
            :key="s"
            :label="`${s}★`"
            size="sm"
            :color="stars.includes(s) ? 'primary' : 'neutral'"
            :variant="stars.includes(s) ? 'soft' : 'outline'"
            class="font-display"
            @click="toggleStar(s)"
          />
        </UFieldGroup>
        <USelectMenu v-model="pool" :items="poolOptions" value-key="value" placeholder="全部卡池" class="w-56" size="sm" />
        <UInput v-model="search" icon="i-lucide-search" placeholder="搜索干员或卡池" size="sm" class="w-44" />
        <UButton
          label="只看 NEW"
          size="sm"
          icon="i-lucide-sparkle"
          :color="onlyNew ? 'primary' : 'neutral'"
          :variant="onlyNew ? 'soft' : 'outline'"
          @click="onlyNew = !onlyNew"
        />
        <UButton
          v-if="records.gifts.length"
          label="赠送"
          size="sm"
          icon="i-lucide-gift"
          :color="showGifts ? 'primary' : 'neutral'"
          :variant="showGifts ? 'soft' : 'outline'"
          title="累计寻访赠送的信物等：不是抽出来的，不计入统计"
          @click="showGifts = !showGifts"
        />
        <UTabs
          v-model="view"
          :items="[
            { label: '十连', value: 'batch', icon: 'i-lucide-layout-grid' },
            { label: '列表', value: 'list', icon: 'i-lucide-list' },
          ]"
          :content="false"
          size="xs"
          class="ml-auto"
        />
      </div>

      <!-- 汇总 -->
      <div class="rounded-(--ui-radius) border border-default p-4">
        <div class="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p class="eyebrow">SHOWING</p>
            <p class="font-display text-2xl font-semibold text-highlighted">{{ formatNumber(summary.total) }} <span class="text-sm font-normal text-muted">抽</span></p>
          </div>
          <div v-for="s in starOptions" :key="s" class="min-w-16">
            <p class="font-display text-xs font-semibold" :style="{ color: rarityTextVar(s) }">{{ s }}★</p>
            <p class="font-display text-lg font-semibold text-highlighted">
              {{ summary.counts[s] ?? 0 }}
              <span class="text-xs font-normal text-muted">{{ summary.total ? formatPercent((summary.counts[s] ?? 0) / summary.total, s >= 5 ? 2 : 1) : '' }}</span>
            </p>
          </div>
          <div v-if="summary.up + summary.off" class="text-xs text-muted">
            6★ 中 <b class="text-primary">{{ summary.up }}</b> 个 UP，<b class="text-highlighted">{{ summary.off }}</b> 个歪
          </div>
          <div v-if="summary.gifts" class="text-xs text-muted">
            另有赠送 <b class="text-highlighted">{{ summary.gifts }}</b> 个<template v-if="summary.inferred">（其中 {{ summary.inferred }} 个按规则推算）</template>，不是抽出来的，不计入上面的统计
          </div>
        </div>
        <div class="mt-3 flex h-1.5 overflow-hidden rounded-full bg-elevated">
          <div v-for="seg in summary.segments" :key="seg.star" :style="{ width: `${seg.share * 100}%`, background: rarityVar(seg.star) }" />
        </div>
      </div>

      <!-- 按十连查看 -->
      <template v-if="view === 'batch'">
        <UEmpty v-if="!days.length" icon="i-lucide-search-x" title="没有符合条件的记录" class="py-10" />
        <section v-for="d in days.slice(0, shownDays)" :key="d.day">
          <header class="sticky top-0 z-10 -mx-1 flex flex-wrap items-baseline gap-x-3 bg-default/90 px-1 py-2 backdrop-blur">
            <h3 class="text-sm font-semibold text-highlighted">{{ formatDayHeader(d.ts) }}</h3>
            <p class="font-display text-xs text-muted">
              {{ d.pulls }} 抽
              <span v-if="d.six" :style="{ color: rarityTextVar(6) }"> · 6★ ×{{ d.six }}</span>
              <span v-if="d.five" :style="{ color: rarityTextVar(5) }"> · 5★ ×{{ d.five }}</span>
            </p>
          </header>
          <div class="space-y-2">
            <template v-for="item in d.items" :key="item.key">
              <article
                v-if="item.type === 'gift'"
                class="flex items-center gap-3 rounded-(--ui-radius) border border-dashed border-default bg-elevated/40 p-2.5 sm:gap-4 sm:p-3"
                :title="giftTitle(item.gift)"
              >
                <div class="w-16 shrink-0 sm:w-28">
                  <p class="font-display text-sm font-semibold text-highlighted tabular-nums">{{ formatTime(item.gift.ts) }}</p>
                  <p class="text-[11px] text-muted">{{ item.gift.inferred ? '推算' : '赠送' }}</p>
                  <p class="mt-0.5 line-clamp-2 text-[11px] leading-tight text-dimmed" :title="item.gift.poolName">{{ item.gift.poolName }}</p>
                </div>
                <CharAvatar
                  v-if="item.gift.copy"
                  :char-id="item.gift.itemId"
                  :name="item.gift.name"
                  :star="item.gift.star"
                  :size="44"
                  :game="records.game"
                  class="shrink-0"
                />
                <div v-else class="grid size-11 shrink-0 place-items-center rounded-(--ui-radius) bg-elevated ring-1 ring-default">
                  <UIcon :name="item.gift.kind === 'gift_intel_book' ? 'i-lucide-book-open' : 'i-lucide-gift'" class="size-6 text-muted" />
                </div>
                <div class="min-w-0">
                  <p class="flex flex-wrap items-center gap-1.5 text-sm">
                    <span class="font-medium text-highlighted">{{ item.gift.label }}</span>
                    <span v-if="item.gift.copy" :style="{ color: rarityTextVar(item.gift.star) }">{{ item.gift.name }}</span>
                    <UBadge :label="item.gift.inferred ? '推算' : '累计寻访赠送'" :color="item.gift.inferred ? 'warning' : 'neutral'" variant="subtle" size="sm" />
                  </p>
                  <p class="mt-0.5 text-[11px] text-dimmed">
                    {{ item.gift.inferred ? `本池累计寻访 ${item.gift.at} 次，按规则应赠送；官方记录里没有这一条` : '不是抽出来的' }}，不计入统计
                  </p>
                </div>
              </article>
              <article
                v-else
                class="flex gap-3 rounded-(--ui-radius) border border-default p-2.5 sm:gap-4 sm:p-3"
                :class="batchClass(item.batch)"
              >
                <div class="w-16 shrink-0 sm:w-28">
                  <p class="font-display text-sm font-semibold text-highlighted tabular-nums">{{ formatTime(item.batch.ts) }}</p>
                  <p class="text-[11px] text-muted">{{ item.batch.kind === 'ten' ? '十连' : item.batch.kind === 'single' ? '单抽' : `${item.batch.events.length} 抽` }}</p>
                  <p class="mt-0.5 line-clamp-2 text-[11px] leading-tight text-dimmed" :title="item.batch.poolName">{{ item.batch.poolName }}</p>
                </div>
                <div class="grid min-w-0 flex-1 grid-cols-5 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
                  <div v-for="e in item.batch.events" :key="e.key" class="min-w-0 transition-opacity" :class="matches(e) ? '' : 'opacity-25 grayscale'">
                    <div class="relative">
                      <CharAvatar
                        :char-id="e.itemId"
                        :name="e.name"
                        :star="e.star"
                        :size="56"
                        :game="records.game"
                        class="aspect-square !size-full sm:!size-14"
                        :class="e.star === 6 ? 'ring-2 ring-(--color-rarity-6) ring-offset-1 ring-offset-(--ui-bg)' : ''"
                      />
                      <span
                        v-if="pityByKey.get(e.key)"
                        class="absolute top-0.5 right-0.5 rounded-sm px-1 font-display text-[10px] font-semibold text-white"
                        :class="pityByKey.get(e.key)! / records.model.hardPity >= 0.75 ? 'bg-error/90' : pityByKey.get(e.key)! / records.model.hardPity <= 0.25 ? 'bg-success/90' : 'bg-black/65'"
                      >
                        {{ pityByKey.get(e.key) }}
                      </span>
                      <span v-if="e.isNew" class="absolute top-1 left-1 size-1.5 rounded-full bg-error ring-2 ring-(--ui-bg)" title="NEW" />
                      <span
                        v-if="e.star === 6 && e.isUp !== null"
                        class="absolute bottom-1 left-0.5 rounded-sm px-1 text-[9px] font-medium text-white"
                        :class="e.isUp ? 'bg-primary' : 'bg-zinc-600'"
                      >
                        {{ e.isUp ? 'UP' : '歪' }}
                      </span>
                    </div>
                    <p
                      class="mt-0.5 hidden w-14 truncate text-center text-[10px] sm:block"
                      :class="e.star >= 5 ? 'font-medium' : 'text-dimmed'"
                      :style="e.star >= 5 ? { color: rarityTextVar(e.star) } : undefined"
                    >
                      {{ e.name }}
                    </p>
                  </div>
                </div>
              </article>
            </template>
          </div>
        </section>
        <div ref="sentinel" class="h-px" />
        <p v-if="days.length && shownDays >= days.length" class="py-4 text-center text-xs text-dimmed">没有更早的记录了</p>
      </template>

      <!-- 列表 -->
      <UTable
        v-else
        :data="rows"
        :columns="columns"
        virtualize
        sticky
        class="h-[calc(100dvh-20rem)] min-h-96 rounded-(--ui-radius) border border-default"
        :ui="{ td: 'py-1.5' }"
        :meta="tableMeta"
        empty="没有符合条件的记录"
      >
        <template #ts-cell="{ row }">{{ formatDateTime(row.original.ts) }}</template>
        <template #name-cell="{ row }">
          <div class="flex items-center gap-2.5">
            <CharAvatar :char-id="row.original.itemId" :name="row.original.name" :star="row.original.star" :size="32" :game="records.game" />
            <span class="truncate" :class="row.original.star >= 5 ? 'font-semibold' : 'font-medium'" :style="row.original.star >= 5 ? { color: rarityTextVar(row.original.star) } : undefined">
              {{ row.original.name }}
            </span>
            <UBadge v-if="row.original.isNew" label="NEW" color="error" variant="subtle" size="sm" class="font-display" />
            <UBadge
              v-if="row.original.gift"
              :label="row.original.gift.inferred ? '推算赠送' : row.original.gift.label"
              :color="row.original.gift.inferred ? 'warning' : 'neutral'"
              variant="subtle"
              size="sm"
              :title="giftTitle(row.original.gift)"
            />
            <UBadge
              v-if="row.original.star === 6 && row.original.isUp !== null"
              :label="row.original.isUp ? 'UP' : '歪'"
              :color="row.original.isUp ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
            />
          </div>
        </template>
        <template #star-cell="{ row }">
          <span v-if="row.original.gift" class="text-xs text-dimmed">赠送</span>
          <span v-else class="font-display text-sm tracking-tight" :style="{ color: rarityTextVar(row.original.star) }">
            {{ '★'.repeat(row.original.star) }}
          </span>
        </template>
        <template #poolName-cell="{ row }">
          <span class="text-muted">{{ row.original.poolName }}</span>
        </template>
        <template #pity-cell="{ row }">
          <span v-if="pityByKey.get(row.original.key)" class="font-display font-semibold tabular-nums text-highlighted">
            {{ pityByKey.get(row.original.key) }}
          </span>
        </template>
      </UTable>
    </div>
  </PageShell>
</template>
