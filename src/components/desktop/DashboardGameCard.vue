<script setup lang="ts">
/**
 * 总览上一款游戏的卡片（DashboardPage）：总抽数、最高星、出货率、平均出货抽数，每个账号角色池的垫抽、
 * 大小保底（米哈游）、运气，最近的最高星。米哈游的运气是按官方数字推算的，标“推算，非官方”。
 */
import { computed } from 'vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import type { AccountSummary, GameSummary } from '@/lib/desktop/summary'
import { formatDateTime, formatNumber, formatPercent, rarityVar } from '@/lib/format'
import { luckLabel } from '@/lib/stats/analyze'
import { upTag } from '@/lib/stats/up-tag'
import type { DesktopGame } from './games'

const props = defineProps<{ summary: GameSummary; game: DesktopGame }>()
defineEmits<{ open: [] }>()

const top = computed(() => props.summary.topStar)
const empty = computed(() => props.summary.accounts.length === 0)
/** 鹰角从官方接口同步，米哈游从游戏缓存读取 */
const vendorTerm = computed(() => (props.summary.vendor === 'mihoyo' ? '读取' : '同步'))
const recent = computed(() => props.summary.recentTop.slice(0, 6))
/** 只有一个账号时，平均出货抽数放在合计里；几个账号时各自显示 */
const single = computed(() => (props.summary.accounts.length === 1 ? props.summary.accounts[0]! : null))

const LUCK_COLOR = { great: 'text-(--color-rarity-6)', good: 'text-(--color-rarity-5)', neutral: 'text-highlighted', bad: 'text-sky-500', awful: 'text-dimmed' }

function luckText(a: AccountSummary): string {
  if (a.luck === null) return a.top ? '没有概率模型' : `还没有出过 ${top.value}★`
  return `${luckLabel(a.luck).text} · ${formatPercent(a.luck, 0)}`
}

const pityPct = (a: AccountSummary) => (a.pity ? Math.min(100, (a.pity.current / a.pity.hardPity) * 100) : 0)
</script>

<template>
  <button
    type="button"
    class="group relative flex flex-col overflow-hidden rounded-(--ui-radius) border border-default bg-default p-5 text-left transition-colors hover:border-(--accent) hover:bg-elevated/30"
    :style="{ '--accent': game.accent }"
    @click="$emit('open')"
  >
    <span class="absolute inset-y-0 left-0 w-1 bg-(--accent)" aria-hidden="true" />
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="eyebrow">{{ game.vendor }}</p>
        <p class="mt-0.5 truncate text-lg font-semibold text-highlighted">{{ game.label }}</p>
      </div>
      <UIcon name="i-lucide-arrow-right" class="size-4 shrink-0 text-dimmed transition-transform group-hover:translate-x-0.5" />
    </div>

    <p v-if="empty" class="mt-4 text-sm text-muted">还没有记录，点开去{{ game.vendor === '鹰角' ? '添加账号' : '读取' }}</p>

    <template v-else>
      <!-- 合计 -->
      <div class="mt-4 grid grid-cols-3 gap-3">
        <div>
          <p class="eyebrow">PULLS</p>
          <p class="mt-0.5 font-display text-2xl font-semibold tabular-nums text-highlighted">{{ formatNumber(summary.pulls) }}</p>
        </div>
        <div>
          <p class="eyebrow">{{ top }}★</p>
          <p class="mt-0.5 font-display text-2xl font-semibold tabular-nums" :style="{ color: rarityVar(top) }">{{ summary.top }}</p>
          <p v-if="summary.pulls" class="text-[11px] text-dimmed">{{ formatPercent(summary.top / summary.pulls, 2) }}</p>
        </div>
        <div v-if="single">
          <p class="eyebrow">AVG</p>
          <p class="mt-0.5 font-display text-2xl font-semibold tabular-nums text-highlighted">{{ single.avgPerTop === null ? '—' : single.avgPerTop.toFixed(1) }}</p>
          <p class="text-[11px] text-dimmed">角色池平均几抽出一个</p>
        </div>
        <div v-else>
          <p class="eyebrow">ACCOUNTS</p>
          <p class="mt-0.5 font-display text-2xl font-semibold tabular-nums text-highlighted">{{ summary.accounts.length }}</p>
        </div>
      </div>

      <!-- 每个账号：角色池垫抽、大小保底、运气 -->
      <ul class="mt-4 space-y-3">
        <li v-for="a in summary.accounts" :key="a.accountId" class="rounded-(--ui-radius) bg-elevated/50 px-3 py-2.5">
          <div class="flex items-center justify-between gap-2 text-xs">
            <span class="min-w-0 truncate">
              <span class="font-medium text-highlighted">{{ a.name }}</span>
              <span v-if="!single" class="text-dimmed"> · {{ formatNumber(a.pulls) }} 抽<template v-if="a.avgPerTop !== null"> · 平均 {{ a.avgPerTop.toFixed(1) }}</template></span>
            </span>
            <span class="flex shrink-0 items-center gap-1.5">
              <UBadge v-if="a.guarantee === 'big'" label="大保底" color="warning" variant="subtle" size="sm" title="上一个歪了，下一个角色活动池的 5★ 必是 UP" />
              <UBadge v-else-if="a.guarantee === 'small'" label="小保底" color="neutral" variant="subtle" size="sm" title="下一个角色活动池的 5★ 有一半机会是 UP" />
              <span :class="a.luck === null ? 'text-dimmed' : LUCK_COLOR[luckLabel(a.luck).tone]" :title="a.derived ? '按官方数字推算，非官方' : '比这个比例的玩家更欧'">
                {{ luckText(a) }}<template v-if="a.derived && a.luck !== null">（推算，非官方）</template>
              </span>
            </span>
          </div>
          <div v-if="a.pity" class="mt-2 flex items-center gap-2">
            <div class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-accented/60">
              <div class="absolute inset-y-0 left-0 rounded-full bg-(--accent)" :style="{ width: `${pityPct(a)}%` }" />
            </div>
            <span class="shrink-0 font-display text-xs tabular-nums text-muted" :title="a.pity.label">
              垫 <b class="text-highlighted">{{ a.pity.current }}</b> / {{ a.pity.hardPity }}
            </span>
          </div>
        </li>
      </ul>

      <!-- 最近的最高星 -->
      <div v-if="recent.length" class="mt-4 flex gap-2 overflow-hidden">
        <div v-for="h in recent" :key="`${h.accountId}:${h.ts}:${h.name}`" class="relative" :title="`${h.name}${h.pity === null ? '' : ` · 第 ${h.pity} 抽`}${upTag(h) ? ` · ${upTag(h)!.text}` : ''} · ${formatDateTime(h.ts)}`">
          <CharAvatar :char-id="h.itemId" :name="h.name" :star="top" :size="44" :game="summary.game" />
          <span v-if="h.pity !== null" class="absolute top-0.5 right-0.5 rounded-sm bg-black/60 px-0.5 font-display text-[10px] leading-tight text-white">{{ h.pity }}</span>
          <span v-if="h.weapon" class="absolute bottom-1 left-0.5 rounded-sm bg-black/60 px-0.5 text-[10px] leading-tight text-white">{{ summary.game === 'starrail' ? '光锥' : '武器' }}</span>
        </div>
      </div>

      <p class="mt-auto pt-4 text-xs text-dimmed">
        {{ summary.accounts.length }} 个账号<template v-if="summary.lastSyncAt"> · 上次{{ vendorTerm }} {{ formatDateTime(summary.lastSyncAt) }}</template>
      </p>
    </template>
  </button>
</template>
