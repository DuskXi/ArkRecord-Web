<script setup lang="ts">
/**
 * 原神（只在桌面版，见 src/platform/desktop.ts）。M2 进行中：读取抽卡链接、同步、记录列表和基础统计接在 src/lib/mhy/ 上。
 */
import PageShell from '@/components/shell/PageShell.vue'
</script>

<template>
  <PageShell id="genshin" eyebrow="GENSHIN IMPACT" title="原神" :require-account="false" :sync="false" :scoped="false">
    <UEmpty
      icon="i-lucide-hammer"
      title="原神正在开发中"
      description="桌面版会直接读取本机游戏缓存里的抽卡链接，由本机连接米哈游官方接口拉取祈愿记录，不经过任何服务器。这部分还在开发，稍后可用。"
      class="mt-16"
    />
  </PageShell>
</template>
