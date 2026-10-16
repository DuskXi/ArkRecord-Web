<script setup lang="ts">
import { onMounted } from 'vue'
import { markUsageNoticeSeen, usageNoticeSeen } from '@/lib/usage'
import { useAppStore } from '@/stores/app'

/** 第一次打开网站时说明匿名使用统计（只显示一次），并提供关闭入口 */
const app = useAppStore()
const toast = useToast()

onMounted(() => {
  if (usageNoticeSeen()) return
  markUsageNoticeSeen()
  setTimeout(() => {
    toast.add({
      title: '匿名使用统计',
      description: '本站会统计使用人数：每天最多上报一次“今天有人用过”，不含账号、UID、寻访记录或任何标识符。可以随时在“关于”页关闭。',
      icon: 'i-lucide-users-round',
      duration: 20000,
      actions: [
        { label: '知道了', color: 'neutral', variant: 'outline', size: 'xs' },
        {
          label: '不参与统计',
          color: 'neutral',
          variant: 'ghost',
          size: 'xs',
          onClick: () => {
            app.setUsageParticipation(false)
            toast.add({ title: '已关闭匿名统计', description: '可以在“关于”页重新开启。', color: 'neutral' })
          },
        },
      ],
    })
  }, 1500)
})
</script>

<template>
  <span hidden />
</template>
