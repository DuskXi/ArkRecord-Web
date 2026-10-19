<script setup lang="ts">
import { computed, ref } from 'vue'
import ShareStudio from '@/components/ShareStudio.vue'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDateTime, rarityTextVar } from '@/lib/format'
import type { PullEvent } from '@/lib/stats/events'
import { type GiftEvent, giftNote } from '@/lib/stats/gifts'
import { useRecords } from '@/composables/useRecords'

/**
 * 时间线：以 6★ 为节点分段，两次 6★ 之间的低星记录默认折叠，只显示 5★ 和新干员。
 * 选择某个保底分组后，分段与该分组的保底计数完全对应。
 * 累计寻访赠送的（信物赠礼、限定干员赠送）按时间插在中间，单独标成“赠送”：不是抽出来的，不影响分段和保底计数。
 */
const records = useRecords()
const family = ref<string>('all')
const expanded = ref(new Set<string>())
const shareOpen = ref(false)

const familyOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const e of records.events) if (e.countsForPity && !seen.has(e.family)) seen.set(e.family, e.familyLabel)
  return [{ label: '全部记录', value: 'all' }, ...[...seen.entries()].map(([value, label]) => ({ label, value }))]
})

interface Segment {
  id: string
  six: PullEvent | null
  pity: number | null
  pulls: PullEvent[]
}

const pityByKey = computed(() => new Map(records.analysis.hits.map((h) => [h.event.key, h.pity])))

const segments = computed<Segment[]>(() => {
  const out: Segment[] = []
  let current: PullEvent[] = []
  for (const e of records.events) {
    if (family.value !== 'all' && e.family !== family.value) continue
    current.push(e)
    if (e.star === 6) {
      out.push({ id: e.key, six: e, pity: pityByKey.value.get(e.key) ?? null, pulls: current })
      current = []
    }
  }
  if (current.length) out.push({ id: 'current', six: null, pity: null, pulls: current })
  return out.toReversed()
})

/** 选中的保底分组里出现过的卡池（赠送条目按卡池归到分组） */
const familyPools = computed(() => new Set(records.events.filter((e) => e.family === family.value).map((e) => e.poolId ?? `name:${e.poolName}`)))
const gifts = computed(() =>
  records.gifts.filter((g) => g.copy && (family.value === 'all' || familyPools.value.has(g.poolId))),
)

type Node = { type: 'segment'; key: string; seg: Segment } | { type: 'gift'; key: string; gift: GiftEvent }
/** 时间倒序：进行中的分段在最前，赠送按时间插在两个 6★ 之间 */
const nodes = computed<Node[]>(() =>
  [
    ...segments.value.map((seg) => ({ node: { type: 'segment', key: seg.id, seg } as Node, ts: seg.six ? seg.six.ts : Number.POSITIVE_INFINITY, order: seg.six?.order ?? 0 })),
    ...gifts.value.map((gift) => ({ node: { type: 'gift', key: gift.key, gift } as Node, ts: gift.ts, order: gift.order })),
  ]
    .toSorted((a, b) => b.ts - a.ts || b.order - a.order)
    .map((x) => x.node),
)

function counts(pulls: PullEvent[]) {
  const c = { 5: 0, 4: 0, 3: 0 } as Record<number, number>
  for (const p of pulls) if (p.star < 6) c[p.star] = (c[p.star] ?? 0) + 1
  return c
}

function highlights(pulls: PullEvent[]) {
  return pulls.filter((p) => p.star === 5 || (p.isNew && p.star < 6))
}

function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function pityTone(pity: number | null) {
  if (pity === null) return 'text-highlighted'
  if (pity <= 25) return 'text-success'
  if (pity >= 75) return 'text-error'
  return 'text-highlighted'
}
</script>

