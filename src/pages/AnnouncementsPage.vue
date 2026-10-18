<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AnnouncementBody from '@/components/announcements/AnnouncementBody.vue'
import PageShell from '@/components/shell/PageShell.vue'
import { ANNOUNCEMENTS, KIND_LABEL } from '@/lib/announcements'
import { useAnnouncementsStore } from '@/stores/announcements'

/** 全部更新公告，新的在前。最新一篇和没看过的默认展开；地址里的 #id 指向某一篇时展开并滚动过去 */
const store = useAnnouncementsStore()
const route = useRoute()

// 打开这个页面就算全部已读；这次访问里仍然把刚才没看过的标成“新”
const fresh = new Set(store.seen === null ? ANNOUNCEMENTS.slice(0, 1).map((a) => a.id) : store.unread.map((a) => a.id))
onMounted(() => store.dismiss())

const expanded = ref(new Set<string>([...ANNOUNCEMENTS.slice(0, 1).map((a) => a.id), ...fresh]))

function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

watch(
  () => route.hash,
  async (hash) => {
    const id = decodeURIComponent(hash.replace(/^#/, ''))
    if (!id || !ANNOUNCEMENTS.some((a) => a.id === id)) return
    expanded.value = new Set([...expanded.value, id])
    await nextTick()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  },
  { immediate: true },
)
</script>

<template>
  <PageShell id="announcements" title="更新公告" eyebrow="ANNOUNCEMENTS" :require-account="false" :sync="false" :scoped="false">
    <div class="mx-auto max-w-3xl space-y-4">
      <p class="text-sm leading-relaxed text-muted">
        正式更新（新功能、重要变化）会在更新后第一次打开网站时弹出；小更新（修复、小改进）只写在这里，不弹窗。这里按时间倒序列出全部公告，点标题展开或收起。
      </p>

      <article
        v-for="a in ANNOUNCEMENTS"
        :id="a.id"
        :key="a.id"
        class="scroll-mt-4 rounded-(--ui-radius) border bg-default"
        :class="fresh.has(a.id) ? 'border-primary/50' : 'border-default'"
      >
        <button type="button" class="flex w-full items-start gap-3 p-4 text-left" :aria-expanded="expanded.has(a.id)" @click="toggle(a.id)">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <UBadge :label="a.version ? `v${a.version}` : '公告'" color="neutral" variant="outline" size="sm" class="font-display" />
              <UBadge :label="KIND_LABEL[a.kind]" :color="a.kind === 'major' ? 'primary' : 'neutral'" variant="subtle" size="sm" />
              <UBadge v-if="fresh.has(a.id)" label="新" color="error" variant="solid" size="sm" />
              <span class="font-display text-xs text-dimmed">{{ a.date }}</span>
            </div>
            <h2 class="mt-1.5 font-semibold text-highlighted">{{ a.title }}</h2>
            <p class="mt-1 text-sm leading-relaxed text-muted" :class="expanded.has(a.id) ? '' : 'line-clamp-2'">{{ a.summary }}</p>
          </div>
          <UIcon :name="expanded.has(a.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="mt-1 size-4 shrink-0 text-dimmed" />
        </button>
        <div v-if="expanded.has(a.id)" class="border-t border-default p-4">
          <AnnouncementBody :announcement="a" />
        </div>
      </article>
    </div>
  </PageShell>
</template>
