<script setup lang="ts">
import type { ButtonProps } from '@nuxt/ui'
import { computed } from 'vue'
import { deleteAccountData } from '@/lib/archive'
import { DEMO_ACCOUNT_ID } from '@/lib/demo'
import { useAppStore } from '@/stores/app'

/** 正在查看演示数据时，每个页面顶部常驻提示，并给出切换到真实数据的入口 */
const app = useAppStore()
const toast = useToast()

const visible = computed(() => app.activeAccount?.id === DEMO_ACCOUNT_ID)
/** 已经添加过的真实账号 */
const realAccount = computed(() => app.gameAccounts.find((a) => a.id !== DEMO_ACCOUNT_ID) ?? null)

async function removeDemo() {
  await deleteAccountData(DEMO_ACCOUNT_ID)
  toast.add({ title: '已删除演示数据', color: 'neutral', icon: 'i-lucide-trash-2' })
}

const actions = computed<ButtonProps[]>(() => [
  realAccount.value
    ? {
        label: `切换到 ${realAccount.value.nickName}`,
        icon: 'i-lucide-arrow-left-right',
        color: 'neutral',
        variant: 'solid',
        onClick: () => app.selectAccount(realAccount.value!),
      }
    : { label: '添加我的账号', icon: 'i-lucide-user-round-plus', color: 'neutral', variant: 'solid', onClick: () => (app.loginOpen = true) },
  { label: '删除演示数据', icon: 'i-lucide-trash-2', color: 'neutral', variant: 'outline', onClick: removeDemo },
])
</script>

<template>
  <UBanner v-if="visible" icon="i-lucide-flask-conical" color="primary" :actions="actions">
    <template #title>
      <span class="sm:hidden">演示数据</span>
      <span class="max-sm:hidden">正在查看演示数据：这些记录是模拟生成的，不是你的寻访记录。</span>
    </template>
  </UBanner>
</template>
