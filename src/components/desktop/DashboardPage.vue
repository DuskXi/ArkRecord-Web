<script setup lang="ts">
/**
 * 桌面版的四款游戏总览（侧边栏厂商切换最前面的“总览”，路由 /home，见 src/platform/desktop.ts）。只在桌面版里。
 * 统计来自 src/lib/desktop/summary.ts：上面是四款游戏的合计，下面每款游戏一张卡片（DashboardGameCard），
 * 再是四款游戏混在一起的最近出货和每月抽数。米哈游的运气是推算的，卡片上有标注。
 */
import type { EChartsOption } from 'echarts'
import { computed, defineAsyncComponent } from 'vue'
import { useRouter } from 'vue-router'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import StatTile from '@/components/ui/StatTile.vue'
import { axisStyle, useChartTheme } from '@/composables/useChartTheme'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { type GameSummary, summarizeGames, type TopHit } from '@/lib/desktop/summary'
import { formatDate, formatDateTime, formatNumber, rarityVar } from '@/lib/format'
import { upTag } from '@/lib/stats/up-tag'
import type { Game } from '@/lib/types'
import { useAppStore } from '@/stores/app'
import DashboardGameCard from './DashboardGameCard.vue'
import { type AnyGame, DESKTOP_GAMES, type DesktopGame } from './games'

// 图表库较大，异步加载
const EChart = defineAsyncComponent(() => import('@/components/charts/EChart.vue'))

const app = useAppStore()
const router = useRouter()
const palette = useChartTheme()
const summaries = useLiveQuery(
  () => summarizeGames({ akMeta: app.meta, efMeta: app.efMeta }),
  [() => app.meta, () => app.efMeta],
  [] as GameSummary[],
)

const gameOf = (id: AnyGame) => DESKTOP_GAMES.find((g) => g.id === id)!
const cards = computed(() => DESKTOP_GAMES.map((game) => ({ game, summary: summaries.value.find((s) => s.game === game.id) })))
const withData = computed(() => summaries.value.filter((s) => s.accounts.length))

const totals = computed(() => {
  const list = summaries.value
  const syncs = list.map((s) => s.lastSyncAt).filter((t): t is number => typeof t === 'number')
  return {
    pulls: list.reduce((n, s) => n + s.pulls, 0),
    /** 鹰角 6★ + 米哈游 5★ */
    top: list.reduce((n, s) => n + s.top, 0),
    accounts: list.reduce((n, s) => n + s.accounts.length, 0),
    lastSyncAt: syncs.length ? Math.max(...syncs) : undefined,
  }
})
const topHint = computed(() =>
  withData.value.length ? withData.value.map((s) => `${gameOf(s.game).short} ${s.top}`).join(' · ') : '明日方舟、终末地 6★，原神、星铁 5★',
)

/** 四款游戏混在一起最近的 10 个最高星 */
interface RecentHit extends TopHit {
  game: AnyGame
  top: number
}
const recent = computed<RecentHit[]>(() =>
  summaries.value
    .flatMap((s) => s.recentTop.map((h) => ({ ...h, game: s.game, top: s.topStar })))
    .toSorted((a, b) => b.ts - a.ts)
    .slice(0, 10),
)
/** 有几个账号的游戏，最近出货里写上是哪个账号 */
const multiAccount = computed(() => new Set(summaries.value.filter((s) => s.accounts.length > 1).map((s) => s.game)))
const accountName = (h: RecentHit) => summaries.value.find((s) => s.game === h.game)?.accounts.find((a) => a.accountId === h.accountId)?.name ?? ''

