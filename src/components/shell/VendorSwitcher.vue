<script setup lang="ts">
/** 侧边栏顶部的厂商切换：鹰角 / 桌面版的其他厂商（米哈游）。网页版没有其他厂商，不显示（App.vue） */
import { computed } from 'vue'
import { EXTRA_VENDORS } from '@/platform'
import { HG_VENDOR, useActiveVendor } from '@/platform/active'
import SegmentSwitch from './SegmentSwitch.vue'

defineProps<{ collapsed?: boolean }>()
const { vendorId, openVendor } = useActiveVendor()
const items = computed(() => [HG_VENDOR, ...EXTRA_VENDORS].map((v) => ({ value: v.id, label: v.label, short: v.short })))
</script>

<template>
  <SegmentSwitch :items="items" :active="vendorId" label="切换厂商" :collapsed="collapsed" @select="openVendor" />
</template>
