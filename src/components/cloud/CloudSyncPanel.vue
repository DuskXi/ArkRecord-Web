<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed, onMounted, ref } from 'vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { apiInfo } from '@/lib/cloud/api'
import { forgetCloud } from '@/lib/cloud/engine'
import { DESIGN_URL, SECURITY_URL } from '@/lib/cloud/links'
import { DEMO_ACCOUNT_ID } from '@/lib/demo'
import { formatDateTime } from '@/lib/format'
import { type Account, GAME_LABEL } from '@/lib/types'
import { useAppStore } from '@/stores/app'
import { useCloudStore } from '@/stores/cloud'

/** 数据页的“云同步”部分：每个账号的云同步状态和操作 */
const props = defineProps<{ index: string }>()
const app = useAppStore()
const cloud = useCloudStore()
const toast = useToast()

const accounts = computed(() => app.accounts.filter((a) => a.id !== DEMO_ACCOUNT_ID))

/** 服务器还没有配置云同步（例如测试环境还没设置 SYNC_PEPPER）时提示一下 */
const unavailable = ref(false)
onMounted(async () => {
  const info = await apiInfo()
  unavailable.value = info !== null && !info.available
})

async function forget(a: Account) {
  await forgetCloud(a.id)
  cloud.touchKeys()
  toast.add({ title: '已退出云同步', description: '只删除了这台设备上的钥匙和状态，云端数据还在。', color: 'neutral', icon: 'i-lucide-log-out' })
}

function menu(a: Account): DropdownMenuItem[][] {
  const entry = cloud.byAccount.get(a.id)
  if (!entry) return []
  const items: DropdownMenuItem[] = []
  if (entry.hasKeys) {
    items.push(
      { label: '修改密码', icon: 'i-lucide-key-round', onSelect: () => cloud.open('password', a.id) },
      {
        label: entry.state.requireHg ? '关闭双重验证' : '开启鹰角 token 双重验证',
        icon: 'i-lucide-shield-check',
        onSelect: () => cloud.open('twofactor', a.id),
      },
    )
  }
  return [
    items,
    [
      { label: '忘记密码：用这个浏览器的数据覆盖云端', icon: 'i-lucide-cloud-upload', onSelect: () => cloud.open('overwrite', a.id) },
      { label: '删除云端数据', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => cloud.open('delete', a.id) },
      { label: '退出云同步（只删除本机的钥匙）', icon: 'i-lucide-log-out', onSelect: () => forget(a) },
    ],
  ].filter((group) => group.length)
}
</script>

<template>
  <section>
    <SectionHeader :index="props.index" eyebrow="CLOUD SYNC" title="云同步">
      <UButton label="从云端恢复账号" icon="i-lucide-cloud-download" color="neutral" variant="outline" @click="cloud.open('restore')" />
    </SectionHeader>

    <UAlert
      v-if="unavailable"
      class="mb-3"
      color="warning"
      variant="subtle"
      icon="i-lucide-cloud-off"
      title="云同步暂时不可用"
      description="服务器还没有完成云同步的配置，请稍后再试。本地数据不受影响。"
    />
    <div class="mb-3 rounded-(--ui-radius) border border-primary/30 bg-primary/5 p-4 text-xs leading-relaxed text-muted">
      <p>
        在多个浏览器、多台设备之间合并同一个账号的记录。记录在你的浏览器里用<b class="text-highlighted">云同步密码</b>加密后才上传，服务器只保存密文，解不开；只知道 UID 的人拿不到任何东西。
        <b class="text-highlighted">密码无法找回</b>，所以本地仍然是主副本，请继续定期导出备份。
      </p>
      <p class="mt-1.5">
        <ULink :to="SECURITY_URL" target="_blank" class="text-primary">安全说明</ULink>
        ·
        <ULink :to="DESIGN_URL" target="_blank" class="text-primary">设计文档</ULink>
      </p>
    </div>

    <div v-if="accounts.length" class="divide-y divide-default rounded-(--ui-radius) border border-default">
      <div v-for="a in accounts" :key="a.id" class="flex flex-wrap items-center gap-3 p-4">
        <UIcon
          :name="cloud.byAccount.get(a.id) ? (cloud.byAccount.get(a.id)!.hasKeys ? 'i-lucide-cloud-check' : 'i-lucide-cloud-alert') : 'i-lucide-cloud'"
          class="size-5 shrink-0"
          :class="cloud.byAccount.get(a.id) ? (cloud.byAccount.get(a.id)!.hasKeys ? 'text-success' : 'text-warning') : 'text-dimmed'"
        />
        <div class="min-w-0 flex-1">
          <p class="flex flex-wrap items-center gap-1.5">
            <span class="truncate font-medium text-highlighted">{{ a.nickName }}</span>
            <UBadge :label="GAME_LABEL[a.game]" :color="a.game === 'arknights' ? 'primary' : 'warning'" variant="subtle" size="sm" />
            <UBadge v-if="cloud.byAccount.get(a.id)?.state.requireHg" label="双重验证" color="success" variant="subtle" size="sm" />
            <UBadge v-if="cloud.byAccount.get(a.id) && !cloud.byAccount.get(a.id)!.state.remember" label="不在本机保存钥匙" color="neutral" variant="subtle" size="sm" />
          </p>
          <p class="text-xs text-muted">
            UID {{ a.uid }} ·
            <template v-if="!cloud.byAccount.get(a.id)">未开通</template>
            <template v-else-if="!cloud.byAccount.get(a.id)!.hasKeys">已开通 · 这台设备需要输入密码</template>
            <template v-else>
              已开通 ·
              {{ cloud.byAccount.get(a.id)!.state.lastSyncAt ? `上次云同步 ${formatDateTime(cloud.byAccount.get(a.id)!.state.lastSyncAt!)}` : '尚未云同步' }}
              <UTooltip v-if="cloud.byAccount.get(a.id)!.state.fingerprint" text="数据指纹：两台设备的指纹相同，说明数据完全一致">
                <span class="font-mono text-dimmed"> · {{ cloud.byAccount.get(a.id)!.state.fingerprint!.slice(0, 8) }}</span>
              </UTooltip>
            </template>
          </p>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <template v-if="!cloud.byAccount.get(a.id)">
            <UButton label="开通" icon="i-lucide-cloud-upload" size="sm" variant="soft" @click="cloud.open('enable', a.id)" />
            <UButton label="已在别处开通" size="sm" color="neutral" variant="ghost" @click="cloud.open('unlock', a.id)" />
          </template>
          <template v-else>
            <UButton
              v-if="cloud.byAccount.get(a.id)!.hasKeys"
              label="云同步"
              icon="i-lucide-refresh-cw"
              size="sm"
              variant="soft"
              :loading="cloud.busy === a.id"
              :disabled="Boolean(cloud.busy)"
              @click="cloud.sync(a)"
            />
            <UButton v-else label="输入密码" icon="i-lucide-key-round" size="sm" variant="soft" @click="cloud.open('unlock', a.id)" />
            <UDropdownMenu :items="menu(a)" :content="{ align: 'end' }">
              <UButton icon="i-lucide-ellipsis" size="sm" color="neutral" variant="ghost" aria-label="更多操作" />
            </UDropdownMenu>
          </template>
        </div>
      </div>
    </div>
    <p v-else class="text-sm text-muted">添加账号后可以开通云同步；在新设备上，可以直接“从云端恢复账号”。</p>
  </section>
</template>
