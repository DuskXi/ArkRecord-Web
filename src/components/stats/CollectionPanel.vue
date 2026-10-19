<script setup lang="ts">
import { computed, ref } from 'vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDate } from '@/lib/format'
import { useRecords } from '@/composables/useRecords'

const records = useRecords()
const star = ref('6')
const sort = ref<'count' | 'recent'>('count')

const all = computed(() => records.insights.collection)
const tabs = computed(() => [
  { label: `6★ · ${all.value.filter((c) => c.star === 6).length}`, value: '6' },
  { label: `5★ · ${all.value.filter((c) => c.star === 5).length}`, value: '5' },
])
const shown = computed(() => {
  const list = all.value.filter((c) => String(c.star) === star.value)
  return sort.value === 'count' ? list : list.toSorted((a, b) => b.lastTs - a.lastTs)
})
const duplicates = computed(() => shown.value.reduce((a, c) => a + c.count - 1, 0))
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <UTabs v-model="star" :items="tabs" :content="false" size="xs" />
      <UTabs
        v-model="sort"
        :items="[
          { label: '按次数', value: 'count' },
          { label: '按最近获得', value: 'recent' },
        ]"
        :content="false"
        size="xs"
        variant="link"
      />
      <p class="ml-auto text-xs text-muted">
        {{ shown.length }} {{ records.weaponScope ? '件不同的武器' : '名不同的干员' }}，重复获得 {{ duplicates }} 次
      </p>
    </div>
    <p v-if="!shown.length" class="py-10 text-center text-sm text-muted">暂无</p>
    <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(4.75rem,1fr))] gap-3">
      <div v-for="c in shown" :key="c.id" class="min-w-0">
        <div class="relative">
          <CharAvatar :char-id="c.itemId" :name="c.name" :star="c.star" :size="76" :game="records.game" class="aspect-square !size-full" />
          <span v-if="c.count > 1" class="absolute top-1 right-1 rounded-sm bg-black/65 px-1 font-display text-[11px] font-semibold text-white">×{{ c.count }}</span>
          <span v-if="c.up" class="absolute bottom-1.5 left-1 rounded-sm bg-primary px-1 text-[9px] font-medium text-white">UP×{{ c.up }}</span>
        </div>
        <p class="mt-1 truncate text-xs font-medium text-highlighted">{{ c.name }}</p>
        <p class="truncate text-[10px] text-dimmed">{{ formatDate(c.lastTs) }}</p>
      </div>
    </div>
  </div>
</template>
