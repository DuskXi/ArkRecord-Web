<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'
import { useSyncStore } from '@/stores/sync'

const app = useAppStore()
const sync = useSyncStore()

const label = computed(() => {
  if (sync.running && sync.progress) return `${sync.progress.stage}${sync.progress.detail ? ` · ${sync.progress.detail}` : ''}`
  return '同步'
})

const lastSync = computed(() => {
  const ts = app.activeAccount?.lastSyncAt
  if (!ts) return '尚未同步'
  return `上次同步 ${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(ts)}`
})

function run() {
  if (!app.activeAccount) {
    app.loginOpen = true
    return
  }
  void sync.sync(app.activeAccount)
}
</script>

<template>
  <UTooltip :text="lastSync">
    <UButton
      icon="i-lucide-refresh-cw"
      :loading="sync.running"
      :label="label"
      color="primary"
      variant="soft"
      class="max-w-64"
      :ui="{ label: 'truncate' }"
      @click="run"
    />
  </UTooltip>
</template>
