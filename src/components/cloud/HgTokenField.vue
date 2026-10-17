<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { HG_VERIFY_URL } from '@/lib/cloud/links'
import { parseAccountToken } from '@/lib/hg/auth'
import type { Account } from '@/lib/types'

/**
 * 鹰角 token：只用来让服务器核实这个 UID 属于你（worker/hg-verify.ts），核实完立即丢弃。
 * 账号保存了登录时直接用；否则粘贴账号 token（与“添加账号”时相同）。
 */
const props = defineProps<{ account?: Account; reason: string; hideNote?: boolean }>()
const pasted = defineModel<string>({ default: '' })
const ready = defineModel<boolean>('ready', { default: false })

const useOther = ref(false)
const hasSaved = computed(() => Boolean(props.account?.accountToken) && !useOther.value)
const parsed = computed(() => parseAccountToken(pasted.value))
watchEffect(() => (ready.value = hasSaved.value || parsed.value !== null))
watchEffect(() => {
  // 使用已保存的登录时，不带粘贴的内容
  if (hasSaved.value) pasted.value = ''
})
</script>

<template>
  <div class="space-y-2 rounded-(--ui-radius) border border-default p-3">
    <p class="flex items-center gap-1.5 text-sm font-medium text-highlighted">
      <UIcon name="i-lucide-badge-check" class="size-4 text-primary" />
      鹰角 token
    </p>
    <p class="text-xs leading-relaxed text-muted">{{ reason }}</p>
    <div v-if="hasSaved" class="flex flex-wrap items-center gap-2 text-xs">
      <UBadge label="将使用这个账号保存的登录" color="success" variant="subtle" icon="i-lucide-check" />
      <UButton label="改用其他 token" size="xs" color="neutral" variant="link" @click="useOther = true" />
    </div>
    <template v-else>
      <UTextarea
        v-model="pasted"
        :rows="2"
        autoresize
        spellcheck="false"
        class="w-full font-mono text-xs"
        placeholder="粘贴账号 token：登录鹰角网络通行证后，打开 web-api.hypergryph.com/account/info/hg 复制整页内容"
      />
      <p v-if="pasted && !parsed" class="text-xs text-error">无法识别这个 token，请复制整页内容。</p>
    </template>
    <p v-if="!hideNote" class="text-xs leading-relaxed text-dimmed">
      服务器用它查询鹰角的角色绑定列表，确认这个 UID 是你的，核实完立即丢弃，不保存、不记录。提交前会再请你确认。
      <ULink :to="HG_VERIFY_URL" target="_blank" class="text-primary">查看这段代码</ULink>
    </p>
  </div>
</template>
