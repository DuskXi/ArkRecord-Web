<script setup lang="ts">
import { computed } from 'vue'
import { isInternalHref, parseInline } from '@/lib/announcements'

/** 公告正文的一行：只支持 **加粗** 和 [文字](链接)，不用 v-html */
const props = defineProps<{ text: string }>()
const emit = defineEmits<{ navigate: [] }>()
const segments = computed(() => parseInline(props.text))
</script>

<template>
  <span>
    <template v-for="(s, i) in segments" :key="i">
      <b v-if="s.type === 'bold'" class="font-semibold text-highlighted">{{ s.text }}</b>
      <ULink
        v-else-if="s.type === 'link'"
        :to="s.href"
        :target="isInternalHref(s.href) ? undefined : '_blank'"
        class="font-medium text-primary hover:underline"
        @click="emit('navigate')"
      >{{ s.text }}</ULink>
      <template v-else>{{ s.text }}</template>
    </template>
  </span>
</template>
