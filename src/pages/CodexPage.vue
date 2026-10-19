<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, ref } from 'vue'
import RosterImportDialog from '@/components/roster/RosterImportDialog.vue'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDate, formatDateTime, rarityTextVar } from '@/lib/format'
import { clearRoster } from '@/lib/roster'
import { akCodexItems, applyRoster, buildCodex, type CodexEntry, efCodexItems, isOwned, PROFESSION_LABEL, summarizeCodex } from '@/lib/stats/codex'
import { useAppStore } from '@/stores/app'
import { useRecords } from '@/composables/useRecords'

const app = useAppStore()
const records = useRecords()

const weapon = computed(() => records.weaponScope)
const noun = computed(() => (weapon.value ? '武器' : '干员'))
const title = computed(() => `${noun.value}图鉴`)

const items = computed(() => {
  if (records.game === 'arknights') return app.meta ? akCodexItems(app.meta) : []
  return app.efMeta ? efCodexItems(app.efMeta, weapon.value) : []
})
/** 终末地干员有潜能（份数 − 1），明日方舟截图里暂时读不出潜能 */
const potentialGame = computed(() => records.game === 'endfield' && !weapon.value)
const codex = computed(() =>
  applyRoster(buildCodex(items.value, records.events, records.gifts), weapon.value ? [] : records.roster, records.events, records.gifts, potentialGame.value),
)

// ── 截图识别 ──
const importOpen = ref(false)
const canImport = computed(() => !weapon.value)
const rosterInfo = computed(() => {
  if (weapon.value || !records.roster.length) return null
  const latest = Math.max(...records.roster.map((r) => r.observedAt))
  const conflicts = codex.value.filter((c) => c.owned?.conflict).length
  return { count: records.roster.length, latest, conflicts }
})
const confirmClear = ref(false)
async function clearImported() {
  if (!confirmClear.value) {
    confirmClear.value = true
    setTimeout(() => (confirmClear.value = false), 4000)
    return
  }
  confirmClear.value = false
  await clearRoster(records.accountId)
}
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
      (status.value === 'all' || (status.value === 'owned') === isOwned(c)) &&
      (!profession.value || c.profession === profession.value) &&
      (!q || c.name.includes(q)),
  )
  if (sort.value === 'count') return list.toSorted((a, b) => b.count - a.count || b.star - a.star)
  if (sort.value === 'recent') return list.toSorted((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0) || b.star - a.star)
  return list
})

function caption(c: CodexEntry): string {
  if (c.owned?.potential != null) return `潜能 ${c.owned.potential}`
  if (c.owned) return '已拥有'
  if (c.count + c.gifted) return `${formatDate(c.lastTs!)}`
  return c.gacha ? (records.roster.length && !weapon.value ? '截图里没有' : '未抽到') : (c.approach ?? '其他途径')
}
/** 右上角的小标：终末地显示潜能，否则显示抽到的次数 */
function badge(c: CodexEntry): string | null {
  if (c.owned?.potential != null) return c.owned.potential >= 5 ? '满潜' : `潜${c.owned.potential}`
  return c.count > 1 ? `×${c.count}` : null
}
function detail(c: CodexEntry): string[] {
  const lines = [`${c.name} · ${c.star}★${c.profession ? ` · ${PROFESSION_LABEL[c.profession] ?? c.profession}` : ''}`]
  const o = c.owned
  if (o) {
    const shot = formatDateTime(o.snapshot.observedAt)
    lines.push(o.snapshot.potential !== null ? `截图（${shot}）时：潜能 ${o.snapshot.potential}，共获得 ${o.snapshot.copies} 次` : `截图（${shot}）时已拥有`)
    if (o.pulledAfter || o.giftedAfter) {
      lines.push(`截图之后：${[o.pulledAfter && `抽到 ${o.pulledAfter} 次`, o.giftedAfter && `累计寻访赠送 ${o.giftedAfter} 次`].filter(Boolean).join('，')}`)
      if (o.potential !== null) lines.push(`现在：潜能 ${o.potential}，共获得 ${o.copies} 次`)
    }
    if (o.conflict) lines.push('注意：截图之前的寻访记录比截图上的还多，请检查截图时间和潜能是否正确')
  }
  if (c.count) {
    lines.push(`寻访中抽到 ${c.count} 次${c.up ? `（其中 UP ${c.up} 次）` : ''}`)
    lines.push(c.firstTs === c.lastTs ? `获得于 ${formatDate(c.firstTs!)}` : `首次 ${formatDate(c.firstTs!)}，最近 ${formatDate(c.lastTs!)}`)
  }
  if (c.gifted) lines.push(`累计寻访赠送 ${c.gifted} 次（信物赠礼，不是抽出来的${c.giftedInferred ? `；其中 ${c.giftedInferred} 次按规则推算` : ''}）`)
  if (!o && !c.count && !c.gifted) {
    lines.push(c.gacha ? '寻访记录里没有' : `获得方式：${c.approach ?? '其他途径'}，不会出现在寻访记录里`)
  }
  return lines
}
</script>

