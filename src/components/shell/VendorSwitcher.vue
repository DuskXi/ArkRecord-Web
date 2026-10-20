<script setup lang="ts">
/**
 * 侧边栏顶部的厂商切换：鹰角 / 桌面版的其他厂商（米哈游）。网页版没有其他厂商，不显示（App.vue）。
 * 做成标签页的样子（文字 + 下划线），下面的游戏切换（GameSwitcher）是它的内容：两层看得出主次，不是两个一样的框叠着。
 * 收起侧边栏时竖排、只显示 short 的第一个字。
 */
import { computed } from 'vue'
import { EXTRA_VENDORS } from '@/platform'
import { HG_VENDOR, useActiveVendor } from '@/platform/active'

defineProps<{ collapsed?: boolean }>()
const { vendorId, openVendor } = useActiveVendor()
// 桌面版的“总览”排在最前（first），其余在鹰角后面
const items = computed(() =>
  [...EXTRA_VENDORS.filter((v) => v.first), HG_VENDOR, ...EXTRA_VENDORS.filter((v) => !v.first)].map((v) => ({ value: v.id, label: v.label, short: v.short })),
)
</script>

<template>
  <div
    role="radiogroup"
    aria-label="切换厂商"
    class="flex border-b border-default"
    :class="collapsed ? 'flex-col gap-0.5 pb-1' : 'gap-5 px-1'"
  >
    <button
      v-for="item in items"
      :key="item.value"
      type="button"
      role="radio"
      :aria-checked="vendorId === item.value"
      class="relative text-sm transition-colors"
      :class="[
        collapsed ? 'rounded-(--ui-radius) py-1 text-xs' : 'pt-0.5 pb-2',
        vendorId === item.value
          ? collapsed
            ? 'bg-primary/10 font-semibold text-primary'
            : 'font-semibold text-highlighted'
          : 'font-medium text-muted hover:text-default',
      ]"
      @click="openVendor(item.value)"
    >
      {{ collapsed ? item.short.slice(0, 1) : item.label }}
      <span v-if="!collapsed && vendorId === item.value" class="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" aria-hidden="true" />
    </button>
  </div>
</template>
