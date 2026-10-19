<script setup lang="ts">
/** 侧边栏里的分段切换（厂商、游戏共用）：收起侧边栏时竖排、只显示 short 的第一个字 */
defineProps<{ items: { value: string; label: string; short: string }[]; active: string; label: string; collapsed?: boolean }>()
const emit = defineEmits<{ select: [value: string] }>()
</script>

<template>
  <div
    class="grid gap-1 rounded-(--ui-radius) border border-default bg-default p-1"
    :style="{ gridTemplateColumns: `repeat(${collapsed ? 1 : items.length}, minmax(0, 1fr))` }"
    role="radiogroup"
    :aria-label="label"
  >
    <button
      v-for="item in items"
      :key="item.value"
      type="button"
      role="radio"
      :aria-checked="active === item.value"
      class="rounded-[calc(var(--ui-radius)-2px)] px-2 py-1.5 text-xs font-medium transition-colors"
      :class="active === item.value ? 'bg-primary text-inverted shadow-sm' : 'text-muted hover:bg-elevated hover:text-highlighted'"
      @click="emit('select', item.value)"
    >
      {{ collapsed ? item.short.slice(0, 1) : item.label }}
    </button>
  </div>
</template>
