<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/app'

/** name、subtitle：其他厂商的游戏页面上由 App.vue 传入（如 GAMERECORD / GENSHIN ARCHIVE），不跟着上次的鹰角游戏 */
const props = defineProps<{ collapsed?: boolean; name?: string; subtitle?: string }>()
const app = useAppStore()
const subtitle = computed(() => props.subtitle ?? (app.game === 'endfield' ? 'ENDFIELD ARCHIVE' : 'RHODES ISLAND ARCHIVE'))
</script>

<template>
  <RouterLink to="/" class="flex min-w-0 items-center gap-2.5">
    <span class="grid size-8 shrink-0 place-items-center rounded-(--ui-radius) bg-primary text-inverted">
      <UIcon name="i-lucide-archive" class="size-4.5" />
    </span>
    <span v-if="!collapsed" class="min-w-0 leading-tight">
      <span class="block font-display text-[15px] font-semibold tracking-[0.12em] text-highlighted">{{ name ?? 'ARKRECORD' }}</span>
      <span class="block truncate font-display text-[9px] tracking-[0.22em] text-dimmed">{{ subtitle }}</span>
    </span>
  </RouterLink>
</template>