<template>
  <PageShell id="codex" :title="title" eyebrow="CODEX">
    <div class="space-y-5">
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        :title="rosterInfo ? `已导入森空岛截图：${rosterInfo.count} 名干员` : `图鉴只根据寻访记录统计，和账号里实际拥有的${noun}不一定一致`"
      >
        <template #description>
          <p v-if="!rosterInfo" class="leading-relaxed">
            {{
              records.game === 'arknights'
                ? '公开招募、活动赠送、兑换所、剧情奖励等途径获得的干员'
                : weapon
                  ? '活动、商店、剧情奖励等途径获得的武器'
                  : '剧情、活动赠送等途径获得的干员'
            }}，以及官方只保留 90 天、没有被本站保存下来的早期寻访记录，这里都无法统计，所以“未获得”不代表账号里没有。
          </p>
          <p v-if="rosterInfo" class="leading-relaxed">
            最近的截图：{{ formatDateTime(rosterInfo.latest) }}。截图之后抽到的、获得赠送的会自动加上{{ potentialGame ? '（潜能 = 获得次数 − 1，最多 5）' : '' }}，不需要重新截图。
            截图里没有的{{ noun }}显示为“截图里没有”（也可能是没截全）。
            <span v-if="rosterInfo.conflicts" class="text-warning">有 {{ rosterInfo.conflicts }} 名干员的截图和寻访记录对不上（右下角有黄点），点开查看。</span>
          </p>
          <p v-else-if="canImport" class="mt-1 leading-relaxed text-dimmed">
            可以导入森空岛 App 的干员列表截图：在这台设备上识别（不上传），补全这些{{ noun }}{{ potentialGame ? '和潜能' : '' }}。
          </p>
          <div v-if="canImport" class="mt-2 flex flex-wrap gap-2">
            <UButton :label="rosterInfo ? '导入新的截图' : '导入森空岛截图'" icon="i-lucide-scan-text" size="xs" @click="importOpen = true" />
            <UButton
              v-if="rosterInfo"
              :label="confirmClear ? '再点一次确认清除' : '清除截图数据'"
              icon="i-lucide-trash-2"
              size="xs"
              :color="confirmClear ? 'error' : 'neutral'"
              variant="ghost"
              @click="clearImported"
            />
          </div>
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
            { label: '已获得', value: 'owned' },
            { label: '未获得', value: 'missing' },
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
        <UPopover v-for="c in shown" :key="c.id" mode="click" :content="{ side: 'top' }">
          <button type="button" class="min-w-0 text-left">
            <div class="relative transition" :class="isOwned(c) ? '' : 'opacity-35 grayscale'">
              <CharAvatar :char-id="c.id.startsWith('name:') ? null : c.id" :name="c.name" :star="c.star" :size="76" :game="records.game" class="pointer-events-none aspect-square !size-full" />
              <span v-if="badge(c)" class="absolute top-1 right-1 rounded-sm bg-black/65 px-1 font-display text-[11px] font-semibold text-white">{{ badge(c) }}</span>
              <span v-if="c.gifted" class="absolute bottom-1 left-1 rounded-sm bg-black/65 px-1 text-[10px] text-white" title="有累计寻访赠送">赠</span>
              <span v-if="c.owned?.conflict" class="absolute bottom-1 right-1 size-2 rounded-full bg-warning ring-2 ring-(--ui-bg)" title="截图和寻访记录对不上" />
            </div>
            <p class="mt-1 truncate text-xs font-medium" :class="isOwned(c) ? 'text-highlighted' : 'text-muted'">{{ c.name }}</p>
            <p class="truncate text-[10px] text-dimmed">{{ caption(c) }}</p>
          </button>
          <template #content>
            <div class="max-w-72 space-y-1 p-3 text-xs">
              <p v-for="(line, i) in detail(c)" :key="i" :class="i === 0 ? 'font-semibold text-highlighted' : line.startsWith('注意') ? 'text-warning' : 'text-muted'">{{ line }}</p>
            </div>
          </template>
        </UPopover>
      </div>
    </div>
    <RosterImportDialog v-model:open="importOpen" />
  </PageShell>
</template>
