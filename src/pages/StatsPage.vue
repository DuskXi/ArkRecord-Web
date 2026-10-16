<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PlannerPanel from '@/components/PlannerPanel.vue'
import PageShell from '@/components/shell/PageShell.vue'
import CollectionPanel from '@/components/stats/CollectionPanel.vue'
import RecordsPanel from '@/components/stats/RecordsPanel.vue'
import SixStarPanel from '@/components/stats/SixStarPanel.vue'
import TimePanel from '@/components/stats/TimePanel.vue'
import { useRecordsStore } from '@/stores/records'

const records = useRecordsStore()
const route = useRoute()
const router = useRouter()

const TABS = [
  { label: '纪录', value: 'records', icon: 'i-lucide-trophy' },
  { label: '出红分析', value: 'six', icon: 'i-lucide-flame' },
  { label: '时段', value: 'time', icon: 'i-lucide-clock-3' },
  { label: '收集', value: 'collection', icon: 'i-lucide-gallery-vertical-end' },
  { label: '规划', value: 'planner', icon: 'i-lucide-calculator' },
]

/** 当前 Tab 记在地址里，刷新或分享链接时保持 */
const tab = computed({
  get: () => (TABS.some((t) => t.value === route.query.tab) ? (route.query.tab as string) : 'records'),
  set: (value: string) => void router.replace({ query: { ...route.query, tab: value } }),
})
</script>

<template>
  <PageShell id="stats" title="高级统计" eyebrow="INSIGHTS">
    <div v-if="!records.analysis.total" class="mt-10">
      <UEmpty icon="i-lucide-telescope" title="还没有可以统计的记录" description="同步或导入记录后，这里会显示纪录、出红分析、抽卡时段、收集与抽卡规划。" />
    </div>
    <div v-else class="space-y-6">
      <UTabs v-model="tab" :items="TABS" :content="false" class="w-full" :ui="{ list: 'overflow-x-auto' }" />
      <RecordsPanel v-if="tab === 'records'" />
      <SixStarPanel v-else-if="tab === 'six'" />
      <TimePanel v-else-if="tab === 'time'" />
      <CollectionPanel v-else-if="tab === 'collection'" />
      <template v-else>
        <PlannerPanel v-if="records.model.dist" />
        <p v-else class="rounded-(--ui-radius) border border-default p-4 text-sm text-muted">
          武器池只公布了“{{ records.model.hardPity }} 抽内必出 6★、80 抽必得 UP”，没有可靠的基础概率，暂不提供抽卡规划。切换到“角色”可以规划角色池。
        </p>
      </template>
    </div>
  </PageShell>
</template>
