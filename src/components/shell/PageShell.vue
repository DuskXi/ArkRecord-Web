<script setup lang="ts">
import { useRecords, useRecordsHost } from '@/composables/useRecords'
import { useAppStore } from '@/stores/app'
import { GAME_LABEL } from '@/lib/types'
import CloudStatusButton from './CloudStatusButton.vue'
import DemoBanner from './DemoBanner.vue'
import ScopeSwitch from './ScopeSwitch.vue'
import SyncButton from './SyncButton.vue'

withDefaults(
  defineProps<{ id: string; title: string; eyebrow?: string; requireAccount?: boolean; sync?: boolean; scoped?: boolean }>(),
  {
    requireAccount: true,
    sync: true,
    // 页面内容是否按终末地的“角色 / 武器”范围显示
    scoped: true,
  },
)
const app = useAppStore()
const records = useRecords()
/** 别的记录来源（米哈游）的页面：不显示鹰角的同步、云同步、演示数据提示和“添加账号”，右上角换成它自己的按钮 */
const host = useRecordsHost()
</script>

<template>
  <UDashboardPanel :id="id">
    <template #header>
      <UDashboardNavbar :ui="{ root: 'border-b border-default', title: 'min-w-0' }">
        <template #title>
          <div class="min-w-0 leading-tight">
            <p class="eyebrow truncate">{{ eyebrow ?? id.toUpperCase() }}</p>
            <h1 class="truncate text-base font-semibold text-highlighted">{{ title }}</h1>
          </div>
        </template>
        <template #right>
          <ScopeSwitch v-if="scoped && records.profile.hasScope && records.accountId" />
          <slot name="actions" />
          <component :is="host.actions" v-if="sync && host?.actions" />
          <CloudStatusButton v-if="sync && !host && app.activeAccount" />
          <SyncButton v-if="sync && !host && app.activeAccount" />
        </template>
      </UDashboardNavbar>
      <DemoBanner v-if="!host" />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-screen-2xl pb-24 lg:pb-6">
        <UEmpty
          v-if="requireAccount && !host && !app.activeAccount"
          icon="i-lucide-user-round-plus"
          :title="`还没有添加${GAME_LABEL[app.game]}账号`"
          description="粘贴鹰角通行证的账号 token 即可同步寻访记录。所有数据只保存在你的浏览器里。"
          :actions="[
            { label: '添加账号', icon: 'i-lucide-plus', onClick: () => (app.loginOpen = true) },
            { label: '导入旧数据', icon: 'i-lucide-upload', color: 'neutral', variant: 'outline', to: '/data' },
          ]"
          class="mt-16"
        />
        <slot v-else />
        <!-- 米哈游页面的图片来源声明（侧边栏没有“关于”，每页底部写一行） -->
        <p v-if="host?.imageCredit" class="mt-10 text-center text-[11px] leading-relaxed text-dimmed">{{ host.imageCredit }}</p>
      </div>
    </template>
  </UDashboardPanel>
</template>