<template>
  <PageShell id="timeline" title="时间线" eyebrow="TIMELINE">
    <template #actions>
      <UButton label="分享卡片" icon="i-lucide-share" color="neutral" variant="outline" class="max-sm:hidden" :disabled="!records.events.length" @click="shareOpen = true" />
    </template>

    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <USelect v-model="family" :items="familyOptions" class="w-56" size="sm" />
        <UButton label="分享卡片" icon="i-lucide-share" size="sm" color="neutral" variant="outline" class="sm:hidden" :disabled="!records.events.length" @click="shareOpen = true" />
        <span class="ml-auto font-display text-xs text-muted">
          {{ segments.filter((s) => s.six).length }} 个 6★<template v-if="gifts.length"> · 另有赠送 {{ gifts.length }}</template>
        </span>
      </div>

      <ol class="relative space-y-3 border-l border-default pl-5">
        <template v-for="n in nodes" :key="n.key">
          <li v-if="n.type === 'gift'" class="relative">
            <span class="absolute top-5 -left-[26px] grid size-3 place-items-center rounded-full border-2 border-dashed border-amber-400 bg-(--ui-bg)" />
            <div
              class="flex items-center gap-3 rounded-(--ui-radius) border border-dashed border-amber-400/70 bg-amber-500/5 p-4"
              :title="`${giftNote(n.gift)}：累计寻访赠送，不是抽出来的，不计入统计`"
            >
              <CharAvatar :char-id="n.gift.itemId" :name="n.gift.name" :star="n.gift.star" :size="56" :game="records.game" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="truncate font-semibold" :style="{ color: rarityTextVar(n.gift.star) }">{{ n.gift.name }}</p>
                  <UBadge :label="n.gift.inferred ? '推算赠送' : '赠送'" color="warning" variant="solid" size="sm" icon="i-lucide-gift" />
                </div>
                <p class="truncate text-xs text-muted">{{ n.gift.poolName }} · {{ formatDateTime(n.gift.ts) }}</p>
                <p class="text-xs text-amber-600 dark:text-amber-400">{{ giftNote(n.gift) }}：不是抽出来的，不计入出货统计和保底</p>
              </div>
            </div>
          </li>
          <li v-else class="relative">
            <span
              class="absolute top-5 -left-[26px] size-3 rounded-full border-2 border-default"
              :style="{ background: n.seg.six ? 'var(--color-rarity-6)' : 'var(--ui-bg)' }"
            />
            <div class="rounded-(--ui-radius) border border-default bg-default p-4">
              <div class="flex items-center gap-3">
                <CharAvatar v-if="n.seg.six" :char-id="n.seg.six.itemId" :name="n.seg.six.name" :star="6" :size="56" :game="records.game" />
                <div v-else class="grid size-14 place-items-center rounded-(--ui-radius) border border-dashed border-accented text-dimmed">
                  <UIcon name="i-lucide-hourglass" class="size-5" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <p class="truncate font-semibold" :style="n.seg.six ? { color: rarityTextVar(6) } : undefined">
                      {{ n.seg.six ? n.seg.six.name : '进行中' }}
                    </p>
                    <UBadge v-if="n.seg.six?.isUp !== null && n.seg.six?.isUp !== undefined" :label="n.seg.six.isUp ? 'UP' : '歪'" :color="n.seg.six.isUp ? 'primary' : 'neutral'" variant="subtle" size="sm" />
                    <UBadge v-if="n.seg.six?.isNew" label="NEW" color="error" variant="subtle" size="sm" class="font-display" />
                  </div>
                  <p class="truncate text-xs text-muted">
                    {{ n.seg.six ? `${n.seg.six.poolName} · ${formatDateTime(n.seg.six.ts)}` : `已垫 ${n.seg.pulls.length} 抽` }}
                  </p>
                </div>
                <div class="text-right">
                  <p class="font-display text-3xl font-semibold tabular-nums" :class="pityTone(n.seg.pity)">{{ n.seg.pity ?? n.seg.pulls.length }}</p>
                  <p class="text-[10px] text-dimmed">{{ n.seg.six ? '抽出货' : '抽' }}</p>
                </div>
              </div>
  
              <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-default pt-3">
                <div v-for="h in highlights(n.seg.pulls)" :key="h.key" class="relative" :title="`${h.name} · ${formatDateTime(h.ts)}`">
                  <CharAvatar :char-id="h.itemId" :name="h.name" :star="h.star" :size="36" :game="records.game" />
                  <span v-if="h.isNew" class="absolute -top-1 -right-1 size-2 rounded-full bg-error" />
                </div>
                <span class="ml-auto flex gap-3 font-display text-xs">
                  <span :style="{ color: rarityTextVar(5) }">5★ × {{ counts(n.seg.pulls)[5] }}</span>
                  <span :style="{ color: rarityTextVar(4) }">4★ × {{ counts(n.seg.pulls)[4] }}</span>
                  <span v-if="records.game === 'arknights'" class="text-muted">3★ × {{ counts(n.seg.pulls)[3] }}</span>
                </span>
                <UButton
                  :icon="expanded.has(n.seg.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :aria-label="expanded.has(n.seg.id) ? '收起' : '展开全部'"
                  @click="toggle(n.seg.id)"
                />
              </div>
  
              <div v-if="expanded.has(n.seg.id)" class="mt-3 flex flex-wrap gap-1.5">
                <CharAvatar
                  v-for="p in n.seg.pulls"
                  :key="p.key"
                  :char-id="p.itemId"
                  :name="p.name"
                  :star="p.star"
                  :size="32"
                  :game="records.game"
                />
              </div>
            </div>
          </li>
        </template>
      </ol>
    </div>

    <ShareStudio v-model:open="shareOpen" />
  </PageShell>
</template>
