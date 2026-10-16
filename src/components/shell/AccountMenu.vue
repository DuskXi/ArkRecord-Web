<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { GAME_LABEL } from '@/lib/types'
import { useAppStore } from '@/stores/app'

defineProps<{ collapsed?: boolean }>()
const app = useAppStore()
const router = useRouter()

const items = computed<DropdownMenuItem[][]>(() => [
  app.gameAccounts.map((a) => ({
    label: a.nickName,
    description: `UID ${a.uid}${a.channelName ? ` · ${a.channelName}` : ''}`,
    icon: a.id === app.activeAccount?.id ? 'i-lucide-circle-check' : 'i-lucide-circle',
    onSelect: () => app.selectAccount(a),
  })),
  [
    { label: '添加账号', icon: 'i-lucide-user-plus', onSelect: () => (app.loginOpen = true) },
    { label: '管理数据', icon: 'i-lucide-database', onSelect: () => router.push('/data') },
  ],
])
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'start', collisionPadding: 12 }" :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width) min-w-56' }">
    <UButton
      color="neutral"
      variant="ghost"
      block
      :square="collapsed"
      class="mt-2 data-[state=open]:bg-elevated"
      :class="collapsed ? '' : 'justify-start py-2'"
    >
      <UAvatar :text="app.activeAccount?.nickName.slice(0, 1) ?? '?'" size="sm" class="font-display" />
      <span v-if="!collapsed" class="min-w-0 flex-1 text-left leading-tight">
        <span class="block truncate text-sm font-medium text-highlighted">{{ app.activeAccount?.nickName ?? '未添加账号' }}</span>
        <span class="block truncate text-xs text-dimmed">
          {{ app.activeAccount ? `UID ${app.activeAccount.uid}` : `${GAME_LABEL[app.game]} · 点此添加` }}
        </span>
      </span>
      <UIcon v-if="!collapsed" name="i-lucide-chevrons-up-down" class="size-4 text-dimmed" />
    </UButton>
  </UDropdownMenu>
</template>
