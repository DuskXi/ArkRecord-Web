<script setup lang="ts">
import { MOBILE_NAV_ITEMS } from '@/navigation'
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-40 border-t border-default bg-default/90 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    aria-label="主导航"
  >
    <ul class="grid grid-cols-5">
      <li v-for="item in MOBILE_NAV_ITEMS" :key="item.to">
        <RouterLink
          :to="item.to"
          class="flex flex-col items-center gap-0.5 py-2 text-[11px] text-muted transition-colors"
          active-class="!text-primary"
          :exact-active-class="item.to === '/' ? '!text-primary' : undefined"
        >
          <UIcon :name="item.icon" class="size-5" />
          {{ item.label }}
        </RouterLink>
      </li>
    </ul>
  </nav>
</template>
