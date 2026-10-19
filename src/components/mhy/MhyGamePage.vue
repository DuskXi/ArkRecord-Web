<script setup lang="ts">
/**
 * 原神 / 星铁的页面（只在桌面版，见 src/platform/desktop.ts）：读取、统计、记录列表。
 * 数据在单独的库 arkrecord-mhy（src/lib/mhy/db.ts），和鹰角两款的页面互不影响。
 */
import { computed, ref } from 'vue'
import PageShell from '@/components/shell/PageShell.vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { mhyDb } from '@/lib/mhy/db'
import { MHY_GAME_LABEL, type MhyAccount, type MhyGame, type MhyPull } from '@/lib/mhy/types'
import MhyPullList from './MhyPullList.vue'
import MhyStats from './MhyStats.vue'
import MhySyncPanel from './MhySyncPanel.vue'

const props = defineProps<{ game: MhyGame; eyebrow: string }>()

const accounts = useLiveQuery(() => mhyDb.accounts.where('game').equals(props.game).toArray(), [() => props.game], [] as MhyAccount[])

// 选中的账号记在本机；没选过时用最近同步的那个
const selectedKey = computed(() => `arkrecord:mhy:${props.game}:account`)
function readSelected(): string | null {
  try {
    return localStorage.getItem(selectedKey.value)
  } catch {
    return null
  }
}
const selectedId = ref<string | null>(readSelected())
function select(id: string) {
  selectedId.value = id
  try {
    localStorage.setItem(selectedKey.value, id)
  } catch {
    // 存不了也不影响这次使用
  }
}

const account = computed<MhyAccount | undefined>(
  () => accounts.value.find((a) => a.id === selectedId.value) ?? accounts.value.toSorted((a, b) => (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0))[0],
)
const accountItems = computed(() => accounts.value.map((a) => ({ label: `UID ${a.uid}`, value: a.id })))

const pulls = useLiveQuery(
  () => (account.value ? mhyDb.pulls.where('accountId').equals(account.value.id).toArray() : []),
  [() => account.value?.id],
  [] as MhyPull[],
)

const lastSync = computed(() => (account.value?.lastSyncAt ? new Date(account.value.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : '—'))
</script>

<template>
  <PageShell :id="game" :eyebrow="eyebrow" :title="MHY_GAME_LABEL[game]" :require-account="false" :sync="false" :scoped="false">
    <template #actions>
      <USelect v-if="accounts.length > 1 && account" :model-value="account.id" :items="accountItems" class="w-44" @update:model-value="select(String($event))" />
    </template>

    <div class="space-y-8 p-4 sm:p-6">
      <section>
        <SectionHeader index="01" eyebrow="READ" title="读取抽卡记录" />
        <MhySyncPanel :game="game" @synced="select" />
      </section>

      <template v-if="account">
        <section>
          <SectionHeader index="02" eyebrow="SUMMARY" title="统计">
            <p class="text-xs text-muted">UID {{ account.uid }} · {{ account.region }} · 上次同步 {{ lastSync }}</p>
          </SectionHeader>
          <MhyStats :game="game" :pulls="pulls" />
          <p class="mt-2 text-xs text-muted">只统计记录里数得出来的抽数；保底规则还在按官方公示核对，暂不显示。官方接口只能查询最近一段时间的记录，ArkRecord 会把每次读到的都保存在本机。</p>
        </section>

        <section>
          <SectionHeader index="03" eyebrow="RECORDS" title="记录" />
          <MhyPullList :game="game" :pulls="pulls" />
        </section>
      </template>

      <UEmpty
        v-else
        icon="i-lucide-sparkles"
        :title="`还没有${MHY_GAME_LABEL[game]}的抽卡记录`"
        description="在游戏里打开一次抽卡记录，再点上面的“从游戏缓存读取”。记录只保存在这台电脑上。"
      />
    </div>
  </PageShell>
</template>
