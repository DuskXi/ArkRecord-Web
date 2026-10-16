<script setup lang="ts">
import { useAppStore } from '@/stores/app'
import type { Game } from '@/lib/types'

defineProps<{ collapsed?: boolean }>()
const app = useAppStore()

const games: { value: Game; label: string; short: string }[] = [
  { value: 'arknights', label: '明日方舟', short: '方舟' },
  { value: 'endfield', label: '终末地', short: '终末' },
]
</script>

<template>
  <div
    class="grid gap-1 rounded-(--ui-radius) border border-default bg-default p-1"
    :class="collapsed ? 'grid-cols-1' : 'grid-cols-2'"
    role="radiogroup"
    aria-label="切换游戏"
  >
    <button
      v-for="g in games"
      :key="g.value"
      type="button"
      role="radio"
      :aria-checked="app.game === g.value"
      class="rounded-[calc(var(--ui-radius)-2px)] px-2 py-1.5 text-xs font-medium transition-colors"
      :class="app.game === g.value ? 'bg-primary text-inverted shadow-sm' : 'text-muted hover:bg-elevated hover:text-highlighted'"
      @click="app.game = g.value"
    >
      {{ collapsed ? g.short.slice(0, 1) : g.label }}
    </button>
  </div>
</template>
