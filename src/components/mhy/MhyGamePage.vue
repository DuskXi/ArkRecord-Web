<script setup lang="ts">
/**
 * 原神 / 星铁的页面（只在桌面版，路由见 src/platform/desktop.ts）：提供米哈游的记录来源（records.ts），
 * 直接用鹰角的统计页面（总览、记录、分析、高级统计、时间线），右上角的“读取”（MhyReadButton）相当于鹰角的“同步”。
 * 还没有记录时显示读取面板。账号（UID）在侧边栏（MhySidebar）里切换，和这里共用（accounts.ts）。
 * 数据在单独的库 arkrecord-mhy（src/lib/mhy/db.ts），和鹰角两款的页面互不影响。
 */
import { computed, defineAsyncComponent, markRaw, reactive } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { provideRecords, type RecordsHost } from '@/composables/useRecords'
import { MHY_GAME_LABEL, type MhyGame } from '@/lib/mhy/types'
import { useMhyAccounts } from './accounts'
import { mhyIconUrl } from './icons'
import MhyReadButton from './MhyReadButton.vue'
import MhySyncPanel from './MhySyncPanel.vue'
import { useMhyRecords } from './records'

const props = defineProps<{ game: MhyGame; view: 'overview' | 'history' | 'analysis' | 'stats' | 'timeline' }>()

const VIEWS = {
  overview: defineAsyncComponent(() => import('@/pages/OverviewPage.vue')),
  history: defineAsyncComponent(() => import('@/pages/HistoryPage.vue')),
  analysis: defineAsyncComponent(() => import('@/pages/AnalysisPage.vue')),
  stats: defineAsyncComponent(() => import('@/pages/StatsPage.vue')),
  timeline: defineAsyncComponent(() => import('@/pages/TimelinePage.vue')),
}
const EYEBROW: Record<MhyGame, string> = { genshin: 'GENSHIN IMPACT', starrail: 'HONKAI: STAR RAIL' }

const source = useMhyRecords(() => props.game)
const { account } = useMhyAccounts(() => props.game)
const host: RecordsHost = reactive({
  actions: markRaw(MhyReadButton),
  playerName: computed(() => (account.value ? `UID ${account.value.uid}` : '')),
  base: computed(() => `/${props.game}`),
  avatar: (name: string) => mhyIconUrl(props.game, name),
  // 维护者 2026-10-20：图片全部不来自本项目，请求由本机直接发给社区服务器（完整的声明在“关于”页）
  imageCredit: '角色、武器、光锥图片全部来自 BWIKI，不来自本项目，由本机直接向 BWIKI 请求；图片版权归米哈游所有，本项目不拥有',
})
provideRecords(source, host)

const recordName = computed(() => source.profile.recordName)
</script>

<template>
  <component :is="VIEWS[view]" v-if="source.accountId" />
  <PageShell v-else :id="`${game}-read`" :eyebrow="`${EYEBROW[game]} · READ`" title="读取" :require-account="false" :sync="false" :scoped="false">
    <div class="space-y-8">
      <section>
        <SectionHeader index="01" eyebrow="READ" :title="`读取${recordName}`" />
        <MhySyncPanel :game="game" />
      </section>
      <UEmpty
        icon="i-lucide-sparkles"
        :title="`还没有${MHY_GAME_LABEL[game]}的抽卡记录`"
        description="在游戏里打开一次抽卡记录，再点上面的“从游戏缓存读取”。记录只保存在这台电脑上；读到以后，这里会换成总览、记录、分析等页面。"
      />
    </div>
  </PageShell>
</template>
