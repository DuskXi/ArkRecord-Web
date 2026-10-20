<script setup lang="ts">
/**
 * 记录里很久没有记录的空档（米哈游，src/lib/mhy/gaps.ts）：说明空档后的抽数为什么是“未知”。鹰角两款没有空档标记，不显示。
 */
import { computed } from 'vue'
import { useRecords } from '@/composables/useRecords'
import { formatDate } from '@/lib/format'
import { listGaps } from '@/lib/stats/gaps'

const records = useRecords()
const gaps = computed(() => listGaps(records.events))
const top = computed(() => records.profile.topStar)
</script>

<template>
  <UAlert v-if="gaps.length" color="warning" variant="subtle" icon="i-lucide-calendar-x" :title="`有 ${gaps.length} 段很长时间没有记录`">
    <template #description>
      <ul class="space-y-0.5">
        <li v-for="g in gaps" :key="g.to" class="font-display">{{ formatDate(g.from) }} — {{ formatDate(g.to) }}（{{ g.days }} 天）</li>
      </ul>
      <p class="mt-1">
        官方只保留最近一段时间的记录，这段时间里抽的卡可能已经查不到了，所以空档前后的抽数不接着算：空档后每个保底分组的第一个 {{ top }}★
        抽数显示“未知”，不计入平均和运气；大小保底从空档后重新判断。如果这段时间确实没有抽卡，可以忽略这条提示。
      </p>
    </template>
  </UAlert>
</template>
