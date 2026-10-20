<script setup lang="ts">
import { computed } from 'vue'
import { useRecords } from '@/composables/useRecords'
import { rarityVar } from '@/lib/format'
import type { PityState } from '@/lib/stats/analyze'

const props = defineProps<{ state: PityState }>()
const records = useRecords()
const pct = computed(() => Math.min(100, (props.state.current / props.state.hardPity) * 100))
const softPct = computed(() => (props.state.softPity / props.state.hardPity) * 100)
const hasSoft = computed(() => props.state.softPity < props.state.hardPity)
const inSoft = computed(() => hasSoft.value && props.state.current >= props.state.softPity)
</script>

<template>
  <div class="rounded-(--ui-radius) border border-default bg-default p-4">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="eyebrow">{{ state.isolated ? 'ISOLATED' : 'SHARED' }} PITY</p>
        <p class="mt-0.5 truncate font-medium text-highlighted">{{ state.label }}</p>
      </div>
      <UBadge v-if="inSoft" color="warning" variant="subtle" size="sm">概率提升中</UBadge>
    </div>

    <div class="mt-3 flex items-baseline gap-1.5">
      <span class="font-display text-4xl font-semibold tabular-nums" :class="inSoft ? 'text-warning' : 'text-highlighted'">{{ state.current }}</span>
      <span class="font-display text-sm text-dimmed">/ {{ state.hardPity }}</span>
    </div>

    <div class="relative mt-3 h-2 overflow-hidden rounded-full bg-elevated">
      <div
        class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
        :style="{ width: `${pct}%`, background: inSoft ? rarityVar(records.profile.topStar) : 'var(--ui-primary)' }"
      />
      <div v-if="hasSoft" class="absolute inset-y-0 w-px bg-(--ui-text-dimmed)" :style="{ left: `${softPct}%` }" />
    </div>
    <div class="mt-1 flex justify-between font-display text-[10px] text-dimmed">
      <span>0</span>
      <span v-if="hasSoft" :style="{ marginLeft: `${softPct - 8}%` }">{{ state.softPity }}</span>
      <span>{{ state.hardPity }}</span>
    </div>

    <p v-if="state.expectedMedian === null" class="mt-3 text-xs text-muted">
      最多再抽 <span class="font-display text-sm text-highlighted">{{ state.hardPity - state.current }}</span> 抽必出 {{ records.profile.topStar }}★
    </p>
    <p v-else class="mt-3 text-xs text-muted">
      预计还需 <span class="font-display text-sm text-highlighted">{{ state.expectedMedian }}</span> 抽（中位数），
      90% 的情况下不超过 <span class="font-display text-sm text-highlighted">{{ state.expectedP90 }}</span> 抽<template v-if="records.model.derived">（按官方数字推算，非官方）</template>
    </p>
    <p class="mt-1 truncate text-xs text-dimmed">最近：{{ state.lastPoolName }}</p>
  </div>
</template>
