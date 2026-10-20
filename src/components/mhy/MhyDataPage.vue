<script setup lang="ts">
/**
 * 原神 / 星铁的“数据”页（只在桌面版）：本机保存了哪些账号、各有多少条记录；导入导出。
 * UIGF（其他抽卡工具通用的格式）不主打：默认关着，打开开关才显示导入和导出（维护者：“别高调宣传，
 * 就纯粹在导入导出那边有个开关可以打开”）。开关记在本机。
 */
import { useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { formatDateTime, formatNumber } from '@/lib/format'
import { mhyDb } from '@/lib/mhy/db'
import { MHY_GAME_LABEL, type MhyAccount, type MhyGame } from '@/lib/mhy/types'
import { useMhyAccounts } from './accounts'
import MhyUigfPanel from './MhyUigfPanel.vue'

const props = defineProps<{ game: MhyGame }>()

const { accounts, account, select } = useMhyAccounts(() => props.game)
/** 每个账号的记录条数 */
const counts = useLiveQuery(
  async () => {
    const out: Record<string, number> = {}
    for (const a of accounts.value) out[a.id] = await mhyDb.pulls.where('accountId').equals(a.id).count()
    return out
  },
  [() => accounts.value.map((a) => a.id).join()],
  {} as Record<string, number>,
)
const rows = computed(() => accounts.value.toSorted((a, b) => (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0)))
const uigf = useLocalStorage('arkrecord:mhy:uigf', false)

function lastSync(a: MhyAccount): string {
  return a.lastSyncAt ? formatDateTime(a.lastSyncAt) : '—'
}
</script>

<template>
  <PageShell :id="`${game}-data`" title="数据" eyebrow="DATA" :require-account="false" :scoped="false">
    <div class="space-y-10">
      <section>
        <SectionHeader index="01" eyebrow="ON THIS COMPUTER" title="本机数据" />
        <p class="mb-3 text-sm text-muted">{{ MHY_GAME_LABEL[game] }}的记录只保存在这台电脑上（应用的数据目录），不上传。</p>
        <UEmpty v-if="!rows.length" icon="i-lucide-inbox" title="还没有记录" description="在任意页面右上角点“读取”，从游戏缓存读取抽卡记录。" />
        <ul v-else class="divide-y divide-default rounded-(--ui-radius) border border-default">
          <li v-for="a in rows" :key="a.id" class="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div class="min-w-0">
              <p class="text-sm font-medium text-highlighted">
                UID {{ a.uid }}
                <UBadge v-if="a.id === account?.id" label="当前" color="primary" variant="subtle" size="sm" class="ml-1" />
              </p>
              <p class="text-xs text-muted">{{ a.region || '区服未知（导入的记录）' }} · 上次读取 {{ lastSync(a) }}</p>
            </div>
            <div class="flex items-center gap-3">
              <span class="font-display text-sm text-muted">{{ formatNumber(counts[a.id] ?? 0) }} 条</span>
              <UButton v-if="a.id !== account?.id" label="切换到这个账号" size="xs" color="neutral" variant="outline" @click="select(a.id)" />
            </div>
          </li>
        </ul>
      </section>

      <section>
        <SectionHeader index="02" eyebrow="IMPORT & EXPORT" title="导入导出" />
        <div class="space-y-4 rounded-(--ui-radius) border border-default p-4">
          <USwitch v-model="uigf" label="UIGF 格式" description="其他抽卡记录工具通用的格式。打开后可以导入它们导出的记录，也可以把这里的记录导出成这种格式。" />
          <MhyUigfPanel v-if="uigf" :game="game" />
        </div>
      </section>
    </div>
  </PageShell>
</template>
