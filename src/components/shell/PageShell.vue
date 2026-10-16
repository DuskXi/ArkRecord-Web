<script setup lang="ts">
import { useAppStore } from '@/stores/app'
import { GAME_LABEL } from '@/lib/types'
import SyncButton from './SyncButton.vue'

withDefaults(defineProps<{ id: string; title: string; eyebrow?: string; requireAccount?: boolean; sync?: boolean }>(), {
  requireAccount: true,
  sync: true,
})
const app = useAppStore()
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
          <slot name="actions" />
          <SyncButton v-if="sync && app.activeAccount" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-7xl pb-24 lg:pb-6">
        <UEmpty
          v-if="requireAccount && !app.activeAccount"
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
      </div>
    </template>
  </UDashboardPanel>
</template>
