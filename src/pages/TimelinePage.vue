<script setup lang="ts">
import { computed, ref } from 'vue'
import ShareStudio from '@/components/ShareStudio.vue'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDateTime, rarityTextVar } from '@/lib/format'
import type { PullEvent } from '@/lib/stats/events'
import { useRecordsStore } from '@/stores/records'

/**
 * 时间线：以 6★ 为节点分段，两次 6★ 之间的低星记录默认折叠，只显示 5★ 和新干员。
 * 选择某个保底分组后，分段与该分组的保底计数完全对应。
 */
const records = useRecordsStore()
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
        <span class="ml-auto font-display text-xs text-muted">{{ segments.filter((s) => s.six).length }} 个 6★</span>
      </div>

      <ol class="relative space-y-3 border-l border-default pl-5">
        <li v-for="seg in segments" :key="seg.id" class="relative">
          <span
            class="absolute top-5 -left-[26px] size-3 rounded-full border-2 border-default"
            :style="{ background: seg.six ? 'var(--color-rarity-6)' : 'var(--ui-bg)' }"
          />
          <div class="rounded-(--ui-radius) border border-default bg-default p-4">
            <div class="flex items-center gap-3">
              <CharAvatar v-if="seg.six" :char-id="seg.six.itemId" :name="seg.six.name" :star="6" :size="56" :game="records.game" />
              <div v-else class="grid size-14 place-items-center rounded-(--ui-radius) border border-dashed border-accented text-dimmed">
                <UIcon name="i-lucide-hourglass" class="size-5" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <p class="truncate font-semibold" :style="seg.six ? { color: rarityTextVar(6) } : undefined">
                    {{ seg.six ? seg.six.name : '进行中' }}
                  </p>
                  <UBadge v-if="seg.six?.isUp !== null && seg.six?.isUp !== undefined" :label="seg.six.isUp ? 'UP' : '歪'" :color="seg.six.isUp ? 'primary' : 'neutral'" variant="subtle" size="sm" />
                  <UBadge v-if="seg.six?.isNew" label="NEW" color="error" variant="subtle" size="sm" class="font-display" />
                </div>
                <p class="truncate text-xs text-muted">
                  {{ seg.six ? `${seg.six.poolName} · ${formatDateTime(seg.six.ts)}` : `已垫 ${seg.pulls.length} 抽` }}
                </p>
              </div>
              <div class="text-right">
                <p class="font-display text-3xl font-semibold tabular-nums" :class="pityTone(seg.pity)">{{ seg.pity ?? seg.pulls.length }}</p>
                <p class="text-[10px] text-dimmed">{{ seg.six ? '抽出货' : '抽' }}</p>
              </div>
            </div>

            <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-default pt-3">
              <div v-for="h in highlights(seg.pulls)" :key="h.key" class="relative" :title="`${h.name} · ${formatDateTime(h.ts)}`">
                <CharAvatar :char-id="h.itemId" :name="h.name" :star="h.star" :size="36" :game="records.game" />
                <span v-if="h.isNew" class="absolute -top-1 -right-1 size-2 rounded-full bg-error" />
              </div>
              <span class="ml-auto flex gap-3 font-display text-xs">
                <span :style="{ color: rarityTextVar(5) }">5★ × {{ counts(seg.pulls)[5] }}</span>
                <span :style="{ color: rarityTextVar(4) }">4★ × {{ counts(seg.pulls)[4] }}</span>
                <span v-if="records.game === 'arknights'" class="text-muted">3★ × {{ counts(seg.pulls)[3] }}</span>
              </span>
              <UButton
                :icon="expanded.has(seg.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="expanded.has(seg.id) ? '收起' : '展开全部'"
                @click="toggle(seg.id)"
              />
            </div>

            <div v-if="expanded.has(seg.id)" class="mt-3 flex flex-wrap gap-1.5">
              <CharAvatar
                v-for="p in seg.pulls"
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
      </ol>
    </div>

    <ShareStudio v-model:open="shareOpen" />
  </PageShell>
</template>
