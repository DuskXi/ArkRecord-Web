<script setup lang="ts">
/** 当前厂商下的游戏切换：鹰角是明日方舟 / 终末地（app.game），其他厂商是它自己的游戏（跳到各自的页面） */
import { computed } from 'vue'
import { useActiveVendor } from '@/platform/active'
import { useAppStore } from '@/stores/app'
import type { Game } from '@/lib/types'
import SegmentSwitch from './SegmentSwitch.vue'

defineProps<{ collapsed?: boolean }>()
const app = useAppStore()
const { extra, openGame } = useActiveVendor()

const HG_GAMES: { value: Game; label: string; short: string }[] = [
  { value: 'arknights', label: '明日方舟', short: '方舟' },
  { value: 'endfield', label: '终末地', short: '终末' },
]

const items = computed(() => (extra.value ? extra.value.vendor.games.map((g) => ({ value: g.id, label: g.label, short: g.short })) : HG_GAMES))
const active = computed(() => extra.value?.game.id ?? app.game)

function select(value: string) {
  const current = extra.value
  if (!current) {
    app.game = value as Game
    return
  }
  const game = current.vendor.games.find((g) => g.id === value)
  if (game) openGame(current.vendor, game)
}
</script>

<template>
  <SegmentSwitch :items="items" :active="active" label="切换游戏" :collapsed="collapsed" @select="select" />
</template>
