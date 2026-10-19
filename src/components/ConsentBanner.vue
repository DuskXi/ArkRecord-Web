<script setup lang="ts">
import { useAppStore } from '@/stores/app'

/**
 * 统计同意（Cookie 同意，见 src/lib/consent.ts）：欢迎窗口和旧数据迁移结束后显示在底部。
 * 用户做出选择之前不启用任何统计；“仅必要”只保留网站功能本身需要的本地存储。
 */
const app = useAppStore()
</script>

<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="translate-y-4 opacity-0"
    leave-active-class="transition duration-200 ease-in"
    leave-to-class="translate-y-4 opacity-0"
  >
    <section
      v-if="app.consentOpen"
      role="dialog"
      aria-labelledby="consent-title"
      class="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 mx-auto max-w-2xl rounded-(--ui-radius) border border-default bg-default/95 p-4 shadow-lg backdrop-blur lg:bottom-4"
    >
      <p id="consent-title" class="flex items-center gap-1.5 font-medium text-highlighted">
        <UIcon name="i-lucide-cookie" class="size-4 text-primary" />
        Cookie 与统计
      </p>
      <p class="mt-1 text-xs leading-relaxed text-muted">本站不用 Cookie 追踪你。下面两类数据由你决定：</p>
      <ul class="mt-2 space-y-1.5 text-xs leading-relaxed text-muted">
        <li>
          <b class="text-highlighted">必要（始终开启）</b>：在你的浏览器里保存你自己的寻访记录、账号和设置。只存在你的浏览器里，不会上传。
        </li>
        <li>
          <b class="text-highlighted">统计（可选）</b>：本站的匿名使用人数统计（不含账号和 UID；开通过云同步的，另外上报同步识别码的哈希，用来数独立用户），以及 Cloudflare Web Analytics（不使用 Cookie 的访问量统计）。
          <ULink to="/about#usage" class="text-primary">详细说明</ULink>
        </li>
      </ul>
      <div class="mt-3 flex flex-wrap justify-end gap-2">
        <UButton label="仅必要" color="neutral" variant="outline" size="sm" @click="app.setConsent('essential')" />
        <UButton label="全部接受" size="sm" @click="app.setConsent('all')" />
      </div>
    </section>
  </Transition>
</template>
