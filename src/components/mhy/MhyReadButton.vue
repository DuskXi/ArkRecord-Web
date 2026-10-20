<script setup lang="ts">
/**
 * 米哈游页面右上角的“读取”（相当于鹰角页面的“同步”按钮，由 MhyGamePage 通过 provideRecords 交给 PageShell）：
 * 点开是读取面板（MhySyncPanel）。读取、等待读取在关掉面板后也继续，按钮上显示进度。
 */
import { computed, ref } from 'vue'
import { useRecords } from '@/composables/useRecords'
import type { MhyGame } from '@/lib/mhy/types'
import MhySyncPanel from './MhySyncPanel.vue'
import { useMhyReader } from './reader'

const records = useRecords()
const reader = useMhyReader()
const game = computed(() => records.game as MhyGame)
const state = computed(() => reader.states[game.value])
const open = ref(false)

const label = computed(() => {
  const s = state.value
  if (s.running && s.progress) return `${s.progress.stage}${s.progress.detail ? ` · ${s.progress.detail}` : ''}`
  if (s.waiting) return '等待读取'
  return '读取'
})
</script>

<template>
  <UButton
    icon="i-lucide-download"
    :loading="state.running || state.waiting"
    :label="label"
    :color="state.problem ? 'warning' : 'primary'"
    variant="soft"
    class="max-w-64"
    :ui="{ label: 'truncate' }"
    @click="open = true"
  />
  <UModal v-model:open="open" :title="`读取${records.profile.recordName}`" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <MhySyncPanel :game="game" />
    </template>
  </UModal>
</template>
