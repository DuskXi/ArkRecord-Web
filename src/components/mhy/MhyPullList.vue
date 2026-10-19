<script setup lang="ts">
/** 原神 / 星铁的记录列表：从新到旧，可以按卡池筛选，每页 50 条。时间是接口原样的区服当地时间 */
import { computed, ref, watch } from 'vue'
import { compareMhyPulls } from '@/lib/mhy/stats'
import { MHY_POOLS, type MhyGame, type MhyPull, poolInfo } from '@/lib/mhy/types'

const props = defineProps<{ game: MhyGame; pulls: readonly MhyPull[] }>()

const PAGE_SIZE = 50
const pool = ref('all')
const page = ref(1)

const poolItems = computed(() => [{ label: '全部卡池', value: 'all' }, ...MHY_POOLS[props.game].map((p) => ({ label: p.name, value: p.type }))])
const filtered = computed(() => {
  const list = pool.value === 'all' ? props.pulls : props.pulls.filter((p) => p.pool === pool.value)
  return list.toSorted((a, b) => compareMhyPulls(b, a))
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)))
const visible = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
watch([pool, () => props.pulls], () => (page.value = 1))

const rankClass = (rank: number) => (rank === 5 ? 'text-amber-500 font-semibold' : rank === 4 ? 'text-violet-500 font-medium' : 'text-default')
const poolName = (p: MhyPull) => poolInfo(props.game, p.pool)?.name ?? p.pool
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <USelect v-model="pool" :items="poolItems" class="w-48" />
      <p class="text-sm text-muted">共 {{ filtered.length }} 条</p>
    </div>

    <div class="overflow-x-auto rounded-(--ui-radius) border border-default">
      <table class="w-full text-sm">
        <thead class="bg-elevated/50 text-left text-xs text-muted">
          <tr>
            <th class="px-3 py-2 font-medium">时间</th>
            <th class="px-3 py-2 font-medium">卡池</th>
            <th class="px-3 py-2 font-medium">名称</th>
            <th class="px-3 py-2 font-medium">类型</th>
            <th class="px-3 py-2 text-right font-medium">星级</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="p in visible" :key="p.id">
            <td class="px-3 py-1.5 whitespace-nowrap tabular-nums text-muted">{{ p.time }}</td>
            <td class="px-3 py-1.5 whitespace-nowrap text-muted">{{ poolName(p) }}</td>
            <td class="px-3 py-1.5" :class="rankClass(p.rank)">{{ p.name }}</td>
            <td class="px-3 py-1.5 whitespace-nowrap text-muted">{{ p.itemType }}</td>
            <td class="px-3 py-1.5 text-right tabular-nums" :class="rankClass(p.rank)">{{ p.rank }}★</td>
          </tr>
          <tr v-if="!visible.length">
            <td colspan="5" class="px-3 py-6 text-center text-muted">这个卡池还没有记录</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="pageCount > 1" class="flex items-center justify-end gap-2 text-sm">
      <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="sm" :disabled="page <= 1" aria-label="上一页" @click="page--" />
      <span class="tabular-nums text-muted">{{ page }} / {{ pageCount }}</span>
      <UButton icon="i-lucide-chevron-right" color="neutral" variant="ghost" size="sm" :disabled="page >= pageCount" aria-label="下一页" @click="page++" />
    </div>
  </div>
</template>
