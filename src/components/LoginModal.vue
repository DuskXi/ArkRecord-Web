<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { makeAccountId } from '@/lib/archive'
import { db } from '@/lib/db'
import { type Binding, grantOAuthToken, listBindings, parseAccountToken } from '@/lib/hg/auth'
import { HgError } from '@/lib/hg/client'
import { desktopBridge, isRpcErrorObject } from '@/lib/transport'
import { GAME_LABEL } from '@/lib/types'
import { useAppStore } from '@/stores/app'
import { useSyncStore } from '@/stores/sync'

const app = useAppStore()
const sync = useSyncStore()
/** 桌面版：可以在应用内的窗口里登录（desktop/electron/hg-login.ts） */
const desktop = desktopBridge()

const step = ref<'token' | 'roles'>('token')
const raw = ref('')
/** 应用内登录拿到的 token：只在这个组件里，不显示在界面上 */
const loginToken = ref('')
const loggingIn = ref(false)
const verifying = ref(false)
const error = ref('')
const bindings = ref<Binding[]>([])
const selected = ref<string[]>([])
const remember = ref(true)
const adding = ref(false)

const token = computed(() => loginToken.value || parseAccountToken(raw.value))
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
      loginToken.value = ''
      error.value = ''
      bindings.value = []
    }
  },
)

// 改为粘贴 token 时，不再用应用内登录拿到的那个
watch(raw, () => {
  loginToken.value = ''
})

/** 桌面版：打开应用内的鹰角登录窗口，拿到 token 后直接验证 */
async function loginInApp() {
  if (!desktop) return
  loggingIn.value = true
  error.value = ''
  try {
    const result = (await desktop.rpc('app.hgLogin')) as { token?: unknown } | null
    if (typeof result?.token !== 'string' || !result.token) throw new Error('没有拿到登录状态，请重试')
    loginToken.value = result.token
  } catch (e) {
    // 用户自己关掉了登录窗口，不用提示
    if (isRpcErrorObject(e) && e.data?.kind === 'cancelled') return
    error.value = isRpcErrorObject(e) || e instanceof Error ? e.message : String(e)
    return
  } finally {
    loggingIn.value = false
  }
  await verify()
}

/** 登录窗口没有自动继续时，用户点“我已登录”让应用马上查一次 */
function checkInAppLogin() {
  void desktop?.rpc('app.hgLoginCheck').catch(() => undefined)
}

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
        ? loginToken.value
          ? '登录状态无效或已过期，请重新登录。'
          : 'token 无效或已过期，请重新登录鹰角通行证后再复制一次。'
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
        metaAt: Date.now(),
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
        <div v-if="desktop" class="space-y-3">
          <UButton
            block
            size="lg"
            icon="i-lucide-log-in"
            label="在应用内登录鹰角网络通行证"
            :loading="loggingIn || verifying"
            @click="loginInApp"
          />
          <p v-if="loggingIn" class="text-sm text-muted">
            请在弹出的窗口里登录，登录后会自动继续。没有反应的话，点
            <UButton label="我已登录" size="xs" variant="link" class="p-0 align-baseline" @click="checkInAppLogin" />
          </p>
          <p class="text-xs text-muted">
            在应用内的窗口里输入密码，理论上应用能读到。ArkRecord 不向登录页注入脚本，代码开源；不想在应用里输入密码，可以按下面的步骤粘贴 token。
          </p>
          <p class="pt-2 text-xs font-medium text-muted">或者粘贴 token：</p>
        </div>

        <ol class="space-y-3 text-sm">
          <li class="flex gap-3">
            <span class="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 font-display text-xs text-primary">1</span>
            <span>
              {{ desktop ? '在浏览器中登录' : '在本浏览器中登录' }}
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
          :description="
            desktop
              ? 'token 只在本机和鹰角服务器之间使用，不经过任何其他服务器。请勿把 token 发给他人。'
              : 'token 只在你的浏览器和鹰角服务器之间使用。本站的转发服务只为绕过浏览器的跨域限制，不记录、不保存任何内容。请勿把 token 发给他人。'
          "
        />
      </div>

      <div v-else class="space-y-4">
        <UCheckboxGroup
          v-model="selected"
          :items="roleItems"
          variant="card"
          :ui="{ fieldset: 'gap-2' }"
        />
        <USwitch
          v-model="remember"
          label="记住登录"
          :description="desktop ? 'token 保存在本机的应用数据里，下次可以直接同步。公用电脑请关闭。' : 'token 保存在此浏览器中，下次可以直接同步。公用电脑请关闭。'"
        />
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
