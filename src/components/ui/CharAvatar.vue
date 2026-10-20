<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { rarityVar } from '@/lib/format'
import { akAvatarUrl, efAvatarUrl } from '@/lib/meta'
import { useAppStore } from '@/stores/app'

const props = withDefaults(
  /** game：头像按哪个游戏的数据取；没有头像数据的游戏（米哈游）只显示名字 */
  defineProps<{ charId?: string | null; name: string; star: number; size?: number; game?: string }>(),
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
  if (props.game === 'arknights') return akAvatarUrl(props.charId, app.akAvatars)
  if (props.game === 'endfield') return efAvatarUrl(props.charId, app.efAvatars)
  return undefined
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
