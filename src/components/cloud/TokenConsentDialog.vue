<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import HgTokenField from '@/components/cloud/HgTokenField.vue'
import TokenDisclosure from '@/components/cloud/TokenDisclosure.vue'
import { createConsent } from '@/lib/cloud/consent'
import { GAME_LABEL } from '@/lib/types'
import { useCloudStore } from '@/stores/cloud'

/**
 * 发送鹰角 token 前的确认弹窗。只有点击“确认发送”才会创建同意（createConsent），
 * 之后的流程才能换取并发送鹰角 token（见 src/lib/cloud/consent.ts）。
 */
const cloud = useCloudStore()
const request = computed(() => cloud.consentRequest)

const pasted = ref('')
const ready = ref(false)
watch(request, () => {
  pasted.value = ''
  ready.value = false
})

/** 只有一个账号、没有保存登录、也没有刚才同步用过的登录时，需要粘贴 token */
const single = computed(() => (request.value?.accounts.length === 1 ? request.value.accounts[0] : undefined))
const needsPaste = computed(() => Boolean(single.value && !request.value?.accountToken))
/** 批量操作时，没有保存登录的账号无法检测 */
const missing = computed(() => (request.value && request.value.accounts.length > 1 ? request.value.accounts.filter((a) => !a.accountToken) : []))
const covered = computed(() => (request.value ? request.value.accounts.filter((a) => request.value!.accounts.length === 1 || a.accountToken) : []))

function cancel() {
  request.value?.resolve(null)
}

function confirm() {
  const r = request.value
  if (!r || (needsPaste.value && !ready.value) || !covered.value.length) return
  r.resolve(createConsent(covered.value.map((a) => a.id), { pasted: pasted.value || undefined, accountToken: r.accountToken }))
}
</script>

<template>
  <UModal
    :open="Boolean(request)"
    :title="request?.title ?? ''"
    description="需要你的确认"
    :ui="{ content: 'sm:max-w-xl' }"
    @update:open="(open: boolean) => !open && cancel()"
  >
    <template #body>
      <div v-if="request" class="space-y-4 text-sm">
        <div>
          <p class="mb-1.5 text-xs text-muted">涉及的账号</p>
          <ul class="space-y-1">
            <li v-for="a in covered" :key="a.id" class="flex flex-wrap items-center gap-1.5">
              <UBadge :label="GAME_LABEL[a.game]" :color="a.game === 'arknights' ? 'primary' : 'warning'" variant="subtle" size="sm" />
              <span class="font-medium text-highlighted">{{ a.nickName }}</span>
              <span class="font-mono text-xs text-muted">UID {{ a.uid }}</span>
            </li>
          </ul>
          <p v-if="missing.length" class="mt-1.5 text-xs text-warning">
            {{ missing.map((a) => a.nickName).join('、') }} 没有保存登录，这次不检测；可以在它们那一行单独检测（需要粘贴 token）。
          </p>
        </div>
        <TokenDisclosure :steps="request.steps" />
        <HgTokenField
          v-if="needsPaste"
          v-model="pasted"
          v-model:ready="ready"
          :account="single"
          reason="用哪一个鹰角登录来证明账号是你的。"
          hide-note
        />
        <p v-else-if="request.accountToken" class="text-xs text-muted">将使用刚才从鹰角同步记录时的登录。</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="取消" color="neutral" variant="ghost" @click="cancel" />
        <UButton label="确认发送" icon="i-lucide-send" :disabled="(needsPaste && !ready) || !covered.length" @click="confirm" />
      </div>
    </template>
  </UModal>
</template>
