<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import HgTokenField from '@/components/cloud/HgTokenField.vue'
import PasswordFields from '@/components/cloud/PasswordFields.vue'
import TokenDisclosure from '@/components/cloud/TokenDisclosure.vue'
import { type Consent, cloudOAuthToken, createConsent, revokeConsent } from '@/lib/cloud/consent'
import { passwordKeys } from '@/lib/cloud/crypto'
import { changePassword, CloudSyncError, deleteCloud, enableCloud, setTwoFactor, unlockCloud } from '@/lib/cloud/engine'
import { SECURITY_URL } from '@/lib/cloud/links'
import { saveProfile } from '@/lib/cloud/profile'
import { keysOf } from '@/lib/cloud/state'
import { makeAccountId } from '@/lib/archive'
import { db } from '@/lib/db'
import { type Game, GAME_LABEL } from '@/lib/types'
import { useAppStore } from '@/stores/app'
import { describeError, useCloudStore } from '@/stores/cloud'

/** 云同步的对话框：开通、覆盖、解锁、恢复、改密码、双重验证、删除、同步配置 */
const app = useAppStore()
const cloud = useCloudStore()
const toast = useToast()

const mode = computed(() => cloud.dialog?.mode ?? null)
const account = computed(() => app.accounts.find((a) => a.id === cloud.dialog?.accountId))
const entry = computed(() => (cloud.dialog?.accountId ? cloud.byAccount.get(cloud.dialog.accountId) : undefined))
const detected = computed(() => (cloud.dialog?.accountId ? cloud.detected.get(cloud.dialog.accountId)?.status : undefined))

const TITLES = {
  enable: '开通云同步',
  overwrite: '忘记密码：用这个浏览器的数据覆盖云端',
  unlock: '输入云同步密码',
  restore: '从云端恢复账号',
  password: '修改云同步密码',
  twofactor: '鹰角 token 双重验证',
  delete: '删除云端数据',
  profile: '同步配置',
} as const

// ── 表单 ──
const password = ref('')
const passwordValid = ref(false)
const oldPassword = ref('')
const remember = ref(true)
const requireHg = ref(false)
const withHg = ref(false)
const saveAsProfile = ref(false)
const tokenText = ref('')
const tokenReady = ref(false)
const restoreGame = ref<Game>('arknights')
const restoreUid = ref('')
const working = ref(false)
/** 需要发送鹰角 token 时，提交前先显示声明，再点一次才发送 */
const confirming = ref(false)
/** 同步配置：密码和已开通账号的不一致，再点一次才保存 */
const mismatch = ref('')
const progress = ref<number | null>(null)
const error = ref('')
const errorCode = ref('')
const errorEl = ref<HTMLElement | null>(null)
// 对话框内容较长时，错误提示可能在可视区域之外：出现时滚动到它
watch(error, async (message) => {
  if (!message) return
  await nextTick()
  errorEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})

watch(
  () => cloud.dialog,
  (d) => {
    if (!d) return
    password.value = ''
    oldPassword.value = ''
    remember.value = entry.value?.state.remember ?? cloud.profile?.remember ?? true
    requireHg.value = d.mode === 'profile' ? (cloud.profile?.requireHg ?? false) : false
    withHg.value = entry.value?.state.requireHg ?? (detected.value?.exists ? detected.value.requireHg : false)
    // 还没有同步配置时默认保存一份，之后其他账号可以一键启用
    saveAsProfile.value = !cloud.profile
    tokenText.value = ''
    restoreGame.value = d.game ?? app.game
    restoreUid.value = ''
    working.value = false
    confirming.value = false
    mismatch.value = ''
    progress.value = null
    error.value = ''
    errorCode.value = ''
  },
)

function close() {
  if (!working.value) cloud.dialog = null
}

/** 需要鹰角 token 的场景 */
const needsToken = computed(() => {
  switch (mode.value) {
    case 'enable':
    case 'overwrite':
    case 'twofactor':
      return true
    case 'unlock':
    case 'restore':
      return withHg.value
    case 'password':
      return Boolean(entry.value?.state.requireHg)
    case 'delete':
      return !entry.value?.hasKeys || Boolean(entry.value?.state.requireHg)
    default:
      return false
  }
})

