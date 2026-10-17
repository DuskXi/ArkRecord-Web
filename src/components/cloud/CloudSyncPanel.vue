<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed, onMounted, ref } from 'vue'
import SectionHeader from '@/components/ui/SectionHeader.vue'
import { apiInfo } from '@/lib/cloud/api'
import { forgetCloud } from '@/lib/cloud/engine'
import { DESIGN_URL, SECURITY_URL } from '@/lib/cloud/links'
import { clearProfile } from '@/lib/cloud/profile'
import { DEMO_ACCOUNT_ID } from '@/lib/demo'
import { formatDateTime } from '@/lib/format'
import { type Account, GAME_LABEL } from '@/lib/types'
import { useAppStore } from '@/stores/app'
import { MODE_LABEL, useCloudStore } from '@/stores/cloud'

/** 数据页的“云同步”部分：每个账号的云同步状态和操作、检测云端状态、同步配置 */
const props = defineProps<{ index: string }>()
const app = useAppStore()
const cloud = useCloudStore()
const toast = useToast()

const accounts = computed(() => app.accounts.filter((a) => a.id !== DEMO_ACCOUNT_ID))
/** 这台设备上已开通、模式和同步配置不一样的账号 */
const mismatched = computed(() =>
  cloud.profile ? accounts.value.filter((a) => {
    const e = cloud.byAccount.get(a.id)
    return e && e.state.mode !== cloud.profile!.mode
  }) : [],
)

/** 这台设备上还没开通、保存了登录的账号：可以一起检测 */
const detectable = computed(() => accounts.value.filter((a) => !cloud.byAccount.has(a.id) && a.accountToken))

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

async function removeProfile() {
  await clearProfile()
  await cloud.refreshProfile()
  toast.add({ title: '已删除同步配置', description: '已开通的账号不受影响。', color: 'neutral', icon: 'i-lucide-trash-2' })
}

function statusText(a: Account): string {
  const entry = cloud.byAccount.get(a.id)
  if (entry) {
    if (!entry.hasKeys) return '已开通 · 这台设备需要输入密码'
    return `已开通 · ${entry.state.lastSyncAt ? `上次云同步 ${formatDateTime(entry.state.lastSyncAt)}` : '尚未云同步'}`
  }
  const d = cloud.detected.get(a.id)
  if (!d) return '这台设备上未开通'
  if (!d.status.exists) return '云端还没有开通'
  return d.status.mode === 'hg' ? '云端已开通（无密码模式），这台设备还没连接' : '云端已开通，这台设备还没启用'
}

/** 账号的模式标记：无密码模式 / 双重验证 */
function modeBadge(a: Account): { label: string; color: 'warning' | 'success' } | null {
  const entry = cloud.byAccount.get(a.id)
  const status = entry ? { exists: true, mode: entry.state.mode, requireHg: entry.state.requireHg } : cloud.detected.get(a.id)?.status
  if (!status?.exists) return null
  if (status.mode === 'hg') return { label: '无密码模式', color: 'warning' }
  return status.requireHg ? { label: '双重验证', color: 'success' } : null
}

function icon(a: Account): { name: string; class: string } {
  const entry = cloud.byAccount.get(a.id)
  if (entry) return entry.hasKeys ? { name: 'i-lucide-cloud-check', class: 'text-success' } : { name: 'i-lucide-cloud-alert', class: 'text-warning' }
  const d = cloud.detected.get(a.id)?.status
  if (d) return d.exists ? { name: 'i-lucide-cloud', class: 'text-primary' } : { name: 'i-lucide-cloud-off', class: 'text-dimmed' }
  return { name: 'i-lucide-cloud', class: 'text-dimmed' }
}

