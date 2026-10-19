<script setup lang="ts">
/**
 * 原神 / 星铁的基础统计（src/lib/mhy/stats.ts）：每组卡池的抽数、5★ 列表和各自用了多少抽、上一个 5★ / 4★ 之后的抽数。
 * 只显示数出来的事实；保底上限、“小保底 / 大保底”等规则还没按官方公示核对，这里不写。
 * 抽数都只在同一组卡池里数（原神 301 和 400 是一组；星铁的联动跃迁各自一组），界面上写明“本卡池内”，不暗示和别的池共用。
 */
import { computed } from 'vue'
import { type MhyPoolSummary, summarizeMhy } from '@/lib/mhy/stats'
import type { MhyGame, MhyPull } from '@/lib/mhy/types'

const props = defineProps<{ game: MhyGame; pulls: readonly MhyPull[] }>()

const summaries = computed(() => summarizeMhy(props.game, props.pulls).filter((s) => s.total > 0))

/** 每个 5★ 用的抽数的平均值（只是数出来的平均，不是概率） */
const average = (s: MhyPoolSummary) => (s.fiveStars.length ? (s.fiveStars.reduce((n, f) => n + f.pity, 0) / s.fiveStars.length).toFixed(1) : '—')
/** 5★ 从新到旧显示 */
const newestFirst = (s: MhyPoolSummary) => s.fiveStars.toReversed()
</script>

<template>
  <div v-if="summaries.length" class="grid gap-4 lg:grid-cols-2">
    <div v-for="s in summaries" :key="s.pool.group" class="space-y-3 rounded-(--ui-radius) border border-default bg-default p-4">
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="font-semibold text-highlighted">{{ s.pool.name }}</h3>
        <span class="font-display text-2xl font-semibold tabular-nums text-highlighted">{{ s.total }}<span class="ml-1 text-sm font-normal text-muted">抽</span></span>
      </div>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt class="text-xs text-muted">5★</dt>
          <dd class="font-medium tabular-nums text-amber-500">{{ s.fiveStars.length }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">4★</dt>
          <dd class="font-medium tabular-nums text-violet-500">{{ s.fourStars }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">5★ 平均抽数</dt>
          <dd class="font-medium tabular-nums">{{ average(s) }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">上一个 5★ 之后</dt>
          <dd class="font-medium tabular-nums">{{ s.sinceFive }} 抽</dd>
        </div>
      </dl>
      <p class="text-xs text-muted">上一个 4★ 或 5★ 之后已经抽了 {{ s.sinceFour }} 抽。以上抽数都只在本卡池内计算。</p>
      <div v-if="s.fiveStars.length" class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-muted">每个 5★ 用了多少抽（本卡池内）：</span>
        <span
          v-for="f in newestFirst(s)"
          :key="f.pull.id"
          class="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400"
          :title="f.pull.time"
        >
          {{ f.pull.name }}<span class="tabular-nums opacity-70">{{ f.pity }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