const tokenReason = computed(() => {
  switch (mode.value) {
    case 'enable':
    case 'overwrite':
      return '开通和覆盖都要先证明这个 UID 是你的，否则知道你 UID 的人可以抢先占用、或者覆盖你的云端数据。它只能证明所有权，解不开你的数据。'
    case 'delete':
      return entry.value?.hasKeys ? '这个账号开启了双重验证。' : '这台设备上没有云同步的钥匙（例如忘记了密码），需要用鹰角 token 证明这个账号是你的。'
    default:
      return '这个账号开启了双重验证：除了密码，还需要有效的鹰角登录。'
  }
})

/** 确认弹窗里列出的步骤 */
const tokenSteps = computed(() => {
  switch (mode.value) {
    case 'enable':
      return ['用鹰角 token 向服务器证明账号是你的', '确认云端还没有开通（已经开通时不会覆盖）', '把记录在浏览器里加密后上传']
    case 'overwrite':
      return ['用鹰角 token 向服务器证明账号是你的', '用这个浏览器的数据替换云端的全部数据']
    case 'twofactor':
      return ['用鹰角 token 向服务器证明账号是你的', entry.value?.state.requireHg ? '关闭双重验证' : '开启双重验证']
    case 'delete':
      return ['用鹰角 token 向服务器证明账号是你的', '删除云端保存的这个账号的全部数据']
    default:
      return ['这个账号开启了双重验证：用鹰角 token 向服务器证明账号是你的', submitLabel.value]
  }
})

const PROFILE_HINT = '之后其他账号开通或启用云同步时点一下就完成。密码会加密后保存在这台设备的浏览器里（加密钥匙不可导出），跟随“记住”的选择：不记住时只保存到关闭网页。公用电脑请不要保存。'
const profileLabel = computed(() => (cloud.profile ? '用这次的密码和设置替换同步配置' : '保存为同步配置（推荐）'))

const profileApplies = computed(() => mode.value === 'enable' || mode.value === 'overwrite' || mode.value === 'unlock' || mode.value === 'restore')

const canSubmit = computed(() => {
  if (working.value) return false
  if (needsToken.value && !tokenReady.value) return false
  switch (mode.value) {
    case 'enable':
    case 'overwrite':
    case 'profile':
      return passwordValid.value
    case 'unlock':
      return password.value.length > 0
    case 'restore':
      return password.value.length > 0 && /^[\w-]{1,32}$/.test(restoreUid.value.trim())
    case 'password':
      return oldPassword.value.length > 0 && passwordValid.value
    case 'twofactor':
      return Boolean(entry.value?.hasKeys)
    case 'delete':
      return true
    default:
      return false
  }
})

const submitLabel = computed(() => {
  switch (mode.value) {
    case 'enable':
      return '开通'
    case 'overwrite':
      return '覆盖云端'
    case 'unlock':
      return '解锁并同步'
    case 'restore':
      return '恢复'
    case 'password':
      return '修改密码'
    case 'twofactor':
      return entry.value?.state.requireHg ? '关闭双重验证' : '开启双重验证'
    case 'delete':
      return '删除云端数据'
    case 'profile':
      return mismatch.value ? '仍然保存' : '保存同步配置'
    default:
      return '确定'
  }
})

const onProgress = (fraction: number) => (progress.value = fraction)
watch(password, () => (mismatch.value = ''))

/** 这次操作涉及的账号（恢复时还没有账号，用游戏和 UID） */
const targetId = computed(() => (mode.value === 'restore' ? makeAccountId(restoreGame.value, restoreUid.value.trim()) : (cloud.dialog?.accountId ?? '')))

/** 同步配置：用一个已开通账号的钥匙在本地核对密码（不联网） */
async function checkAgainstEnabled(candidate: string): Promise<string> {
  const known = cloud.states.find((s) => keysOf(s))
  if (!known) return ''
  const keys = keysOf(known)!
  const derived = await passwordKeys(known.game, known.uid, candidate, { onProgress })
  const same = derived.authKey.length === keys.authKey.length && derived.authKey.every((b, i) => b === keys.authKey[i])
  if (same) return ''
  const name = app.accounts.find((a) => a.id === known.accountId)?.nickName ?? known.uid
  return `这个密码和已开通的「${name}」的云同步密码不一致。同步配置会用这个密码去开通、解锁其他账号，一般应该和已开通的账号一致。确定要保存吗？`
}

