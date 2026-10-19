<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { db } from '@/lib/db'
import { formatDate } from '@/lib/format'
import { isDesktop } from '@/lib/transport'
import { GAME_LABEL } from '@/lib/types'
import { useCloudStore } from '@/stores/cloud'

/**
 * 同步识别码冲突（设计见 docs/rewrite/sync-user-id.md）：这个账号云端数据里的识别码和本机的对不上，问用户是不是同一个人。
 * 只在冲突时出现；云同步进行中不弹出。
 */
const cloud = useCloudStore()
const desktop = isDesktop()
const accounts = useLiveQuery(() => db.accounts.toArray(), [], [])

/** 一次问一个；账号已经删掉的不问 */
const current = computed(() => {
  for (const conflict of cloud.userConflicts.conflicts) {
    const account = accounts.value.find((a) => a.id === conflict.accountId)
    if (account) return { conflict, account }
  }
  return undefined
})
const saving = ref(false)

async function answer(choice: 'same' | 'other' | 'later') {
  if (!current.value || saving.value) return
  saving.value = true
  try {
    await cloud.answerUserConflict(current.value.account.id, choice)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="Boolean(current) && !cloud.busy"
    title="这个账号是你的吗？"
    description="云同步数据里的用户识别码和这台设备的不一样"
    :ui="{ content: 'sm:max-w-lg' }"
    @update:open="(open: boolean) => !open && answer('later')"
  >
    <template #body>
      <div v-if="current" class="space-y-3 text-sm">
        <p class="flex flex-wrap items-center gap-1.5">
          <UBadge :label="GAME_LABEL[current.account.game]" :color="current.account.game === 'arknights' ? 'primary' : 'warning'" variant="subtle" size="sm" />
          <span class="font-medium text-highlighted">{{ current.account.nickName }}</span>
          <span class="font-mono text-xs text-muted">UID {{ current.account.uid }}</span>
        </p>
        <p>
          这个账号的云同步数据里记的是另一个用户识别码（{{ formatDate(current.conflict.user.createdAt) }} 生成），
          这台{{ desktop ? '电脑' : '浏览器' }}上的是 {{ cloud.userConflicts.deviceCreatedAt ? formatDate(cloud.userConflicts.deviceCreatedAt) : '另一天' }} 生成的。
          可能是你在别的设备上用过云同步，也可能是别人的账号。
        </p>
        <ul class="list-disc space-y-1 pl-5 text-muted">
          <li><span class="text-highlighted">是同一个人</span>：保留先生成的识别码，这台设备和它上面开着云同步的账号都改用它，下次云同步时上传。</li>
          <li><span class="text-highlighted">不是我的账号</span>（借用别人的账号、几个人共用一台设备）：这台设备的识别码不变，也不会写进这个账号，以后不再问。</li>
          <li><span class="text-highlighted">以后再说</span>：这次什么都不改，下次云同步时再问。</li>
        </ul>
        <p class="text-xs text-muted">
          用户识别码是第一次开通云同步时生成的随机编号，不包含任何账号或设备信息，随加密的云同步数据保存，服务器看不到；只用来统计有多少独立用户（{{
            desktop ? '可以在“关于”页关闭统计' : '只在统计选了“全部接受”时上报'
          }}）。怎么回答都不影响云同步本身。
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton label="以后再说" color="neutral" variant="ghost" :disabled="saving" @click="answer('later')" />
        <UButton label="不是我的账号" color="neutral" variant="outline" :disabled="saving" @click="answer('other')" />
        <UButton label="是同一个人" icon="i-lucide-user-check" :loading="saving" @click="answer('same')" />
      </div>
    </template>
  </UModal>
</template>
