<script setup lang="ts">
import BrandMark from '@/components/shell/BrandMark.vue'
import GameSwitcher from '@/components/shell/GameSwitcher.vue'
import AccountMenu from '@/components/shell/AccountMenu.vue'
import MobileNav from '@/components/shell/MobileNav.vue'
import LoginModal from '@/components/LoginModal.vue'
import LegacyMigration from '@/components/LegacyMigration.vue'
import { NAV_ITEMS } from '@/navigation'
import { APP_VERSION } from '@/stores/app'
</script>

<template>
  <UApp :toaster="{ position: 'top-center' }" :tooltip="{ delayDuration: 200 }">
    <UDashboardGroup unit="rem" storage="local" storage-key="arkrecord-layout">
      <UDashboardSidebar
        id="main"
        collapsible
        resizable
        :min-size="14"
        :default-size="16"
        :max-size="20"
        :collapsed-size="4.25"
        :ui="{ root: 'bg-elevated/40', footer: 'border-t border-default' }"
      >
        <template #header="{ collapsed }">
          <BrandMark :collapsed="collapsed" />
        </template>

        <template #default="{ collapsed }">
          <GameSwitcher :collapsed="collapsed" />
          <AccountMenu :collapsed="collapsed" />
          <UNavigationMenu :collapsed="collapsed" :items="NAV_ITEMS" orientation="vertical" tooltip popover class="mt-2" />
        </template>

        <template #footer="{ collapsed }">
          <div class="flex w-full items-center gap-1" :class="collapsed ? 'flex-col' : ''">
            <UColorModeButton color="neutral" variant="ghost" />
            <span v-if="!collapsed" class="font-display text-xs text-dimmed">v{{ APP_VERSION }}</span>
          </div>
        </template>
      </UDashboardSidebar>

      <RouterView />
    </UDashboardGroup>

    <MobileNav />
    <LoginModal />
    <LegacyMigration />
  </UApp>
</template>