/** 每月抽数：四款游戏叠在一起，只画有记录的游戏 */
const monthlyOption = computed<EChartsOption>(() => {
  const p = palette.value
  const months = withData.value[0]?.monthly.map((m) => m.month) ?? []
  return {
    grid: { left: 44, right: 8, top: 36, bottom: 24 },
    legend: { top: 0, right: 0, textStyle: { color: p.muted, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: months.map((m) => `${m.slice(2, 4)}/${m.slice(5)}`), ...axisStyle(p), axisTick: { show: false } },
    yAxis: { type: 'value', minInterval: 1, ...axisStyle(p) },
    series: withData.value.map((s) => ({
      name: gameOf(s.game).label,
      type: 'bar' as const,
      stack: 'pulls',
      barMaxWidth: 28,
      itemStyle: { color: gameOf(s.game).accent },
      emphasis: { focus: 'series' as const },
      data: s.monthly.map((m) => m.pulls),
    })),
  }
})

/** 鹰角两款共用鹰角的页面，先切到那款游戏；米哈游两款各有自己的页面 */
function open(game: DesktopGame) {
  if (game.vendor === '鹰角') app.game = game.id as Game
  void router.push(game.to)
}
</script>

<template>
  <PageShell id="dashboard" title="总览" eyebrow="ALL GAMES" :require-account="false" :sync="false" :scoped="false">
    <div class="space-y-8">
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="TOTAL PULLS" :value="formatNumber(totals.pulls)" hint="四款游戏合计，含武器、光锥" icon="i-lucide-sigma" />
        <StatTile label="TOP RARITY" :value="totals.top" :hint="topHint" icon="i-lucide-star" :accent="rarityVar(6)" />
        <StatTile label="GAMES" :value="`${withData.length} / 4`" :hint="`本机 ${totals.accounts} 个账号`" icon="i-lucide-gamepad-2" />
        <StatTile
          label="LAST UPDATE"
          :value="totals.lastSyncAt ? formatDate(totals.lastSyncAt) : '—'"
          :hint="totals.lastSyncAt ? `最近一次同步或读取 ${formatDateTime(totals.lastSyncAt)}` : '还没有同步或读取过'"
          icon="i-lucide-refresh-cw"
        />
      </div>

      <section>
        <SectionHeader index="01" eyebrow="GAMES" title="四款游戏" />
        <div class="grid gap-3 lg:grid-cols-2">
          <template v-for="c in cards" :key="c.game.id">
            <DashboardGameCard v-if="c.summary" :summary="c.summary" :game="c.game" @open="open(c.game)" />
            <div v-else class="h-40 animate-pulse rounded-(--ui-radius) border border-default bg-elevated/40" />
          </template>
        </div>
      </section>

      <section v-if="recent.length">
        <SectionHeader index="02" eyebrow="RECENT" title="最近出货" />
        <ul class="divide-y divide-default overflow-hidden rounded-(--ui-radius) border border-default">
          <li v-for="h in recent" :key="`${h.game}:${h.accountId}:${h.ts}:${h.name}`" class="flex items-center gap-3 px-3 py-2">
            <CharAvatar :char-id="h.itemId" :name="h.name" :star="h.top" :size="36" :game="h.game" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-highlighted">
                <span
                  class="mr-1.5 inline-block w-7 rounded-sm border text-center align-[1px] font-display text-[10px] leading-4 font-semibold tracking-wide"
                  :style="{ color: gameOf(h.game).accent, borderColor: gameOf(h.game).accent, background: `color-mix(in oklab, ${gameOf(h.game).accent} 12%, transparent)` }"
                  :title="gameOf(h.game).label"
                  :aria-label="gameOf(h.game).label"
                  >{{ gameOf(h.game).code }}</span
                >{{ h.name }}
                <span v-if="h.weapon" class="ml-1 text-xs font-normal text-dimmed">{{ h.game === 'starrail' ? '光锥' : '武器' }}</span>
              </p>
              <p class="truncate text-xs text-dimmed">
                <template v-if="multiAccount.has(h.game)">{{ accountName(h) }} · </template>{{ formatDateTime(h.ts) }}
              </p>
            </div>
            <UBadge
              v-if="upTag(h)"
              :label="upTag(h)!.text"
              :color="upTag(h)!.up ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
              :title="upTag(h)!.title"
            />
            <span class="w-14 shrink-0 text-right font-display text-sm tabular-nums" :style="{ color: rarityVar(h.top) }" :title="h.pity === null ? '免费十连出的，不计保底' : undefined">
              {{ h.pity === null ? '免费' : `${h.pity} 抽` }}
            </span>
          </li>
        </ul>
      </section>

      <section v-if="totals.pulls">
        <SectionHeader index="03" eyebrow="MONTHLY" title="每月抽数" />
        <div class="rounded-(--ui-radius) border border-default p-4">
          <EChart :option="monthlyOption" height="260px" />
          <p class="mt-2 text-xs text-dimmed">最近 12 个月，按北京时间分月；含武器、光锥。</p>
        </div>
      </section>
    </div>
  </PageShell>
</template>