/** 已开通账号的更多操作 */
function menu(a: Account): DropdownMenuItem[][] {
  const entry = cloud.byAccount.get(a.id)
  if (!entry) return []
  const items: DropdownMenuItem[] = []
  const hg = entry.state.mode === 'hg'
  if (hg) {
    items.push({ label: '切换为密码模式（覆盖云端，推荐）', icon: 'i-lucide-lock-keyhole', onSelect: () => cloud.open('switch', a.id) })
  } else if (entry.hasKeys) {
    items.push(
      { label: '修改密码', icon: 'i-lucide-key-round', onSelect: () => cloud.open('password', a.id) },
      {
        label: entry.state.requireHg ? '关闭双重验证' : '开启鹰角 token 双重验证',
        icon: 'i-lucide-shield-check',
        onSelect: () => cloud.open('twofactor', a.id),
      },
    )
  }
  if (!hg && cloud.hgAvailable !== false) {
    items.push({ label: '切换为无密码模式（覆盖云端，不推荐）', icon: 'i-lucide-key-square', onSelect: () => cloud.open('switch', a.id) })
  }
  if (!entry.hasKeys && cloud.profile) items.push({ label: '手动输入密码', icon: 'i-lucide-key-round', onSelect: () => cloud.open('unlock', a.id) })
  return [
    items,
    [
      { label: hg ? '用这个浏览器的数据覆盖云端' : '忘记密码：用这个浏览器的数据覆盖云端', icon: 'i-lucide-cloud-upload', onSelect: () => cloud.open('overwrite', a.id) },
      { label: '删除云端数据', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => cloud.open('delete', a.id) },
      { label: hg ? '退出云同步（只删除本机的状态）' : '退出云同步（只删除本机的钥匙）', icon: 'i-lucide-log-out', onSelect: () => forget(a) },
    ],
  ].filter((group) => group.length)
}

/** 还没开通的账号：一键启用以外的操作 */
function startMenu(a: Account): DropdownMenuItem[][] {
  const d = cloud.detected.get(a.id)
  const existing = d?.status.exists ? d.status : null
  return [
    existing
      ? [
          {
            label: `切换为${existing.mode === 'hg' ? '密码模式' : '无密码模式'}（覆盖云端）`,
            icon: 'i-lucide-repeat',
            onSelect: () => cloud.open('switch', a.id),
          },
        ]
      : [],
    d ? [] : [{ label: '只检测云端状态', icon: 'i-lucide-search-check', onSelect: () => void cloud.detect([a]) }],
    [
      { label: '手动开通', icon: 'i-lucide-cloud-upload', onSelect: () => cloud.open('enable', a.id) },
      { label: '已在别处开通：手动输入密码', icon: 'i-lucide-key-round', onSelect: () => cloud.open('unlock', a.id) },
      {
        label: '已在别处用无密码模式开通：连接',
        icon: 'i-lucide-link',
        onSelect: () => (cloud.dialog = { mode: 'unlock', accountId: a.id, hg: true }),
      },
      { label: '忘记密码：用这个浏览器的数据覆盖云端', icon: 'i-lucide-cloud-upload', onSelect: () => cloud.open('overwrite', a.id) },
    ],
  ].filter((group) => group.length)
}
</script>

