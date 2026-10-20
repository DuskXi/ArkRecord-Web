<script setup lang="ts">
import { computed } from 'vue'
import { formatDate, rarityVar } from '@/lib/format'
import type { SixStarHit } from '@/lib/stats/analyze'
import { type GiftEvent, giftNote } from '@/lib/stats/gifts'
import { upTag } from '@/lib/stats/up-tag'
import CharAvatar from './CharAvatar.vue'

/**
 * 最近的 6★：抽出来的显示垫了多少抽；累计寻访赠送的（信物赠礼、限定干员赠送）单独标成“赠送”，不显示抽数。
 */
const props = withDefaults(defineProps<{ hits: SixStarHit[]; hardPity: number; game: string; limit?: number; gifts?: GiftEvent[]; top?: number }>(), {
  limit: 24,
  // 最高星级：鹰角 6，米哈游 5
  top: 6,
  gifts: () => [],
})

type Tile = { type: 'hit'; key: string; ts: number; order: number; hit: SixStarHit } | { type: 'gift'; key: string; ts: number; order: number; gift: GiftEvent }

const shown = computed<Tile[]>(() =>
  [
    ...props.hits.map((hit): Tile => ({ type: 'hit', key: hit.event.key, ts: hit.event.ts, order: hit.event.order, hit })),
    ...props.gifts.filter((g) => g.copy && g.star === props.top).map((gift): Tile => ({ type: 'gift', key: gift.key, ts: gift.ts, order: gift.order, gift })),
  ]
    .toSorted((a, b) => b.ts - a.ts || b.order - a.order)
    .slice(0, props.limit),
)
</script>

<template>
  <div v-if="shown.length" class="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-3">
    <template v-for="t in shown" :key="t.key">
      <div v-if="t.type === 'hit'" class="group">
        <div class="relative">
          <CharAvatar :char-id="t.hit.event.itemId" :name="t.hit.event.name" :star="top" :size="88" :game="game" class="!size-full aspect-square" />
          <span
            v-if="t.hit.afterGap"
            class="absolute top-1 right-1 rounded-sm bg-black/60 px-1 font-display text-[11px] font-semibold text-white"
            title="抽数未知：前面有一段没有记录的空档（官方只保留最近一段时间的记录）"
          >
            ?
          </span>
          <span
            v-else
            class="absolute top-1 right-1 rounded-sm px-1 font-display text-[11px] font-semibold text-white"
            :class="t.hit.pity / hardPity >= 0.75 ? 'bg-error/90' : t.hit.pity / hardPity <= 0.25 ? 'bg-success/90' : 'bg-black/60'"
          >
            {{ t.hit.pity }}
          </span>
          <span
            v-if="upTag(t.hit.event)"
            class="absolute bottom-1.5 left-1 rounded-sm px-1 text-[10px] font-medium text-white"
            :class="upTag(t.hit.event)!.up ? 'bg-primary' : 'bg-zinc-600'"
            :title="upTag(t.hit.event)!.title"
          >
            {{ upTag(t.hit.event)!.text }}
          </span>
        </div>
        <div class="mt-1 h-1 overflow-hidden rounded-full bg-elevated">
          <div v-if="!t.hit.afterGap" class="h-full rounded-full" :style="{ width: `${Math.min(100, (t.hit.pity / hardPity) * 100)}%`, background: rarityVar(top) }" />
        </div>
        <p class="mt-1 truncate text-xs font-medium text-highlighted">{{ t.hit.event.name }}</p>
        <p class="truncate text-[10px] text-dimmed">{{ formatDate(t.hit.event.ts) }}</p>
      </div>
      <div v-else class="group" :title="`${t.gift.name} · ${giftNote(t.gift)}：累计寻访赠送，不是抽出来的，不计入统计`">
        <div class="relative rounded-(--ui-radius) outline-2 outline-offset-2 outline-dashed outline-amber-400">
          <CharAvatar :char-id="t.gift.itemId" :name="t.gift.name" :star="top" :size="88" :game="game" class="!size-full aspect-square" />
          <span class="absolute top-1 right-1 flex items-center gap-0.5 rounded-sm bg-amber-500 px-1 text-[11px] font-semibold text-white">
            <UIcon name="i-lucide-gift" class="size-3" />赠
          </span>
          <span class="absolute bottom-1.5 left-1 rounded-sm bg-amber-500/90 px-1 text-[10px] font-medium text-white">
            {{ t.gift.inferred ? '推算赠送' : '赠送' }}
          </span>
        </div>
        <div class="mt-1 h-1 rounded-full border-t-2 border-dashed border-amber-400/70" />
        <p class="mt-1 truncate text-xs font-medium text-highlighted">{{ t.gift.name }}</p>
        <p class="truncate text-[10px] text-amber-600 dark:text-amber-400">{{ giftNote(t.gift) }}</p>
        <p class="truncate text-[10px] text-dimmed">{{ formatDate(t.gift.ts) }}</p>
      </div>
    </template>
  </div>
  <p v-else class="py-8 text-center text-sm text-muted">还没有 {{ top }}★ 记录</p>
</template>
