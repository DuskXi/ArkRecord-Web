<script setup lang="ts">
defineProps<{ index?: string; eyebrow: string; title: string }>()
</script>

<template>
  <div class="mb-3 flex items-end justify-between gap-3">
    <div>
      <p class="eyebrow">
        <span v-if="index" class="text-primary">// {{ index }}</span>
        {{ eyebrow }}
      </p>
      <h2 class="text-lg font-semibold text-highlighted">{{ title }}</h2>
    </div>
    <slot />
  </div>
</template>
