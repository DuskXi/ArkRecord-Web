<script setup lang="ts">
/**
 * 原神 / 星铁的页面（只在桌面版，路由见 src/platform/desktop.ts）：统计（/genshin）和记录（/genshin/records）两页，
 * 最上面都是读取面板。账号在侧边栏（MhySidebar）里切换，和这里共用（accounts.ts）。
 * 数据在单独的库 arkrecord-mhy（src/lib/mhy/db.ts），和鹰角两款的页面互不影响。
 */
import { computed } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { mhyDb } from '@/lib/mhy/db'
import { MHY_GAME_LABEL, type MhyGame, type MhyPull } from '@/lib/mhy/types'
import { useMhyAccounts } from './accounts'
import MhyPullList from './MhyPullList.vue'
import MhyStats from './MhyStats.vue'
import MhySyncPanel from './MhySyncPanel.vue'

const props = defineProps<{ game: MhyGame; view: 'stats' | 'records' }>()

const EYEBROW: Record<MhyGame, string> = { genshin: 'GENSHIN IMPACT', starrail: 'HONKAI: STAR RAIL' }

const { account, select } = useMhyAccounts(() => props.game)
const pulls = useLiveQuery(
  () => (account.value ? mhyDb.pulls.where('accountId').equals(account.value.id).toArray() : []),
  [() => account.value?.id],
  [] as MhyPull[],
)

const lastSync = computed(() => (account.value?.lastSyncAt ? new Date(account.value.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : '—'))
</script>

<template>
  <PageShell
    :id="`${game}-${view}`"
    :eyebrow="`${EYEBROW[game]} · ${view === 'stats' ? 'SUMMARY' : 'RECORDS'}`"
    :title="view === 'stats' ? '统计' : '记录'"
    :require-account="false"
    :sync="false"
    :scoped="false"
  >
    <div class="space-y-8 p-4 sm:p-6">
      <section>
        <SectionHeader index="01" eyebrow="READ" title="读取抽卡记录" />
        <MhySyncPanel :game="game" @synced="select" />
      </section>

      <section v-if="account">
        <SectionHeader index="02" :eyebrow="view === 'stats' ? 'SUMMARY' : 'RECORDS'" :title="view === 'stats' ? '统计' : '记录'">
          <p class="text-xs text-muted">UID {{ account.uid }} · {{ account.region }} · 上次同步 {{ lastSync }}</p>
        </SectionHeader>
        <template v-if="view === 'stats'">
          <MhyStats :game="game" :pulls="pulls" />
          <p class="mt-2 text-xs text-muted">只统计记录里数得出来的抽数；保底规则还在按官方公示核对，暂不显示。官方接口只能查询最近一段时间的记录，ArkRecord 会把每次读到的都保存在本机。</p>
        </template>
        <MhyPullList v-else :game="game" :pulls="pulls" />
      </section>

      <UEmpty
        v-else
        icon="i-lucide-sparkles"
        :title="`还没有${MHY_GAME_LABEL[game]}的抽卡记录`"
        description="在游戏里打开一次抽卡记录，再点上面的“从游戏缓存读取”。记录只保存在这台电脑上。"
      />
    </div>
  </PageShell>
</template>
