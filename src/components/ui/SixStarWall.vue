<script setup lang="ts">
import { computed } from 'vue'
import { formatDate } from '@/lib/format'
import type { SixStarHit } from '@/lib/stats/analyze'
import CharAvatar from './CharAvatar.vue'

const props = withDefaults(defineProps<{ hits: SixStarHit[]; hardPity: number; game: 'arknights' | 'endfield'; limit?: number }>(), {
  limit: 24,
})
const shown = computed(() => props.hits.toReversed().slice(0, props.limit))
</script>

<template>
  <div v-if="shown.length" class="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-3">
    <div v-for="h in shown" :key="h.event.key" class="group">
      <div class="relative">
        <CharAvatar :char-id="h.event.itemId" :name="h.event.name" :star="6" :size="88" :game="game" class="!size-full aspect-square" />
        <span
          class="absolute top-1 right-1 rounded-sm px-1 font-display text-[11px] font-semibold text-white"
          :class="h.pity >= 75 ? 'bg-error/90' : h.pity <= 25 ? 'bg-success/90' : 'bg-black/60'"
        >
          {{ h.pity }}
        </span>
        <span
          v-if="h.event.isUp !== null"
          class="absolute bottom-1.5 left-1 rounded-sm px-1 text-[10px] font-medium text-white"
          :class="h.event.isUp ? 'bg-primary' : 'bg-zinc-600'"
        >
          {{ h.event.isUp ? 'UP' : '歪' }}
        </span>
      </div>
      <div class="mt-1 h-1 overflow-hidden rounded-full bg-elevated">
        <div class="h-full rounded-full" :style="{ width: `${Math.min(100, (h.pity / hardPity) * 100)}%`, background: 'var(--color-rarity-6)' }" />
      </div>
      <p class="mt-1 truncate text-xs font-medium text-highlighted">{{ h.event.name }}</p>
      <p class="truncate text-[10px] text-dimmed">{{ formatDate(h.event.ts) }}</p>
    </div>
  </div>
  <p v-else class="py-8 text-center text-sm text-muted">还没有 6★ 记录</p>
</template>