async function submit() {
  if (!canSubmit.value || !mode.value) return
  if (needsToken.value && !confirming.value) {
    confirming.value = true
    return
  }
  working.value = true
  error.value = ''
  errorCode.value = ''
  progress.value = null
  // 走到这里说明用户已经在确认步骤里点了“确认发送”
  const consent: Consent | null = needsToken.value ? createConsent([targetId.value], { pasted: tokenText.value || undefined }) : null
  const oauth = async () => (consent ? cloudOAuthToken(consent, targetId.value, account.value) : undefined)
  try {
    const a = account.value
    let profileHg = requireHg.value
    switch (mode.value) {
      case 'enable':
      case 'overwrite': {
        await enableCloud(a!, {
          password: password.value,
          oauthToken: (await oauth())!,
          requireHg: requireHg.value,
          remember: remember.value,
          overwrite: mode.value === 'overwrite',
          onProgress,
        })
        toast.add({
          title: mode.value === 'enable' ? '已开通云同步' : '已覆盖云端',
          description: '在别的设备上，用同一个 UID 和密码就能取回并合并。',
          color: 'success',
          icon: 'i-lucide-cloud-check',
        })
        break
      }
      case 'unlock':
      case 'restore': {
        const game = mode.value === 'unlock' ? (entry.value?.state.game ?? a!.game) : restoreGame.value
        const uid = mode.value === 'unlock' ? (entry.value?.state.uid ?? a!.uid) : restoreUid.value.trim()
        const result = await unlockCloud({ game, uid }, { password: password.value, remember: remember.value, oauthToken: await oauth(), onProgress })
        profileHg = (await db.cloud.get(makeAccountId(game, uid)))?.requireHg ?? withHg.value
        if (mode.value === 'restore') {
          const restored = await db.accounts.get(makeAccountId(game, uid))
          if (restored) app.selectAccount(restored)
        }
        toast.add({
          title: '云同步完成',
          description: `从云端新增 ${result.downloaded} 条，上传 ${result.uploaded} 条`,
          color: 'success',
          icon: 'i-lucide-cloud-check',
        })
        break
      }
      case 'password':
        await changePassword(a!.id, { oldPassword: oldPassword.value, newPassword: password.value, oauthToken: await oauth(), onProgress })
        toast.add({ title: '云同步密码已修改', description: '其他设备下次云同步时需要输入新密码。', color: 'success', icon: 'i-lucide-key-round' })
        break
      case 'twofactor': {
        const enable = !entry.value!.state.requireHg
        await setTwoFactor(a!.id, enable, (await oauth())!)
        toast.add({ title: enable ? '已开启双重验证' : '已关闭双重验证', color: 'success', icon: 'i-lucide-shield-check' })
        break
      }
      case 'delete':
        await deleteCloud({ game: entry.value?.state.game ?? a!.game, uid: entry.value?.state.uid ?? a!.uid }, { oauthToken: await oauth() })
        toast.add({ title: '已删除云端数据', description: '本地数据不受影响。', color: 'success', icon: 'i-lucide-trash-2' })
        break
      case 'profile': {
        if (!mismatch.value) {
          mismatch.value = await checkAgainstEnabled(password.value)
          if (mismatch.value) {
            working.value = false
            return
          }
        }
        await saveProfile({ password: password.value, requireHg: requireHg.value, remember: remember.value })
        await cloud.refreshProfile()
        toast.add({ title: '已保存同步配置', description: '其他账号现在可以一键开通或启用云同步。', color: 'success', icon: 'i-lucide-settings-2' })
        break
      }
    }
    if (profileApplies.value && saveAsProfile.value) {
      await saveProfile({ password: password.value, requireHg: profileHg, remember: remember.value })
      await cloud.refreshProfile()
    }
    cloud.touchKeys()
    working.value = false
    cloud.dialog = null
  } catch (e) {
    error.value = describeError(e)
    errorCode.value = e instanceof CloudSyncError ? e.code : ''
    confirming.value = false
  } finally {
    revokeConsent(consent)
    working.value = false
    progress.value = null
  }
}
</script>

