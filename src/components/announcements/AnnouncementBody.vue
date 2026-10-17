<script setup lang="ts">
import { type Announcement, announcementPath, findAnnouncement } from '@/lib/announcements'
import InlineText from './InlineText.vue'

/** 一篇公告的正文：重点卡片 + 分节列表。弹窗和公告页共用 */
defineProps<{ announcement: Announcement }>()
const emit = defineEmits<{ navigate: [] }>()

function refLabel(id: string): string {
  const a = findAnnouncement(id)
  return a?.version ? `${a.version} 详情` : '详情'
}
</script>

<template>
  <div class="space-y-5 text-sm">
    <ul v-if="announcement.highlights?.length" class="grid gap-3 sm:grid-cols-2">
      <li v-for="h in announcement.highlights" :key="h.title" class="flex gap-3 rounded-(--ui-radius) border border-default bg-elevated/40 p-3">
        <span class="grid size-8 shrink-0 place-items-center rounded-(--ui-radius) bg-primary/10 text-primary">
          <UIcon :name="h.icon" class="size-4" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="font-medium text-highlighted">{{ h.title }}</p>
          <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ h.text }}</p>
          <p v-if="h.to || h.ref" class="mt-1.5 flex flex-wrap gap-x-3 text-xs">
            <ULink v-if="h.to" :to="h.to" class="font-medium text-primary hover:underline" @click="emit('navigate')">去看看</ULink>
            <ULink v-if="h.ref" :to="announcementPath(h.ref)" class="text-muted hover:text-primary" @click="emit('navigate')">{{ refLabel(h.ref) }}</ULink>
          </p>
        </div>
      </li>
    </ul>

    <section v-for="s in announcement.sections" :key="s.title">
      <h3 class="mb-1.5 font-semibold text-highlighted">{{ s.title }}</h3>
      <ul class="list-disc space-y-1 pl-5 leading-relaxed text-muted marker:text-dimmed">
        <li v-for="(item, i) in s.items" :key="i"><InlineText :text="item" @navigate="emit('navigate')" /></li>
      </ul>
    </section>
  </div>
</template>
