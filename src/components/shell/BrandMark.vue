<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'

defineProps<{ collapsed?: boolean }>()
const app = useAppStore()
const subtitle = computed(() => (app.game === 'endfield' ? 'ENDFIELD ARCHIVE' : 'RHODES ISLAND ARCHIVE'))
</script>

<template>
  <RouterLink to="/" class="flex min-w-0 items-center gap-2.5">
    <span class="grid size-8 shrink-0 place-items-center rounded-(--ui-radius) bg-primary text-inverted">
      <UIcon name="i-lucide-archive" class="size-4.5" />
    </span>
    <span v-if="!collapsed" class="min-w-0 leading-tight">
      <span class="block font-display text-[15px] font-semibold tracking-[0.12em] text-highlighted">ARKRECORD</span>
      <span class="block truncate font-display text-[9px] tracking-[0.22em] text-dimmed">{{ subtitle }}</span>
    </span>
  </RouterLink>
</template>
