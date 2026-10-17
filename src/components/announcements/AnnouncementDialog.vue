<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { type Announcement, announcementPath } from '@/lib/announcements'
import { useAnnouncementsStore } from '@/stores/announcements'
import { useAppStore } from '@/stores/app'
import AnnouncementBody from './AnnouncementBody.vue'

/**
 * 更新后第一次打开网站时弹出的公告。等第一次访问的引导（欢迎窗口、旧数据迁移、统计选择）都结束之后才弹；
 * 正在看公告页时不弹。关掉、点了里面的链接都算全部已读。
 */
const app = useAppStore()
const store = useAnnouncementsStore()
const route = useRoute()

const open = computed(
  () => Boolean(store.plan) && !store.dismissed && app.introDone && !app.consentOpen && route.name !== undefined && route.name !== 'announcements',
)
const main = computed(() => store.plan?.main ?? null)

function stamp(a: Announcement): string {
  return a.version ? `v${a.version} · ${a.date}` : a.date
}
</script>

<template>
  <UModal
    :open="open"
    title="更新公告"
    :description="main ? stamp(main) : undefined"
    :ui="{ content: 'sm:max-w-2xl' }"
    @update:open="(value: boolean) => !value && store.dismiss()"
  >
    <template #body>
      <div v-if="main && store.plan" class="space-y-5">
        <div>
          <h2 class="text-lg font-semibold text-highlighted">{{ main.title }}</h2>
          <p class="mt-1 text-sm leading-relaxed text-muted">{{ main.summary }}</p>
        </div>
        <AnnouncementBody :announcement="main" @navigate="store.dismiss()" />
        <div v-if="store.plan.others.length" class="rounded-(--ui-radius) border border-default p-3">
          <p class="mb-2 text-xs font-medium text-muted">{{ store.plan.othersLabel }}</p>
          <ul class="space-y-1.5">
            <li v-for="a in store.plan.others" :key="a.id" class="flex items-baseline gap-2 text-sm">
              <span class="w-20 shrink-0 font-display text-xs text-dimmed">{{ a.version ? `v${a.version}` : a.date.slice(5) }}</span>
              <ULink :to="announcementPath(a.id)" class="min-w-0 text-highlighted hover:text-primary" @click="store.dismiss()">{{ a.title }}</ULink>
            </li>
          </ul>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-end gap-2">
        <UButton label="查看全部公告" icon="i-lucide-megaphone" color="neutral" variant="outline" to="/announcements" @click="store.dismiss()" />
        <UButton label="知道了" @click="store.dismiss()" />
      </div>
    </template>
  </UModal>
</template>
