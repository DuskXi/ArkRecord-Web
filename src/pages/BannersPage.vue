<script setup lang="ts">
import { computed, ref } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import CharAvatar from '@/components/ui/CharAvatar.vue'
import { formatDate } from '@/lib/format'
import { ruleLabel } from '@/lib/labels'
import { useAppStore } from '@/stores/app'
import { useRecordsStore } from '@/stores/records'

const app = useAppStore()
const records = useRecordsStore()

type Filter = 'all' | 'limited' | 'standard' | 'kernel' | 'weapon'
const filter = ref<Filter>('all')
const filters = computed(() => {
  const base: { value: Filter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'limited', label: records.game === 'arknights' ? '限定 / 联动' : '特许 / 重构' },
    { value: 'standard', label: records.game === 'arknights' ? '标准' : '基础' },
  ]
  if (records.game === 'arknights') base.push({ value: 'kernel', label: '中坚' })
  else base.push({ value: 'weapon', label: '武器' })
  return base
})

function category(ruleType: string, weapon: boolean): Filter {
  if (weapon) return 'weapon'
  if (['NORMAL', 'SINGLE', 'DOUBLE', 'SPECIAL', 'E_CharacterGachaPoolType_Standard', 'E_CharacterGachaPoolType_Beginner'].includes(ruleType)) return 'standard'
  if (['CLASSIC', 'CLASSIC_DOUBLE', 'FESCLASSIC'].includes(ruleType)) return 'kernel'
  return 'limited'
}

const pools = computed(() =>
  records.analysis.pools
    .filter((p) => filter.value === 'all' || category(p.ruleType, p.weapon) === filter.value)
    .map((p) => {
      const meta = p.poolId ? app.meta?.pools[p.poolId] : undefined
      const info = p.poolId ? records.efPools.get(p.poolId) : undefined
      const efPool = p.poolId ? app.efMeta?.pools[p.poolId] : undefined
      const efUp = efPool?.up.map((id) => app.efMeta?.items[id]?.n ?? id) ?? []
      return {
        ...p,
        badge: ruleLabel(p.ruleType),
        period: meta?.o ? `${formatDate(meta.o * 1000)} — ${formatDate(meta.e * 1000)}` : `${formatDate(p.firstTs)} — ${formatDate(p.lastTs)}`,
        upNames: meta?.up?.['6']?.map((id) => app.meta?.chars[id]?.n ?? id) ?? (efUp.length ? efUp : info?.up6Name ? [info.up6Name] : []),
        art: info?.up6Image,
      }
    }),
)
</script>

<template>
  <PageShell id="banners" title="卡池" eyebrow="BANNERS">
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <UFieldGroup>
          <UButton
            v-for="f in filters"
            :key="f.value"
            :label="f.label"
            size="sm"
            :color="filter === f.value ? 'primary' : 'neutral'"
            :variant="filter === f.value ? 'soft' : 'outline'"
            @click="filter = f.value"
          />
        </UFieldGroup>
        <span class="ml-auto font-display text-xs text-muted">{{ pools.length }} 个卡池</span>
      </div>

      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <article
          v-for="p in pools"
          :key="p.poolId ?? p.poolName"
          class="group relative overflow-hidden rounded-(--ui-radius) border border-default bg-default p-4 transition-colors hover:border-accented"
        >
          <img v-if="p.art" :src="p.art" alt="" class="pointer-events-none absolute inset-0 size-full object-cover opacity-10" referrerpolicy="no-referrer" />
          <div class="relative">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <h3 class="truncate font-semibold text-highlighted">{{ p.poolName }}</h3>
                <p class="font-display text-[11px] text-dimmed">{{ p.period }}</p>
              </div>
              <UBadge :label="p.badge.label" :color="p.badge.color" variant="subtle" size="sm" class="shrink-0" />
            </div>

            <p v-if="p.upNames.length" class="mt-2 truncate text-xs text-muted">UP：{{ p.upNames.join(' / ') }}</p>

            <div class="mt-3 grid grid-cols-4 gap-2 text-center">
              <div>
                <p class="font-display text-xl font-semibold text-highlighted">{{ p.pulls }}</p>
                <p class="text-[10px] text-dimmed">抽数</p>
              </div>
              <div>
                <p class="font-display text-xl font-semibold" style="color: var(--color-rarity-6)">{{ p.stars[6] }}</p>
                <p class="text-[10px] text-dimmed">6★</p>
              </div>
              <div>
                <p class="font-display text-xl font-semibold" style="color: var(--color-rarity-5)">{{ p.stars[5] }}</p>
                <p class="text-[10px] text-dimmed">5★</p>
              </div>
              <div>
                <p class="font-display text-xl font-semibold text-highlighted">
                  {{ p.gotUp === null ? '—' : p.gotUp ? '✓' : '✕' }}
                </p>
                <p class="text-[10px] text-dimmed">得到 UP</p>
              </div>
            </div>

            <div v-if="p.sixStars.length" class="mt-3 flex flex-wrap gap-2 border-t border-default pt-3">
              <div v-for="h in p.sixStars" :key="h.event.key" class="relative">
                <CharAvatar :char-id="h.event.itemId" :name="h.event.name" :star="6" :size="40" :game="records.game" />
                <span class="absolute -right-1 -bottom-1 rounded-sm bg-black/70 px-0.5 font-display text-[10px] text-white">{{ h.pity }}</span>
              </div>
            </div>
          </div>
        </article>
      </div>
    </div>
  </PageShell>
</template>
