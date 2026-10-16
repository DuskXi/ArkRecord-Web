<script setup lang="ts">
import type { TableColumn, TableRow } from '@nuxt/ui'
import { computed, ref } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDateTime, formatNumber, rarityTextVar } from '@/lib/format'
import type { PullEvent } from '@/lib/stats/events'
import { useRecordsStore } from '@/stores/records'

const records = useRecordsStore()

const stars = ref<number[]>([6, 5, 4, 3])
const pool = ref<string | undefined>()
const search = ref('')

const pityByKey = computed(() => new Map(records.analysis.hits.map((h) => [h.event.key, h.pity])))
const poolOptions = computed(() => [
  { label: '全部卡池', value: undefined },
  ...records.analysis.pools.map((p) => ({ label: p.poolName, value: p.poolId ?? `name:${p.poolName}` })),
])

interface Row extends PullEvent {
  batch: number
}

const rows = computed<Row[]>(() => {
  const q = search.value.trim()
  let batch = 0
  let lastTs = -1
  const out: Row[] = []
  for (let i = records.events.length - 1; i >= 0; i--) {
    const e = records.events[i]!
    if (e.ts !== lastTs) {
      batch++
      lastTs = e.ts
    }
    if (!stars.value.includes(e.star)) continue
    if (pool.value && (e.poolId ?? `name:${e.poolName}`) !== pool.value) continue
    if (q && !e.name.includes(q) && !e.poolName.includes(q)) continue
    out.push({ ...e, batch })
  }
  return out
})

const columns: TableColumn<Row>[] = [
  { accessorKey: 'ts', header: '时间', meta: { class: { td: 'w-40 font-display text-xs text-muted tabular-nums' } } },
  { accessorKey: 'name', header: '干员' },
  { accessorKey: 'star', header: '星级', meta: { class: { td: 'w-24' } } },
  { accessorKey: 'poolName', header: '卡池', meta: { class: { th: 'max-sm:hidden', td: 'max-sm:hidden' } } },
  { id: 'pity', header: '保底', meta: { class: { td: 'w-20 text-right', th: 'text-right' } } },
]

// 同一次十连（同一时间）的记录用相同底色，便于区分
const tableMeta = { class: { tr: (row: TableRow<Row>) => (row.original.batch % 2 ? 'bg-elevated/40' : '') } }

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
            v-for="s in [6, 5, 4, 3]"
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
        <UInput v-model="search" icon="i-lucide-search" placeholder="搜索干员或卡池" size="sm" class="w-48" />
        <span class="ml-auto font-display text-xs text-muted">{{ formatNumber(rows.length) }} 条</span>
      </div>

      <UTable
        :data="rows"
        :columns="columns"
        virtualize
        sticky
        class="h-[calc(100dvh-14rem)] rounded-(--ui-radius) border border-default"
        :ui="{ td: 'py-1.5' }"
        :meta="tableMeta"
        empty="没有符合条件的记录"
      >
        <template #ts-cell="{ row }">{{ formatDateTime(row.original.ts) }}</template>
        <template #name-cell="{ row }">
          <div class="flex items-center gap-2.5">
            <CharAvatar :char-id="row.original.itemId" :name="row.original.name" :star="row.original.star" :size="32" :game="records.game" />
            <span class="truncate font-medium" :style="row.original.star >= 5 ? { color: rarityTextVar(row.original.star) } : undefined">
              {{ row.original.name }}
            </span>
            <UBadge v-if="row.original.isNew" label="NEW" color="error" variant="subtle" size="sm" class="font-display" />
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
          <span class="font-display text-sm tracking-tight" :style="{ color: rarityTextVar(row.original.star) }">
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
