<script setup lang="ts">
import BrandMark from '@/components/shell/BrandMark.vue'
import GameSwitcher from '@/components/shell/GameSwitcher.vue'
import AccountMenu from '@/components/shell/AccountMenu.vue'
import MobileNav from '@/components/shell/MobileNav.vue'
import UsageBadge from '@/components/shell/UsageBadge.vue'
import ConsentBanner from '@/components/ConsentBanner.vue'
import WelcomeDialog from '@/components/WelcomeDialog.vue'
import LoginModal from '@/components/LoginModal.vue'
import CloudDialog from '@/components/cloud/CloudDialog.vue'
import TokenConsentDialog from '@/components/cloud/TokenConsentDialog.vue'
import LegacyMigration from '@/components/LegacyMigration.vue'
import AnnouncementDialog from '@/components/announcements/AnnouncementDialog.vue'
import DesktopTitleBar from '@/components/shell/DesktopTitleBar.vue'
import { computed } from 'vue'
import { isDesktop } from '@/lib/transport'
import { navItemsFor } from '@/navigation'
import { useAnnouncementsStore } from '@/stores/announcements'
import { APP_VERSION, useAppStore } from '@/stores/app'

const app = useAppStore()
const announcements = useAnnouncementsStore()
/** 桌面版用自己的标题栏（DesktopTitleBar，高 40px）：页面整体往下让出这一条，通知也放到它下面 */
const desktop = isDesktop()
/** 有没看过的更新公告时，在“更新公告”旁边标出数量 */
const navItems = computed(() =>
  navItemsFor(app.game).map((item) =>
    item.to === '/announcements' && announcements.unreadCount
      ? { ...item, badge: { label: String(announcements.unreadCount), color: 'error' as const, variant: 'solid' as const, size: 'sm' as const } }
      : item,
  ),
)
</script>

<template>
  <UApp :toaster="desktop ? { position: 'top-center', ui: { viewport: 'top-14' } } : { position: 'top-center' }" :tooltip="{ delayDuration: 200 }">
    <DesktopTitleBar v-if="desktop" />
    <UDashboardGroup unit="rem" storage="local" storage-key="arkrecord-layout" :class="desktop ? 'top-10' : undefined">
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
          <UNavigationMenu :collapsed="collapsed" :items="navItems" orientation="vertical" tooltip popover class="mt-2" />
        </template>

        <template #footer="{ collapsed }">
          <div class="flex w-full min-w-0 flex-col gap-1">
            <UsageBadge :collapsed="collapsed" class="px-1" />
            <div class="flex w-full items-center gap-1" :class="collapsed ? 'flex-col' : ''">
              <UColorModeButton color="neutral" variant="ghost" />
              <UTooltip v-if="!collapsed" text="更新公告">
                <ULink to="/announcements" class="inline-flex items-center gap-1 font-display text-xs text-dimmed hover:text-primary">
                  v{{ APP_VERSION }}
                  <span v-if="announcements.unreadCount" class="size-1.5 rounded-full bg-error" />
                </ULink>
              </UTooltip>
            </div>
          </div>
        </template>
      </UDashboardSidebar>

      <RouterView />
    </UDashboardGroup>

    <MobileNav />
    <LoginModal />
    <CloudDialog />
    <TokenConsentDialog />
    <LegacyMigration />
    <AnnouncementDialog />
    <WelcomeDialog />
    <ConsentBanner />
  </UApp>
</template>
