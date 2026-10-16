<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDate, rarityTextVar } from '@/lib/format'
import { akCodexItems, buildCodex, type CodexEntry, efCodexItems, PROFESSION_LABEL, summarizeCodex } from '@/lib/stats/codex'
import { useAppStore } from '@/stores/app'
import { useRecordsStore } from '@/stores/records'

const app = useAppStore()
const records = useRecordsStore()

const weapon = computed(() => records.weaponScope)
const noun = computed(() => (weapon.value ? '武器' : '干员'))
const title = computed(() => `${noun.value}图鉴`)

const items = computed(() => {
  if (records.game === 'arknights') return app.meta ? akCodexItems(app.meta) : []
  return app.efMeta ? efCodexItems(app.efMeta, weapon.value) : []
})
const codex = computed(() => buildCodex(items.value, records.events))
const summary = computed(() => summarizeCodex(codex.value).filter((s) => s.total))

// ── 筛选 ──
const stars = ref<number[]>([])
const status = ref<'all' | 'owned' | 'missing'>('all')
const profession = ref<string | undefined>()
const search = ref('')
/** 明日方舟里只能通过活动、兑换所等途径获得的干员，寻访记录里不会出现，默认不显示 */
const showOther = useLocalStorage('arkrecord:codex-other', false)
const sort = ref<'default' | 'count' | 'recent'>('default')

const starOptions = computed(() => [...new Set(codex.value.map((c) => c.star))].toSorted((a, b) => b - a))
const professionOptions = computed(() => [
  { label: '全部职业', value: undefined },
  ...Object.entries(PROFESSION_LABEL).map(([value, label]) => ({ label, value })),
])
const otherCount = computed(() => codex.value.filter((c) => !c.gacha).length)

function toggleStar(s: number) {
  stars.value = stars.value.includes(s) ? stars.value.filter((x) => x !== s) : [...stars.value, s]
}

const shown = computed(() => {
  const q = search.value.trim()
  const list = codex.value.filter(
    (c) =>
      (showOther.value || c.gacha) &&
      (!stars.value.length || stars.value.includes(c.star)) &&
      (status.value === 'all' || (status.value === 'owned') === c.count > 0) &&
      (!profession.value || c.profession === profession.value) &&
      (!q || c.name.includes(q)),
  )
  if (sort.value === 'count') return list.toSorted((a, b) => b.count - a.count || b.star - a.star)
  if (sort.value === 'recent') return list.toSorted((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0) || b.star - a.star)
  return list
})

function caption(c: CodexEntry): string {
  if (c.count) return `${formatDate(c.lastTs!)}`
  return c.gacha ? '未抽到' : (c.approach ?? '其他途径')
}
function detail(c: CodexEntry): string {
  const lines = [`${c.name} · ${c.star}★${c.profession ? ` · ${PROFESSION_LABEL[c.profession] ?? c.profession}` : ''}`]
  if (c.count) {
    lines.push(`寻访中抽到 ${c.count} 次${c.up ? `（其中 UP ${c.up} 次）` : ''}`)
    lines.push(c.firstTs === c.lastTs ? `获得于 ${formatDate(c.firstTs!)}` : `首次 ${formatDate(c.firstTs!)}，最近 ${formatDate(c.lastTs!)}`)
  } else {
    lines.push(c.gacha ? '寻访记录里没有' : `获得方式：${c.approach ?? '其他途径'}，不会出现在寻访记录里`)
  }
  return lines.join('\n')
}
</script>

<template>
  <PageShell id="codex" :title="title" eyebrow="CODEX">
    <div class="space-y-5">
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        :title="`图鉴只根据寻访记录统计，和账号里实际拥有的${noun}不一定一致`"
      >
        <template #description>
          <p class="leading-relaxed">
            {{
              records.game === 'arknights'
                ? '公开招募、活动赠送、兑换所、剧情奖励等途径获得的干员'
                : weapon
                  ? '活动、商店、剧情奖励等途径获得的武器'
                  : '剧情、活动赠送等途径获得的干员'
            }}，以及官方只保留 90 天、没有被本站保存下来的早期寻访记录，这里都无法统计，所以“未抽到”不代表账号里没有。
          </p>
          <p class="mt-1 leading-relaxed text-dimmed">计划中：上传森空岛 App 的{{ noun }}列表截图，识别后同步账号里实际拥有的{{ noun }}。</p>
        </template>
      </UAlert>

      <section class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div v-for="s in summary" :key="s.star" class="rounded-(--ui-radius) border border-default p-3">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-display text-sm font-semibold" :style="{ color: rarityTextVar(s.star) }">{{ s.star }}★</span>
            <span class="font-display text-sm tabular-nums text-muted">
              <b class="text-lg text-highlighted">{{ s.owned }}</b> / {{ s.total }}
            </span>
          </div>
          <UProgress :model-value="s.owned" :max="Math.max(1, s.total)" size="sm" class="mt-2" />
        </div>
      </section>

      <div class="flex flex-wrap items-center gap-2">
        <UFieldGroup>
          <UButton
            v-for="s in starOptions"
            :key="s"
            :label="`${s}★`"
            size="sm"
            :color="stars.includes(s) ? 'primary' : 'neutral'"
            :variant="stars.includes(s) ? 'soft' : 'outline'"
            class="font-display"
            @click="toggleStar(s)"
          />
        </UFieldGroup>
        <UTabs
          v-model="status"
          :items="[
            { label: '全部', value: 'all' },
            { label: '已抽到', value: 'owned' },
            { label: '未抽到', value: 'missing' },
          ]"
          :content="false"
          size="xs"
        />
        <USelect v-if="records.game === 'arknights'" v-model="profession" :items="professionOptions" placeholder="全部职业" size="sm" class="w-28" />
        <UInput v-model="search" icon="i-lucide-search" :placeholder="`搜索${noun}`" size="sm" class="w-36" />
        <UTabs
          v-model="sort"
          :items="[
            { label: '按星级', value: 'default' },
            { label: '按次数', value: 'count' },
            { label: '按最近', value: 'recent' },
          ]"
          :content="false"
          size="xs"
          variant="link"
        />
        <USwitch
          v-if="otherCount"
          v-model="showOther"
          size="sm"
          :label="`显示其他途径获得的干员（${otherCount}）`"
          description="活动、兑换所、集成战略等，不会出现在寻访记录里"
          class="ml-auto max-w-80"
        />
      </div>

      <p v-if="!items.length" class="py-10 text-center text-sm text-muted">正在加载{{ noun }}列表…</p>
      <p v-else-if="!shown.length" class="py-10 text-center text-sm text-muted">没有符合条件的{{ noun }}</p>
      <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(4.75rem,1fr))] gap-x-3 gap-y-4">
        <div v-for="c in shown" :key="c.id" class="min-w-0" :title="detail(c)">
          <div class="relative transition" :class="c.count ? '' : 'opacity-35 grayscale'">
            <CharAvatar :char-id="c.id.startsWith('name:') ? null : c.id" :name="c.name" :star="c.star" :size="76" :game="records.game" class="pointer-events-none aspect-square !size-full" />
            <span v-if="c.count > 1" class="absolute top-1 right-1 rounded-sm bg-black/65 px-1 font-display text-[11px] font-semibold text-white">×{{ c.count }}</span>
          </div>
          <p class="mt-1 truncate text-xs font-medium" :class="c.count ? 'text-highlighted' : 'text-muted'">{{ c.name }}</p>
          <p class="truncate text-[10px] text-dimmed">{{ caption(c) }}</p>
        </div>
      </div>
    </div>
  </PageShell>
</template>
