<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { makeAccountId } from '@/lib/archive'
import { db } from '@/lib/db'
import { type Binding, grantOAuthToken, listBindings, parseAccountToken } from '@/lib/hg/auth'
import { HgError } from '@/lib/hg/client'
import { GAME_LABEL } from '@/lib/types'
import { useAppStore } from '@/stores/app'
import { useSyncStore } from '@/stores/sync'

const app = useAppStore()
const sync = useSyncStore()

const step = ref<'token' | 'roles'>('token')
const raw = ref('')
const verifying = ref(false)
const error = ref('')
const bindings = ref<Binding[]>([])
const selected = ref<string[]>([])
const remember = ref(true)
const adding = ref(false)

const token = computed(() => parseAccountToken(raw.value))
const roleItems = computed(() =>
  bindings.value.map((b) => ({
    value: bindingKey(b),
    label: b.nickName,
    description: `${GAME_LABEL[b.game]} · UID ${b.uid}${b.channelName ? ` · ${b.channelName}` : ''}`,
  })),
)

watch(
  () => app.loginOpen,
  (open) => {
    if (open) {
      step.value = 'token'
      raw.value = ''
      error.value = ''
      bindings.value = []
    }
  },
)

async function verify() {
  if (!token.value) return
  verifying.value = true
  error.value = ''
  try {
    const oauth = await grantOAuthToken(token.value)
    const found: Binding[] = []
    for (const game of ['arknights', 'endfield'] as const) {
      try {
        found.push(...(await listBindings(oauth, game)))
      } catch {
        // 某个游戏没有绑定时忽略
      }
    }
    if (!found.length) {
      error.value = '这个通行证下没有找到明日方舟或终末地的角色。B 服角色需要先在鹰角通行证中绑定。'
      return
    }
    bindings.value = found
    selected.value = found.map(bindingKey)
    step.value = 'roles'
  } catch (e) {
    error.value =
      e instanceof HgError && (e.kind === 'auth' || e.kind === 'upstream')
        ? 'token 无效或已过期，请重新登录鹰角通行证后再复制一次。'
        : e instanceof Error
          ? e.message
          : String(e)
  } finally {
    verifying.value = false
  }
}

function bindingKey(b: Binding) {
  return makeAccountId(b.game, b.uid)
}

async function confirm() {
  if (!token.value) return
  adding.value = true
  try {
    const chosen = bindings.value.filter((b) => selected.value.includes(bindingKey(b)))
    for (const b of chosen) {
      const id = bindingKey(b)
      const existing = await db.accounts.get(id)
      await db.accounts.put({
        id,
        game: b.game,
        uid: b.uid,
        nickName: b.nickName,
        channelName: b.channelName,
        isOfficial: b.isOfficial,
        createdAt: existing?.createdAt ?? Date.now(),
        lastSyncAt: existing?.lastSyncAt,
        accountToken: remember.value ? token.value : undefined,
      })
    }
    const first = chosen.find((b) => b.game === app.game) ?? chosen[0]
    app.loginOpen = false
    if (first) {
      const account = await db.accounts.get(bindingKey(first))
      if (account) app.selectAccount(account)
    }
    for (const b of chosen) {
      const account = await db.accounts.get(bindingKey(b))
      if (account) await sync.sync(account, { token: token.value })
    }
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="app.loginOpen"
    :title="step === 'token' ? '添加账号' : '选择要添加的角色'"
    :description="step === 'token' ? '使用鹰角网络通行证登录，同时支持明日方舟与终末地。' : '可以同时添加多个角色。'"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <div v-if="step === 'token'" class="space-y-5">
        <ol class="space-y-3 text-sm">
          <li class="flex gap-3">
            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 font-display text-xs text-primary">1</span>
            <span>
              在本浏览器中登录
              <ULink to="https://user.hypergryph.com/" target="_blank" class="font-medium text-primary">鹰角网络通行证</ULink>
              （B 服玩家需先在通行证中绑定游戏角色）。
            </span>
          </li>
          <li class="flex gap-3">
            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 font-display text-xs text-primary">2</span>
            <span>
              打开
              <ULink to="https://web-api.hypergryph.com/account/info/hg" target="_blank" class="font-medium break-all text-primary">
                web-api.hypergryph.com/account/info/hg
              </ULink>
              ，复制页面上的全部内容。
            </span>
          </li>
          <li class="flex gap-3">
            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 font-display text-xs text-primary">3</span>
            <span>粘贴到下面的输入框。</span>
          </li>
        </ol>

        <UTextarea
          v-model="raw"
          :rows="3"
          autoresize
          placeholder='{"code":0,"data":{"content":"……"},"msg":""}'
          class="w-full font-mono"
          :color="raw && !token ? 'error' : 'primary'"
        />
        <p v-if="raw && !token" class="text-xs text-error">没有识别出 token，请复制页面上的全部内容。</p>

        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="error" />

        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-shield-check"
          description="token 只在你的浏览器和鹰角服务器之间使用。本站的转发服务只为绕过浏览器的跨域限制，不记录、不保存任何内容。请勿把 token 发给他人。"
        />
      </div>

      <div v-else class="space-y-4">
        <UCheckboxGroup
          v-model="selected"
          :items="roleItems"
          variant="card"
          :ui="{ fieldset: 'gap-2' }"
        />
        <USwitch v-model="remember" label="记住登录" description="token 保存在此浏览器中，下次可以直接同步。公用电脑请关闭。" />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton v-if="step === 'roles'" label="上一步" color="neutral" variant="ghost" @click="step = 'token'" />
        <UButton v-if="step === 'token'" label="验证" :disabled="!token" :loading="verifying" icon="i-lucide-arrow-right" trailing @click="verify" />
        <UButton
          v-else
          label="添加并同步"
          icon="i-lucide-refresh-cw"
          :disabled="!selected.length"
          :loading="adding"
          @click="confirm"
        />
      </div>
    </template>
  </UModal>
</template>
