<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import PityCard from '@/components/ui/PityCard.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import SixStarWall from '@/components/ui/SixStarWall.vue'
import StatTile from '@/components/ui/StatTile.vue'
import { formatDate, formatNumber, formatPercent } from '@/lib/format'
import { luckLabel } from '@/lib/stats/analyze'
import { useAppStore } from '@/stores/app'
import { useRecords } from '@/composables/useRecords'

// 图表库较大，异步加载，不阻塞首屏
const CalendarHeatmap = defineAsyncComponent(() => import('@/components/charts/CalendarHeatmap.vue'))

const app = useAppStore()
const records = useRecords()
const a = computed(() => records.analysis)

const RECENT = 21 * 86_400_000
const pityCards = computed(() =>
  a.value.pity
    .filter((p) => p.mainModel && (!p.isolated || (p.current > 0 && Date.now() - p.lastTs < RECENT)))
    .toSorted((x, y) => Number(x.isolated) - Number(y.isolated) || y.current - x.current),
)

const luck = computed(() => luckLabel(a.value.luck))
const luckColor = computed(
  () =>
    ({ great: 'var(--color-rarity-6)', good: 'var(--color-rarity-5)', neutral: undefined, bad: 'var(--color-sky-500)', awful: 'var(--color-zinc-400)' })[
      luck.value.tone
    ],
)
/** 累计寻访赠送的 6★（不是抽出来的，不计入统计） */
const giftedSix = computed(() => records.gifts.filter((g) => g.copy && g.star === 6))
const currency = computed(() =>
  records.game === 'arknights'
    ? `约 ${formatNumber(a.value.total * 600)} 合成玉`
    : '含免费十连，不含赠送',
)
</script>

<template>
  <PageShell id="overview" title="总览" eyebrow="OVERVIEW">
    <div v-if="a.total === 0" class="mt-10">
      <UEmpty
        icon="i-lucide-inbox"
        title="还没有寻访记录"
        description="点击右上角的“同步”从鹰角服务器拉取最近 90 天的记录，或在“数据”页导入旧数据。"
        :actions="[{ label: '去导入', icon: 'i-lucide-upload', to: '/data', color: 'neutral', variant: 'outline' }]"
      />
    </div>

    <div v-else class="space-y-8">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p class="eyebrow">{{ records.game === 'arknights' ? 'DOCTOR' : 'ENDMINISTRATOR' }}</p>
          <p class="text-2xl font-semibold text-highlighted">{{ app.activeAccount?.nickName }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p v-if="a.firstTs && a.lastTs" class="text-xs text-muted">
            存档范围 <span class="font-display">{{ formatDate(a.firstTs) }} — {{ formatDate(a.lastTs) }}</span>
          </p>
          <!-- 手机底部导航放不下，从这里进入 -->
          <UButton v-if="records.game === 'arknights'" label="源石与充值" icon="i-lucide-gem" to="/ledger" size="xs" color="neutral" variant="outline" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="TOTAL PULLS" :value="formatNumber(a.total)" :hint="currency" icon="i-lucide-sigma" />
        <StatTile
          :label="records.weaponScope ? '6★ WEAPONS' : '6★ OPERATORS'"
          :value="a.stars[6]"
          :hint="a.total ? `出货率 ${formatPercent(a.stars[6] / a.total, 2)}${giftedSix.length ? ` · 另有赠送 ${giftedSix.length}` : ''}` : ''"
          icon="i-lucide-star"
          accent="var(--color-rarity-6)"
        />
        <StatTile
          label="AVG PER 6★"
          :value="a.avgPerSix ? a.avgPerSix.toFixed(1) : '—'"
          :hint="records.model.dist ? `理论期望 ${records.model.dist.mean.toFixed(2)} 抽` : `${records.model.hardPity} 抽内必出 6★`"
          icon="i-lucide-gauge"
        />
        <StatTile
          label="UP WIN RATE"
          :value="a.upTotal ? formatPercent(a.upWins / a.upTotal, 0) : '—'"
          :hint="a.upTotal ? `${a.upWins} / ${a.upTotal} 个 6★ 为当期 UP` : 'UP 名单未知'"
          icon="i-lucide-target"
        />
        <StatTile
          label="LUCK"
          :value="a.luck === null ? '—' : formatPercent(a.luck, 0)"
          :hint="!records.model.dist ? '武器池不计算运气' : a.luck === null ? '还没有出过 6★' : `${luck.text} · 比这个比例的玩家更欧`"
          icon="i-lucide-sparkles"
          :accent="luckColor"
          class="col-span-2 md:col-span-1"
        />
      </div>

      <section>
        <SectionHeader index="01" eyebrow="PITY" title="当前保底" />
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <PityCard v-for="p in pityCards" :key="p.family" :state="p" />
        </div>
      </section>

      <section v-if="records.guarantees.length">
        <SectionHeader index="02" eyebrow="GUARANTEE" title="定向保底与累计奖励" />
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="g in records.guarantees" :key="g.poolName + g.label" class="rounded-(--ui-radius) border border-default p-4">
            <p class="truncate text-xs text-dimmed">{{ g.poolName }}</p>
            <p class="truncate font-medium text-highlighted">{{ g.label }}</p>
            <div class="mt-2 flex items-center gap-3">
              <UProgress :model-value="g.done ? g.target : Math.min(g.current, g.target)" :max="g.target" :color="g.done ? 'success' : 'primary'" class="flex-1" />
              <span class="font-display text-sm tabular-nums text-muted">
                {{ g.done ? '已达成' : `${g.current} / ${g.target}` }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader index="03" eyebrow="RECENT 6★" title="最近的 6★">
          <UButton to="/timeline" label="时间线" variant="link" trailing-icon="i-lucide-arrow-right" />
        </SectionHeader>
        <SixStarWall :hits="a.hits" :gifts="giftedSix" :hard-pity="records.model.hardPity" :game="records.game" :limit="12" />
        <p v-if="giftedSix.length" class="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <UIcon name="i-lucide-gift" class="size-3.5 text-amber-500" />
          虚线框、标着“赠”的是累计寻访赠送的（{{ records.game === 'endfield' ? '信物赠礼，潜能 +1' : '限定池累计 300 抽赠送' }}），不是抽出来的，不计入出货统计。
        </p>
      </section>

      <section>
        <SectionHeader index="04" eyebrow="ACTIVITY" title="抽卡日历" />
        <div class="rounded-(--ui-radius) border border-default p-3">
          <CalendarHeatmap :per-day="a.perDay" />
        </div>
      </section>
    </div>
  </PageShell>
</template>
