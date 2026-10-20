<script setup lang="ts">
/**
 * 米哈游游戏的侧边栏（游戏切换下面的部分，由 src/platform/desktop.ts 交给 App.vue）：账号（UID）和导航。
 * 鹰角的账号和导航不在这里出现，切回鹰角用上面的厂商切换。
 */
import type { DropdownMenuItem, NavigationMenuItem } from '@nuxt/ui'
import { computed } from 'vue'
import { MHY_GAME_LABEL, type MhyGame } from '@/lib/mhy/types'
import { useMhyAccounts } from './accounts'
import { MHY_PROFILES } from './profile'

const props = defineProps<{ game: string; collapsed?: boolean }>()
const game = computed(() => props.game as MhyGame)
const { accounts, account, select } = useMhyAccounts(() => game.value)

/** 导入的账号可能看不出区服（UIGF 文件里没有，按 UID 也推断不出来） */
const regionText = (region: string) => region || '导入'

const base = computed(() => `/${game.value}`)
/** 和鹰角的导航一样（页面也是同一套，见 MhyGamePage）；路径见 src/platform/desktop.ts。图标名必须写成字面量，构建时才能被扫描并打包 */
const navItems = computed<NavigationMenuItem[]>(() => [
  { label: '总览', icon: 'i-lucide-layout-dashboard', to: base.value, exact: true },
  { label: MHY_PROFILES[game.value].recordName, icon: 'i-lucide-scroll-text', to: `${base.value}/records` },
  { label: '分析', icon: 'i-lucide-chart-column-big', to: `${base.value}/analysis` },
  { label: '高级统计', icon: 'i-lucide-telescope', to: `${base.value}/stats` },
  { label: '时间线', icon: 'i-lucide-git-commit-vertical', to: `${base.value}/timeline` },
  { label: '数据', icon: 'i-lucide-database', to: `${base.value}/data` },
])

const menuItems = computed<DropdownMenuItem[][]>(() => [
  accounts.value.map((a) => ({
    label: `UID ${a.uid}`,
    description: regionText(a.region),
    icon: a.id === account.value?.id ? 'i-lucide-circle-check' : 'i-lucide-circle',
    onSelect: () => select(a.id),
  })),
])
</script>

<template>
  <UDropdownMenu
    :items="menuItems"
    :disabled="accounts.length < 2"
    :content="{ align: 'start', collisionPadding: 12 }"
    :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width) min-w-56' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      block
      :square="collapsed"
      class="mt-2 data-[state=open]:bg-elevated"
      :class="collapsed ? '' : 'justify-start py-2'"
      :aria-label="`${MHY_GAME_LABEL[game]}账号`"
    >
      <UAvatar :text="MHY_GAME_LABEL[game].slice(0, 1)" size="sm" class="font-display" />
      <span v-if="!collapsed" class="min-w-0 flex-1 text-left leading-tight">
        <span class="block truncate text-sm font-medium text-highlighted">{{ account ? `UID ${account.uid}` : '还没有记录' }}</span>
        <span class="block truncate text-xs text-dimmed">{{ account ? `${MHY_GAME_LABEL[game]} · ${regionText(account.region)}` : `${MHY_GAME_LABEL[game]} · 先读取` }}</span>
      </span>
      <UIcon v-if="!collapsed && accounts.length > 1" name="i-lucide-chevrons-up-down" class="size-4 text-dimmed" />
    </UButton>
  </UDropdownMenu>
  <UNavigationMenu :collapsed="collapsed" :items="navItems" orientation="vertical" tooltip popover class="mt-2" aria-label="米哈游导航" />
</template>
