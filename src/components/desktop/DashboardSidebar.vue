<script setup lang="ts">
/** 总览页的侧边栏（厂商切换下面）：四款游戏，点一下进那款游戏。只在桌面版里 */
import type { Game } from '@/lib/types'
import { useAppStore } from '@/stores/app'
import { useRouter } from 'vue-router'
import { DESKTOP_GAMES, type DesktopGame } from './games'

defineProps<{ game: string; collapsed?: boolean }>()
const app = useAppStore()
const router = useRouter()

function open(game: DesktopGame) {
  if (game.vendor === '鹰角') app.game = game.id as Game
  void router.push(game.to)
}
</script>

<template>
  <nav aria-label="总览导航" class="mt-2 space-y-1">
    <UButton
      v-for="g in DESKTOP_GAMES"
      :key="g.id"
      :label="collapsed ? undefined : g.label"
      :icon="g.vendor === '鹰角' ? 'i-lucide-shield' : 'i-lucide-sparkles'"
      color="neutral"
      variant="ghost"
      block
      :square="collapsed"
      :class="collapsed ? '' : 'justify-start'"
      :aria-label="g.label"
      @click="open(g)"
    />
  </nav>
</template>
