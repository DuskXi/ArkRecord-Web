<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { rarityVar } from '@/lib/format'
import { akAvatarUrl, efAvatarUrl } from '@/lib/meta'
import { useAppStore } from '@/stores/app'

const props = withDefaults(
  defineProps<{ charId?: string | null; name: string; star: number; size?: number; game?: 'arknights' | 'endfield' }>(),
  { size: 48, game: 'arknights' },
)
const app = useAppStore()
const failed = ref(false)
// 虚拟列表会复用组件，换了角色要重新尝试加载
watch(
  () => props.charId,
  () => (failed.value = false),
)
const src = computed(() => {
  if (failed.value) return undefined
  return props.game === 'arknights' ? akAvatarUrl(props.charId, app.akAvatars) : efAvatarUrl(props.charId, app.efAvatars)
})
</script>

<template>
  <div
    class="relative shrink-0 overflow-hidden rounded-(--ui-radius) bg-elevated"
    :style="{ width: `${size}px`, height: `${size}px`, boxShadow: `inset 0 -3px 0 ${rarityVar(star)}` }"
    :title="`${name} · ${star}★`"
  >
    <img
      v-if="src"
      :src="src"
      :alt="name"
      loading="lazy"
      decoding="async"
      crossorigin="anonymous"
      referrerpolicy="no-referrer"
      class="size-full object-cover"
      @error="failed = true"
    />
    <span
      v-else
      class="grid size-full place-items-center px-1 text-center font-medium leading-tight text-highlighted"
      :style="{ fontSize: `${Math.max(10, size / 4.2)}px` }"
    >
      {{ name.slice(0, 4) }}
    </span>
  </div>
</template>
