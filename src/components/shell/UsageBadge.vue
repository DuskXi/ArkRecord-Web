<script setup lang="ts">
import { formatNumber } from '@/lib/format'
import { useAppStore } from '@/stores/app'

defineProps<{ collapsed?: boolean }>()
const app = useAppStore()
</script>

<template>
  <ULink
    v-if="app.usage && !collapsed"
    to="/about#usage"
    class="flex items-center gap-1.5 truncate text-xs text-dimmed hover:text-muted"
    title="匿名统计的使用人数，说明见“关于”页"
  >
    <UIcon name="i-lucide-users-round" class="size-3.5 shrink-0" />
    <span class="truncate">
      <span class="font-display">{{ formatNumber(app.usage.users) }}</span> 位用户 · 今日 <span class="font-display">{{ formatNumber(app.usage.today) }}</span>
    </span>
  </ULink>
</template>