<template>
  <section>
    <SectionHeader :index="props.index" eyebrow="CLOUD SYNC" title="云同步">
      <div class="flex flex-wrap gap-2">
        <UButton
          v-if="detectable.length"
          :label="detectable.length > 1 ? '检测全部账号的云端状态' : '检测云端状态'"
          icon="i-lucide-search-check"
          color="neutral"
          variant="outline"
          :disabled="Boolean(cloud.busy)"
          @click="cloud.detect(detectable)"
        />
        <UButton label="从云端恢复账号" icon="i-lucide-cloud-download" color="neutral" variant="outline" @click="cloud.open('restore')" />
      </div>
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
        在多个浏览器、多台设备之间合并同一个账号的记录。记录在你的浏览器里用<b class="text-highlighted">云同步密码</b>加密后才上传，服务器只保存密文，解不开；只知道 UID 的人拿不到任何东西。<b class="text-highlighted">密码无法找回</b>，所以本地仍然是主副本，请继续定期导出备份。
      </p>
      <p class="mt-1.5">
        检测云端状态、开通、双重验证都需要把鹰角 token 发给服务器，证明账号是你的：只在你点击按钮、并在确认窗口里点“确认发送”之后才会发送，服务器核实完立即丢弃。
      </p>
      <p class="mt-1.5">
        也可以选<b class="text-highlighted">无密码模式</b>（不推荐）：不用记密码，每次云同步都用鹰角 token 验证。当前实现中，token 只在服务器核实请求时存在于内存里，不会出现在日志和硬盘里，代码接受审计；代价是本站运营者和拿到你有效鹰角 token 的人技术上能读取你的云端记录。开通时可以选择，之后随时可以切换。
      </p>
      <p class="mt-1.5">
        <ULink :to="SECURITY_URL" target="_blank" class="text-primary">安全说明</ULink>
        ·
        <ULink :to="DESIGN_URL" target="_blank" class="text-primary">设计文档</ULink>
      </p>
    </div>

    <!-- 同步配置 -->
    <div class="mb-3 flex flex-wrap items-center gap-3 rounded-(--ui-radius) border border-default p-4">
      <UIcon name="i-lucide-settings-2" class="size-5 shrink-0" :class="cloud.profile ? 'text-primary' : 'text-dimmed'" />
      <div class="min-w-0 flex-1">
        <p class="font-medium text-highlighted">同步配置</p>
        <p v-if="cloud.profile?.mode === 'hg'" class="text-xs text-muted">
          已保存在这台设备上 · 新开通的账号用<b class="text-warning">无密码模式</b> · {{ formatDateTime(cloud.profile.savedAt) }}
        </p>
        <p v-else-if="cloud.profile" class="text-xs text-muted">
          已保存在这台设备上 · 新开通的账号{{ cloud.profile.requireHg ? '开启' : '不开启' }}双重验证 ·
          {{ cloud.profile.remember ? '记在这台设备上' : '只保存到关闭网页' }} · {{ formatDateTime(cloud.profile.savedAt) }}
        </p>
        <p v-else class="text-xs text-muted">
          没有保存。保存后，账号点“一键启用”就能开通或解锁，不用再输入密码。只存在这台设备的这个浏览器里，不上传，不包含鹰角登录。
        </p>
      </div>
      <div class="flex gap-1.5">
        <UButton :label="cloud.profile ? '修改' : '设置'" size="sm" color="neutral" variant="outline" @click="cloud.open('profile')" />
        <UButton v-if="cloud.profile" label="删除" size="sm" color="error" variant="ghost" @click="removeProfile" />
      </div>
      <div v-if="cloud.profile && mismatched.length" class="w-full space-y-2 rounded-(--ui-radius) border border-error/40 bg-error/5 p-3 text-xs leading-relaxed">
        <p class="flex items-center gap-1.5 text-sm font-medium text-highlighted">
          <UIcon name="i-lucide-triangle-alert" class="size-4 text-error" />
          {{ mismatched.length }} 个已开通的账号和同步配置的模式不一样
        </p>
        <p class="text-muted">
          {{ mismatched.map((a) => a.nickName).join('、') }} 现在是{{ MODE_LABEL[cloud.profile.mode === 'hg' ? 'password' : 'hg'] }}。切换为{{
            MODE_LABEL[cloud.profile.mode]
          }}要<b class="text-error">覆盖云端</b>：先下载云端的记录合并到这个浏览器，再换一把新钥匙替换云端的全部数据；其他设备需要重新启用（{{
            cloud.profile.mode === 'hg' ? '用鹰角登录连接' : '输入新的云同步密码'
          }}）。
        </p>
        <UButton
          :label="`全部切换为${MODE_LABEL[cloud.profile.mode]}（覆盖云端）`"
          icon="i-lucide-repeat"
          size="sm"
          color="error"
          variant="soft"
          :disabled="Boolean(cloud.busy)"
          @click="cloud.switchAccounts(mismatched)"
        />
      </div>
    </div>

    <div v-if="accounts.length" class="divide-y divide-default rounded-(--ui-radius) border border-default">
      <div v-for="a in accounts" :key="a.id" class="p-4">
        <div class="flex flex-wrap items-center gap-3">
          <UIcon :name="icon(a).name" class="size-5 shrink-0" :class="icon(a).class" />
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-1.5">
              <span class="truncate font-medium text-highlighted">{{ a.nickName }}</span>
              <UBadge :label="GAME_LABEL[a.game]" :color="a.game === 'arknights' ? 'primary' : 'warning'" variant="subtle" size="sm" />
              <UBadge v-if="modeBadge(a)" :label="modeBadge(a)!.label" :color="modeBadge(a)!.color" variant="subtle" size="sm" />
              <UBadge
                v-if="cloud.profile && cloud.byAccount.get(a.id) && cloud.byAccount.get(a.id)!.state.mode !== cloud.profile.mode"
                label="与同步配置的模式不同"
                color="error"
                variant="outline"
                size="sm"
              />
              <UBadge
                v-if="cloud.byAccount.get(a.id) && cloud.byAccount.get(a.id)!.state.mode === 'password' && !cloud.byAccount.get(a.id)!.state.remember"
                label="不在本机保存钥匙"
                color="neutral"
                variant="subtle"
                size="sm"
              />
            </p>
            <p class="text-xs text-muted">
              UID {{ a.uid }} · {{ statusText(a) }}
              <UTooltip v-if="cloud.byAccount.get(a.id)?.hasKeys && cloud.byAccount.get(a.id)!.state.fingerprint" text="数据指纹：两台设备的指纹相同，说明数据完全一致">
                <span class="font-mono text-dimmed"> · {{ cloud.byAccount.get(a.id)!.state.fingerprint!.slice(0, 8) }}</span>
              </UTooltip>
            </p>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <!-- 这台设备上已开通 -->
            <template v-if="cloud.byAccount.get(a.id)">
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
              <UButton
                v-else-if="cloud.profile"
                label="一键解锁"
                icon="i-lucide-zap"
                size="sm"
                variant="soft"
                :loading="cloud.busy === a.id"
                :disabled="Boolean(cloud.busy)"
                @click="cloud.quickStart(a)"
              />
              <UButton v-else label="输入密码" icon="i-lucide-key-round" size="sm" variant="soft" @click="cloud.open('unlock', a.id)" />
              <UDropdownMenu :items="menu(a)" :content="{ align: 'end' }">
                <UButton icon="i-lucide-ellipsis" size="sm" color="neutral" variant="ghost" aria-label="更多操作" />
              </UDropdownMenu>
            </template>

            <!-- 还没开通：一键启用（没有同步配置时先设置），也可以按检测结果手动操作 -->
            <template v-else>
              <UButton
                label="一键启用"
                icon="i-lucide-zap"
                size="sm"
                variant="soft"
                :loading="cloud.busy === a.id"
                :disabled="Boolean(cloud.busy)"
                @click="cloud.quickStart(a)"
              />
              <template v-if="!cloud.profile">
                <UButton
                  v-if="!cloud.detected.get(a.id)"
                  label="检测云端状态"
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  :disabled="Boolean(cloud.busy)"
                  @click="cloud.detect([a])"
                />
                <UButton
                  v-else-if="cloud.detected.get(a.id)!.status.exists"
                  :label="modeBadge(a)?.label === '无密码模式' ? '连接' : '输入密码'"
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  @click="cloud.open('unlock', a.id)"
                />
                <UButton v-else label="开通" size="sm" color="neutral" variant="ghost" @click="cloud.open('enable', a.id)" />
              </template>
              <UDropdownMenu :items="startMenu(a)" :content="{ align: 'end' }">
                <UButton icon="i-lucide-ellipsis" size="sm" color="neutral" variant="ghost" aria-label="更多操作" />
              </UDropdownMenu>
            </template>
          </div>
        </div>
        <UProgress v-if="cloud.busy === a.id && cloud.progress !== null" class="mt-3" :model-value="Math.round(cloud.progress * 100)" size="xs" />
      </div>
    </div>
    <p v-else class="text-sm text-muted">添加账号后可以开通云同步；在新设备上，可以直接“从云端恢复账号”。</p>
  </section>
</template>
