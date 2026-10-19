<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { EXTRA_GAMES } from '@/platform'
import { useAppStore } from '@/stores/app'
import type { Game } from '@/lib/types'

defineProps<{ collapsed?: boolean }>()
const app = useAppStore()
const route = useRoute()
const router = useRouter()

const games: { value: Game; label: string; short: string }[] = [
  { value: 'arknights', label: '明日方舟', short: '方舟' },
  { value: 'endfield', label: '终末地', short: '终末' },
]

/** 只有桌面版才有的游戏（原神等，见 src/platform/index.ts）：有自己的页面，不改 app.game */
const activeExtra = computed(() => EXTRA_GAMES.find((g) => route.path === g.to || route.path.startsWith(`${g.to}/`)))

function selectGame(value: Game) {
  app.game = value
  if (activeExtra.value) void router.push('/')
}
</script>

<template>
  <div
    class="grid gap-1 rounded-(--ui-radius) border border-default bg-default p-1"
    :style="{ gridTemplateColumns: `repeat(${collapsed ? 1 : games.length + EXTRA_GAMES.length}, minmax(0, 1fr))` }"
    role="radiogroup"
    aria-label="切换游戏"
  >
    <button
      v-for="g in games"
      :key="g.value"
      type="button"
      role="radio"
      :aria-checked="!activeExtra && app.game === g.value"
      class="rounded-[calc(var(--ui-radius)-2px)] px-2 py-1.5 text-xs font-medium transition-colors"
      :class="!activeExtra && app.game === g.value ? 'bg-primary text-inverted shadow-sm' : 'text-muted hover:bg-elevated hover:text-highlighted'"
      @click="selectGame(g.value)"
    >
      {{ collapsed ? g.short.slice(0, 1) : g.label }}
    </button>
    <button
      v-for="g in EXTRA_GAMES"
      :key="g.id"
      type="button"
      role="radio"
      :aria-checked="activeExtra?.id === g.id"
      class="rounded-[calc(var(--ui-radius)-2px)] px-2 py-1.5 text-xs font-medium transition-colors"
      :class="activeExtra?.id === g.id ? 'bg-primary text-inverted shadow-sm' : 'text-muted hover:bg-elevated hover:text-highlighted'"
      @click="router.push(g.to)"
    >
      {{ collapsed ? g.short.slice(0, 1) : g.label }}
    </button>
  </div>
</template>