<template>
  <UModal
    :open="Boolean(mode)"
    :title="mode ? TITLES[mode] : ''"
    :description="
      account
        ? `${GAME_LABEL[account.game]} · ${account.nickName} · UID ${account.uid}`
        : mode === 'profile'
          ? '之后其他账号一键开通、一键启用'
          : '用 UID 和云同步密码，把云端的记录取回到这个浏览器'
    "
    :dismissible="!working"
    :ui="{ content: 'sm:max-w-xl' }"
    @update:open="(open: boolean) => !open && close()"
  >
    <template #body>
      <div class="space-y-4 text-sm">
        <UAlert v-if="cloud.dialog?.note && !confirming" color="warning" variant="subtle" icon="i-lucide-info" :description="cloud.dialog.note" />

        <!-- 发送鹰角 token 前的确认 -->
        <TokenDisclosure v-if="confirming" :steps="tokenSteps" />

        <!-- 开通 / 覆盖 -->
        <template v-else-if="mode === 'enable' || mode === 'overwrite'">
          <p v-if="mode === 'enable'" class="leading-relaxed text-muted">
            记录在你的浏览器里用密码派生的钥匙加密后才上传，服务器只保存密文，解不开。在别的浏览器、别的设备上输入同一个 UID 和密码，就能取回并合并。
          </p>
          <UAlert
            v-else
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="会用这个浏览器里的数据替换云端的全部数据"
            description="请在数据最全的浏览器上操作。云端原来的数据用旧密码加密，已经无法解开。其他设备需要用新密码重新解锁，之后它们多出来的记录会自动补传回来。"
          />
          <PasswordFields v-model="password" v-model:valid="passwordValid" :uid="account?.uid" :nick-name="account?.nickName" />
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-lock-keyhole"
            title="密码无法找回"
            description="服务器不保存密码，也解不开数据。忘记密码只能用数据最全的浏览器覆盖云端；本地数据不受影响。"
          />
          <USwitch v-model="remember" label="在这台设备上记住（推荐）" description="不记住的话，每次打开网页后云同步都要重新输入密码。公用电脑请关闭。" />
          <USwitch
            v-model="requireHg"
            label="鹰角 token 双重验证（可选）"
            description="开启后每次云同步还需要有效的鹰角登录（每次都会请你确认）：只知道 UID 和密码也取不回数据，别人也没法故意输错密码让你的账号暂时被锁。"
          />
          <USwitch v-model="saveAsProfile" :label="profileLabel" :description="PROFILE_HINT" />
        </template>

        <!-- 解锁 / 恢复 -->
        <template v-else-if="mode === 'unlock' || mode === 'restore'">
          <p class="leading-relaxed text-muted">
            {{
              mode === 'unlock'
                ? '这台设备上没有这个账号的云同步钥匙（新设备、清除过浏览器数据、选择了不记住，或者密码在别处改过、云端被覆盖）。'
                : '在新设备上，不需要先添加账号：输入 UID 和云同步密码即可取回。'
            }}
          </p>
          <div v-if="mode === 'restore'" class="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <UFormField label="游戏">
              <USelect
                v-model="restoreGame"
                :items="[
                  { label: GAME_LABEL.arknights, value: 'arknights' },
                  { label: GAME_LABEL.endfield, value: 'endfield' },
                ]"
                class="w-full"
              />
            </UFormField>
            <UFormField label="UID" required>
              <UInput v-model="restoreUid" inputmode="numeric" placeholder="游戏里的 UID" class="w-full font-mono" />
            </UFormField>
          </div>
          <UFormField label="云同步密码" required>
            <UInput v-model="password" type="password" autocomplete="current-password" class="w-full font-mono" @keydown.enter="submit" />
          </UFormField>
          <USwitch v-model="remember" label="在这台设备上记住（推荐）" />
          <USwitch
            v-model="withHg"
            label="这个账号开启了双重验证"
            :description="detected?.exists ? `检测结果：${detected.requireHg ? '已开启' : '没有开启'}` : undefined"
          />
          <USwitch v-model="saveAsProfile" :label="profileLabel" :description="PROFILE_HINT" />
          <p v-if="mode === 'unlock' && account" class="text-xs text-muted">
            忘记密码？
            <UButton label="用这个浏览器的数据覆盖云端" size="xs" variant="link" class="p-0" @click="cloud.open('overwrite', account.id)" />
          </p>
        </template>

        <!-- 改密码 -->
        <template v-else-if="mode === 'password'">
          <UFormField label="当前密码" required>
            <UInput v-model="oldPassword" type="password" autocomplete="current-password" class="w-full font-mono" />
          </UFormField>
          <PasswordFields v-model="password" v-model:valid="passwordValid" label="新密码" :uid="account?.uid" :nick-name="account?.nickName" />
          <p class="text-xs leading-relaxed text-muted">只更换包裹钥匙的密码，不用重新上传数据。其他设备下次云同步时需要输入新密码。</p>
        </template>

        <!-- 双重验证 -->
        <template v-else-if="mode === 'twofactor'">
          <p class="leading-relaxed text-muted">
            开启后，这个账号的每次云同步都要同时提供密码和有效的鹰角登录：只知道 UID 和密码也取不回数据，别人也没法故意输错密码让你的账号暂时被锁。
            代价是鹰角接口出问题时暂时不能云同步。开启和关闭都需要两样证明。
          </p>
          <UBadge :label="entry?.state.requireHg ? '目前：已开启' : '目前：未开启'" :color="entry?.state.requireHg ? 'success' : 'neutral'" variant="subtle" />
          <p v-if="!entry?.hasKeys" class="text-xs text-warning">请先输入云同步密码解锁。</p>
        </template>

        <!-- 删除 -->
        <template v-else-if="mode === 'delete'">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-trash-2"
            title="删除云端保存的这个账号的全部数据"
            description="本地数据不受影响。删除后其他设备无法再云同步这个账号，除非重新开通。"
          />
        </template>

        <!-- 同步配置 -->
        <template v-else-if="mode === 'profile'">
          <p class="leading-relaxed text-muted">
            保存一份云同步设置。之后其他账号（例如同一个鹰角账号下的另一个游戏、另一个服务器的角色）开通或启用云同步时，点一下就完成，不用再输入密码和选项。
          </p>
          <UAlert v-if="cloud.profile" color="neutral" variant="subtle" icon="i-lucide-info" description="保存后会替换现有的同步配置。" />
          <PasswordFields v-model="password" v-model:valid="passwordValid" label="云同步密码" />
          <p class="text-xs leading-relaxed text-muted">一般和已开通账号的密码相同。保存前会用一个已开通账号的钥匙在本地核对一次（不联网）。</p>
          <USwitch v-model="requireHg" label="新开通的账号开启鹰角 token 双重验证" />
          <USwitch v-model="remember" label="在这台设备上记住（推荐）" :description="PROFILE_HINT" />
          <UAlert v-if="mismatch" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="mismatch" />
        </template>

        <HgTokenField v-if="needsToken && !confirming" v-model="tokenText" v-model:ready="tokenReady" :account="account" :reason="tokenReason" />

        <div v-if="working" class="space-y-1">
          <p class="text-xs text-muted">正在处理：由密码计算钥匙可能需要几秒，较旧的设备会更久。</p>
          <UProgress :model-value="progress === null ? null : Math.round(progress * 100)" size="sm" />
        </div>
        <div v-if="error" ref="errorEl" class="space-y-2">
          <UAlert color="error" variant="subtle" icon="i-lucide-circle-x" :description="error" />
          <UButton
            v-if="errorCode === 'already_enabled' && account"
            label="改为输入密码"
            icon="i-lucide-key-round"
            size="sm"
            variant="soft"
            @click="cloud.open('unlock', account.id)"
          />
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-between gap-2">
        <ULink :to="SECURITY_URL" target="_blank" class="text-xs text-muted">安全说明</ULink>
        <div class="flex gap-2">
          <UButton v-if="confirming" label="返回" color="neutral" variant="ghost" :disabled="working" @click="confirming = false" />
          <UButton v-else label="取消" color="neutral" variant="ghost" :disabled="working" @click="close" />
          <UButton
            :label="confirming ? `确认发送并${submitLabel}` : submitLabel"
            :icon="confirming ? 'i-lucide-send' : undefined"
            :color="mode === 'delete' || mode === 'overwrite' ? 'error' : 'primary'"
            :loading="working"
            :disabled="!canSubmit"
            @click="submit"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
