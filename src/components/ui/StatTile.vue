<script setup lang="ts">
defineProps<{ label: string; value: string | number; hint?: string; icon?: string; accent?: string }>()
</script>

<template>
  <div class="relative overflow-hidden rounded-(--ui-radius) border border-default bg-default p-4">
    <div class="flex items-center justify-between gap-2">
      <p class="eyebrow">{{ label }}</p>
      <UIcon v-if="icon" :name="icon" class="size-4 text-dimmed" />
    </div>
    <p class="mt-2 font-display text-3xl font-semibold tabular-nums text-highlighted" :style="accent ? { color: accent } : undefined">
      {{ value }}
    </p>
    <!-- 最多两行（米哈游的“推算，非官方”要看得到），放不下的悬停看全文 -->
    <p v-if="hint" class="mt-1 line-clamp-2 text-xs text-muted" :title="hint">{{ hint }}</p>
    <slot />
  </div>
</template>
