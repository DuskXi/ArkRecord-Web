<script setup lang="ts">
import { computed } from 'vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { formatDate, formatPercent } from '@/lib/format'
import { useRecords } from '@/composables/useRecords'

const records = useRecords()
const s = computed(() => records.insights)
const unit = computed(() => (records.weaponScope ? '件' : '名'))

const tenRows = computed(() => {
  const t = s.value.tenByBest
  const total = s.value.tenPulls || 1
  return ([6, 5, 4] as const).map((star) => {
    const count = t[star] + (star === 4 ? t[3] : 0)
    return { star, label: star === 6 ? '出了 6★' : star === 5 ? '最高 5★' : '最高 4★', count, share: count / total }
  })
})

const fiveTop = computed(() =>
  s.value.collection
    .filter((c) => c.star === 5)
    .slice(0, 6),
)
</script>

<template>
  <div class="space-y-10">
    <section>
      <SectionHeader eyebrow="RECORDS" title="纪录" />
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div v-if="s.fastestSix" class="flex items-center gap-3 rounded-(--ui-radius) border border-default p-4">
          <CharAvatar :char-id="s.fastestSix.event.itemId" :name="s.fastestSix.event.name" :star="6" :size="52" :game="records.game" />
          <div class="min-w-0">
            <p class="eyebrow">FASTEST 6★</p>
            <p class="truncate font-medium text-highlighted">{{ s.fastestSix.event.name }}</p>
            <p class="text-xs text-muted">第 <b class="font-display text-success">{{ s.fastestSix.pity }}</b> 抽 · {{ formatDate(s.fastestSix.event.ts) }}</p>
          </div>
        </div>
        <div v-if="s.slowestSix" class="flex items-center gap-3 rounded-(--ui-radius) border border-default p-4">
          <CharAvatar :char-id="s.slowestSix.event.itemId" :name="s.slowestSix.event.name" :star="6" :size="52" :game="records.game" />
          <div class="min-w-0">
            <p class="eyebrow">LONGEST WAIT</p>
            <p class="truncate font-medium text-highlighted">{{ s.slowestSix.event.name }}</p>
            <p class="text-xs text-muted">第 <b class="font-display text-error">{{ s.slowestSix.pity }}</b> 抽 · {{ formatDate(s.slowestSix.event.ts) }}</p>
          </div>
        </div>
        <div v-if="s.firstSix" class="flex items-center gap-3 rounded-(--ui-radius) border border-default p-4">
          <CharAvatar :char-id="s.firstSix.event.itemId" :name="s.firstSix.event.name" :star="6" :size="52" :game="records.game" />
          <div class="min-w-0">
            <p class="eyebrow">FIRST 6★ ON RECORD</p>
            <p class="truncate font-medium text-highlighted">{{ s.firstSix.event.name }}</p>
            <p class="text-xs text-muted">{{ formatDate(s.firstSix.event.ts) }} · {{ s.firstSix.event.poolName }}</p>
          </div>
        </div>
        <div v-if="s.bestTen" class="rounded-(--ui-radius) border border-default p-4">
          <p class="eyebrow">BEST TEN-PULL</p>
          <div class="mt-2 flex -space-x-2">
            <CharAvatar
              v-for="e in s.bestTen.events.filter((x) => x.star >= 5).toSorted((a, b) => b.star - a.star)"
              :key="e.key"
              :char-id="e.itemId"
              :name="e.name"
              :star="e.star"
              :size="36"
              :game="records.game"
              class="ring-2 ring-(--ui-bg)"
            />
          </div>
          <p class="mt-1.5 truncate text-xs text-muted">{{ formatDate(s.bestTen.ts) }} · {{ s.bestTen.poolName }}</p>
        </div>
        <div v-if="s.busiestDay" class="rounded-(--ui-radius) border border-default p-4">
          <p class="eyebrow">BUSIEST DAY</p>
          <p class="mt-1 font-display text-2xl font-semibold text-highlighted">{{ s.busiestDay.pulls }} <span class="text-sm font-normal text-muted">抽</span></p>
          <p class="text-xs text-muted">{{ s.busiestDay.day.replaceAll('-', '/') }} · 出了 {{ s.busiestDay.six }} 个 6★</p>
        </div>
        <div v-if="s.luckiestDay" class="rounded-(--ui-radius) border border-default p-4">
          <p class="eyebrow">LUCKIEST DAY</p>
          <p class="mt-1 font-display text-2xl font-semibold" style="color: var(--color-rarity-6)">
            {{ s.luckiestDay.six }} <span class="text-sm font-normal text-muted">个 6★</span>
          </p>
          <p class="text-xs text-muted">{{ s.luckiestDay.day.replaceAll('-', '/') }} · 共 {{ s.luckiestDay.pulls }} 抽</p>
        </div>
        <div class="rounded-(--ui-radius) border border-default p-4">
          <p class="eyebrow">5★+ INTERVAL</p>
          <p class="mt-1 font-display text-2xl font-semibold text-highlighted">
            {{ s.fivePlus.avgGap === null ? '—' : s.fivePlus.avgGap.toFixed(1) }} <span class="text-sm font-normal text-muted">抽</span>
          </p>
          <p class="text-xs text-muted">平均每个 5★ 及以上；最长 {{ s.fivePlus.longestGap }} 抽，当前已 {{ s.fivePlus.current }} 抽</p>
        </div>
        <div class="rounded-(--ui-radius) border border-default p-4">
          <p class="eyebrow">TEN-PULLS</p>
          <p class="mt-1 font-display text-2xl font-semibold text-highlighted">
            {{ s.tenPulls }} <span class="text-sm font-normal text-muted">次十连 · {{ s.singles }} 次单抽</span>
          </p>
          <p class="text-xs text-muted">其中 {{ s.multiSixTens.length }} 次十连出了 2 个及以上 6★</p>
        </div>
      </div>
    </section>

    <section class="grid gap-3 lg:grid-cols-2">
      <div class="rounded-(--ui-radius) border border-default p-4">
        <SectionHeader eyebrow="TEN-PULLS" title="十连的最高星级" class="!mb-3" />
        <p v-if="!s.tenPulls" class="py-6 text-center text-sm text-muted">没有十连记录</p>
        <ul v-else class="space-y-3">
          <li v-for="row in tenRows" :key="row.star">
            <div class="flex justify-between text-sm">
              <span class="text-highlighted">{{ row.label }}</span>
              <span class="font-display text-muted">{{ row.count }} 次 · {{ formatPercent(row.share, 1) }}</span>
            </div>
            <div class="mt-1 h-2 overflow-hidden rounded-full bg-elevated">
              <div class="h-full rounded-full" :style="{ width: `${row.share * 100}%`, background: `var(--color-rarity-${row.star})` }" />
            </div>
          </li>
        </ul>
      </div>
      <div class="rounded-(--ui-radius) border border-default p-4">
        <SectionHeader eyebrow="MOST FREQUENT 5★" :title="`最常见的 5★`" class="!mb-3" />
        <p v-if="!fiveTop.length" class="py-6 text-center text-sm text-muted">暂无</p>
        <ul v-else class="space-y-2">
          <li v-for="c in fiveTop" :key="c.id" class="flex items-center gap-3">
            <CharAvatar :char-id="c.itemId" :name="c.name" :star="5" :size="32" :game="records.game" />
            <span class="flex-1 truncate text-sm text-highlighted">{{ c.name }}</span>
            <span class="font-display text-sm text-muted">×{{ c.count }}</span>
          </li>
        </ul>
        <p class="mt-3 text-xs text-dimmed">共获得 {{ s.collection.filter((c) => c.star === 5).length }} {{ unit }}不同的 5★</p>
      </div>
    </section>
  </div>
</template>
