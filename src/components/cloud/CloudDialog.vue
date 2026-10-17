<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import HgModeNotice from '@/components/cloud/HgModeNotice.vue'
import HgTokenField from '@/components/cloud/HgTokenField.vue'
import PasswordFields from '@/components/cloud/PasswordFields.vue'
import TokenDisclosure from '@/components/cloud/TokenDisclosure.vue'
import { type Consent, cloudOAuthToken, createConsent, revokeConsent } from '@/lib/cloud/consent'
import { passwordKeys } from '@/lib/cloud/crypto'
import { changePassword, CloudSyncError, deleteCloud, enableCloud, setTwoFactor, switchCloudMode, unlockCloud, unlockHgCloud } from '@/lib/cloud/engine'
import { SECURITY_URL } from '@/lib/cloud/links'
import { saveProfile } from '@/lib/cloud/profile'
import { keysOf } from '@/lib/cloud/state'
import { makeAccountId } from '@/lib/archive'
import { db } from '@/lib/db'
import { type Game, GAME_LABEL } from '@/lib/types'
import type { CloudMode } from '../../../shared/cloud-protocol'
import { useAppStore } from '@/stores/app'
import { describeError, MODE_LABEL, switchWarning, useCloudStore } from '@/stores/cloud'

/** 云同步的对话框：开通、覆盖、解锁、恢复、改密码、双重验证、删除、同步配置、切换模式 */
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
  switch: '切换云同步模式',
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
/** 开通、覆盖、同步配置、切换：用哪种模式（切换时是切换到的模式） */
const cloudMode = ref<CloudMode>('password')
/** 解锁、恢复：这个账号用的是无密码模式（不需要密码） */
const hgMode = ref(false)
/** 已阅读并确认无密码模式的保护范围 */
const hgAck = ref(false)
/** 切换模式、这台设备上没有钥匙时：现在的云同步密码（用来先合并云端数据） */
const currentPassword = ref('')
/** 切换模式时不知道现在的密码：不合并，直接覆盖 */
const overwriteWithoutMerge = ref(false)
/** 同步配置：保存后把模式不一样的已开通账号也切换过去 */
const applyToEnabled = ref(true)
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
    const knownMode = entry.value?.state.mode ?? (detected.value?.exists ? detected.value.mode : undefined)
    cloudMode.value =
      d.mode === 'switch'
        ? (d.to ?? (knownMode === 'hg' ? 'password' : 'hg'))
        : d.mode === 'overwrite'
          ? (knownMode ?? 'password')
          : (cloud.profile?.mode ?? 'password')
    hgMode.value = (d.mode === 'unlock' || d.mode === 'restore') && (d.hg ?? (d.mode === 'unlock' && knownMode === 'hg'))
    hgAck.value = false
    currentPassword.value = ''
    overwriteWithoutMerge.value = false
    applyToEnabled.value = true
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

/** 这次操作用的是无密码模式 */
const usesHg = computed(() => {
  switch (mode.value) {
    case 'enable':
    case 'overwrite':
    case 'profile':
    case 'switch':
      return cloudMode.value === 'hg'
    case 'unlock':
    case 'restore':
      return hgMode.value
    default:
      return false
  }
})
/** 选了无密码模式，但服务器没有配置 */
const hgBlocked = computed(() => usesHg.value && cloud.hgAvailable === false)
/** 云端现在的模式（这台设备上的状态，或者检测结果） */
const knownMode = computed(() => entry.value?.state.mode ?? (detected.value?.exists ? detected.value.mode : undefined))
/** 切换前要先合并云端数据：云端是密码模式、这台设备上又没有它的钥匙时，需要输入现在的密码（或者选择直接覆盖） */
const switchNeedsPassword = computed(
  () => mode.value === 'switch' && knownMode.value !== 'hg' && !(entry.value && entry.value.state.mode === knownMode.value && entry.value.hasKeys),
)
/** 同步配置的模式和这个账号在云端的模式不一样 */
const profileDiffers = computed(() => Boolean(cloud.profile && knownMode.value && cloud.profile.mode !== knownMode.value))
/** 同步配置：这台设备上已开通、模式和新配置不一样的账号 */
const profileMismatched = computed(() =>
  mode.value === 'profile' ? app.accounts.filter((a) => {
    const e = cloud.byAccount.get(a.id)
    return e && e.state.mode !== cloudMode.value
  }) : [],
)
/** 覆盖、切换都会替换云端的全部数据：醒目地写出来 */
const overwriteWarning = computed(() => {
  if (mode.value === 'switch') return switchWarning(cloudMode.value, !(switchNeedsPassword.value && overwriteWithoutMerge.value))
  if (mode.value === 'overwrite') {
    return {
      title: '会用这个浏览器里的数据替换云端的全部数据',
      description: '云端会换一把新钥匙，原来的数据无法再解开；云端有、这个浏览器里没有的记录会丢失。其他设备需要重新启用，它们还没上传的记录在重新启用后会补传。',
    }
  }
  return null
})

/** 需要鹰角 token 的场景 */
const needsToken = computed(() => {
  switch (mode.value) {
    case 'enable':
    case 'overwrite':
    case 'twofactor':
    case 'switch':
      return true
    case 'unlock':
    case 'restore':
      return withHg.value || hgMode.value
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
      return usesHg.value
        ? '无密码模式靠鹰角 token 证明这个账号是你的：开通时要发送，之后每次云同步也都要发送（每次都会请你确认）。'
        : '开通和覆盖都要先证明这个 UID 是你的，否则知道你 UID 的人可以抢先占用、或者覆盖你的云端数据。它只能证明所有权，解不开你的数据。'
    case 'switch':
      return '切换模式会覆盖云端，需要先证明这个账号是你的。'
    case 'unlock':
    case 'restore':
      return hgMode.value ? '无密码模式靠鹰角 token 证明这个账号是你的，服务器核实后给出解开数据的钥匙。' : '这个账号开启了双重验证：除了密码，还需要有效的鹰角登录。'
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
      return usesHg.value
        ? ['用鹰角 token 向服务器证明账号是你的', '服务器给出这个账号无密码模式的钥匙', '确认云端还没有开通（已经开通时不会覆盖）', '把记录在浏览器里加密后上传（服务器技术上能解密）']
        : ['用鹰角 token 向服务器证明账号是你的', '确认云端还没有开通（已经开通时不会覆盖）', '把记录在浏览器里加密后上传']
    case 'overwrite':
      return ['用鹰角 token 向服务器证明账号是你的', `用这个浏览器的数据替换云端的全部数据${usesHg.value ? '（无密码模式）' : ''}`]
    case 'switch':
      return [
        '用鹰角 token 向服务器证明账号是你的',
        !switchNeedsPassword.value
          ? knownMode.value === 'hg'
            ? '服务器核实后给出现在的钥匙：下载云端的记录，合并到这个浏览器'
            : '先云同步一次，把云端的记录合并到这个浏览器'
          : overwriteWithoutMerge.value
            ? '不合并云端的记录（你选择了直接覆盖）'
            : '用现在的云同步密码解锁云端，把云端的记录合并到这个浏览器',
        cloudMode.value === 'hg' ? '用无密码模式的新钥匙覆盖云端（其他设备需要重新连接）' : '用新密码、新钥匙覆盖云端（其他设备需要输入新密码）',
      ]
    case 'unlock':
    case 'restore':
      return hgMode.value
        ? ['这个账号用的是无密码模式：用鹰角 token 向服务器证明账号是你的，服务器核实后给出解开数据的钥匙', '下载并合并，上传本地多出来的记录']
        : ['这个账号开启了双重验证：用鹰角 token 向服务器证明账号是你的', submitLabel.value]
    case 'twofactor':
      return ['用鹰角 token 向服务器证明账号是你的', entry.value?.state.requireHg ? '关闭双重验证' : '开启双重验证']
    case 'delete':
      return ['用鹰角 token 向服务器证明账号是你的', '删除云端保存的这个账号的全部数据']
    default:
      return ['这个账号开启了双重验证：用鹰角 token 向服务器证明账号是你的', submitLabel.value]
  }
})

const PROFILE_HINT_HG = '记下“新开通的账号用无密码模式”，之后这台设备上的其他账号点一下就开通或连接。只存在这台设备上，不包含任何密码和鹰角登录。'
const PROFILE_HINT =
  '只记下云同步密码和选项，之后这台设备上的其他账号开通或启用云同步时点一下就完成。只存在这台设备上（加密保存），不上传，也不会同步到别的设备；不包含鹰角登录（token）。不记住时只保存到关闭网页；公用电脑请不要保存。'
const profileLabel = computed(() => (cloud.profile ? '用这次的密码和设置替换这台设备上的同步配置' : '在这台设备上保存同步配置（推荐）'))

const profileApplies = computed(
  () => mode.value === 'enable' || mode.value === 'overwrite' || mode.value === 'unlock' || mode.value === 'restore' || mode.value === 'switch',
)

const canSubmit = computed(() => {
  if (working.value) return false
  if (needsToken.value && !tokenReady.value) return false
  if (hgBlocked.value) return false
  switch (mode.value) {
    case 'enable':
    case 'overwrite':
      return usesHg.value ? hgAck.value : passwordValid.value
    case 'profile':
      return usesHg.value ? hgAck.value : quickProfile.value ? password.value.length > 0 : passwordValid.value
    case 'unlock':
      return hgMode.value || password.value.length > 0
    case 'restore':
      return (hgMode.value || password.value.length > 0) && /^[\w-]{1,32}$/.test(restoreUid.value.trim())
    case 'switch':
      return (usesHg.value ? hgAck.value : passwordValid.value) && (!switchNeedsPassword.value || currentPassword.value.length > 0 || overwriteWithoutMerge.value)
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
      return hgMode.value ? '连接并同步' : '解锁并同步'
    case 'switch':
      return cloudMode.value === 'hg' ? '切换为无密码模式' : '切换为密码模式'
    case 'restore':
      return '恢复'
    case 'password':
      return '修改密码'
    case 'twofactor':
      return entry.value?.state.requireHg ? '关闭双重验证' : '开启双重验证'
    case 'delete':
      return '删除云端数据'
    case 'profile':
      return quickProfile.value ? '核对并启用' : mismatch.value ? '仍然保存' : cloud.dialog?.continueWith ? '保存并启用' : '保存同步配置'
    default:
      return '确定'
  }
})

const modeItems = computed(() => [
  { label: '密码模式（推荐）', description: '数据只有你的云同步密码能解开，服务器解不开。密码要自己记住，无法找回。', value: 'password' },
  {
    label: '无密码模式（不推荐）',
    description:
      cloud.hgAvailable === false
        ? '服务器还没有配置无密码模式。'
        : '不用记密码：每次云同步都用鹰角 token 验证。本站运营者和拿到你有效鹰角 token 的人技术上能读取你的云端记录。',
    value: 'hg',
    disabled: cloud.hgAvailable === false,
  },
])

const onProgress = (fraction: number) => (progress.value = fraction)
watch(password, () => (mismatch.value = ''))

/** 这次操作涉及的账号（恢复时还没有账号，用游戏和 UID） */
const targetId = computed(() => (mode.value === 'restore' ? makeAccountId(restoreGame.value, restoreUid.value.trim()) : (cloud.dialog?.accountId ?? '')))

/** 这台设备上已经用密码模式开通、而且记着钥匙的账号（用来在本地核对密码） */
const knownState = computed(() => [...cloud.byAccount.values()].find((e) => e.state.mode === 'password' && keysOf(e.state))?.state)
const knownName = computed(() => app.accounts.find((a) => a.id === knownState.value?.accountId)?.nickName ?? knownState.value?.uid ?? '')
/**
 * 一键启用时这个浏览器还没有同步配置，但已经有开通了的账号：只需要输入一次它的云同步密码，
 * 在本地核对后保存为同步配置，不用重新设置（输两遍、密码规则）
 */
const quickProfile = computed(() => mode.value === 'profile' && Boolean(cloud.dialog?.continueWith) && Boolean(knownState.value))

const dialogTitle = computed(() => {
  if (quickProfile.value) return '输入云同步密码'
  if (mode.value === 'unlock' && hgMode.value) return '连接云同步（无密码模式）'
  return mode.value ? TITLES[mode.value] : ''
})

/** 同步配置：用一个已开通账号的钥匙在本地核对密码（不联网） */
async function checkAgainstEnabled(candidate: string): Promise<string> {
  const known = cloud.states.find((s) => s.mode === 'password' && keysOf(s))
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
          mode: cloudMode.value,
          password: password.value,
          oauthToken: (await oauth())!,
          requireHg: requireHg.value,
          remember: remember.value,
          overwrite: mode.value === 'overwrite',
          onProgress,
        })
        profileHg = usesHg.value || requireHg.value
        toast.add({
          title: mode.value === 'enable' ? '已开通云同步' : '已覆盖云端',
          description: usesHg.value
            ? '无密码模式：在别的设备上，用同一个账号的鹰角登录就能连接并合并。'
            : '在别的设备上，用同一个 UID 和密码就能取回并合并。',
          color: 'success',
          icon: 'i-lucide-cloud-check',
        })
        break
      }
      case 'switch': {
        const result = await switchCloudMode(a!, {
          to: cloudMode.value,
          password: password.value,
          currentPassword: switchNeedsPassword.value ? currentPassword.value || undefined : undefined,
          overwriteWithoutMerge: switchNeedsPassword.value && !currentPassword.value && overwriteWithoutMerge.value,
          oauthToken: (await oauth())!,
          requireHg: requireHg.value,
          remember: remember.value,
          onProgress,
        })
        profileHg = usesHg.value || requireHg.value
        toast.add({
          title: `已切换为${MODE_LABEL[cloudMode.value]}`,
          description: `${result.merged ? '已先合并云端的记录，再覆盖云端。' : result.created ? '云端原来没有开通，已直接开通。' : '没有合并云端的记录，直接覆盖了云端。'}其他设备需要重新启用（${usesHg.value ? '用鹰角登录连接' : '输入新的云同步密码'}）。`,
          color: 'success',
          icon: 'i-lucide-cloud-check',
          duration: 10_000,
        })
        break
      }
      case 'unlock':
      case 'restore': {
        const game = mode.value === 'unlock' ? (entry.value?.state.game ?? a!.game) : restoreGame.value
        const uid = mode.value === 'unlock' ? (entry.value?.state.uid ?? a!.uid) : restoreUid.value.trim()
        const result = hgMode.value
          ? await unlockHgCloud({ game, uid }, { oauthToken: (await oauth())! })
          : await unlockCloud({ game, uid }, { password: password.value, remember: remember.value, oauthToken: await oauth(), onProgress })
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
        if (usesHg.value) {
          await saveProfile({ mode: 'hg', password: '', requireHg: true, remember: remember.value })
        } else if (quickProfile.value) {
          // 只输入一次：必须和已开通账号的密码一致（一键启用就是用同一个密码）
          if (await checkAgainstEnabled(password.value)) {
            error.value = `密码和「${knownName.value}」的云同步密码不一致。一键启用要用同一个密码；如果这个账号想用别的密码，请在“…”菜单里选择手动开通。`
            working.value = false
            return
          }
        } else if (!mismatch.value) {
          mismatch.value = await checkAgainstEnabled(password.value)
          if (mismatch.value) {
            working.value = false
            return
          }
        }
        if (!usesHg.value) await saveProfile({ mode: 'password', password: password.value, requireHg: requireHg.value, remember: remember.value })
        await cloud.refreshProfile()
        const toSwitch = applyToEnabled.value ? profileMismatched.value : []
        const next = app.accounts.find((x) => x.id === cloud.dialog?.continueWith)
        if (next) {
          // 接着一键启用（需要发送鹰角 token 时会先弹出确认）
          cloud.touchKeys()
          working.value = false
          cloud.dialog = null
          void cloud.quickStart(next)
          return
        }
        if (toSwitch.length) {
          // 把模式不一样的已开通账号切换过去（会再弹出确认，醒目地写出会覆盖云端）
          cloud.touchKeys()
          working.value = false
          cloud.dialog = null
          void cloud.switchAccounts(toSwitch)
          return
        }
        toast.add({ title: '已保存同步配置', description: '其他账号现在可以一键开通或启用云同步。', color: 'success', icon: 'i-lucide-settings-2' })
        break
      }
    }
    if (profileApplies.value && saveAsProfile.value) {
      await saveProfile(
        usesHg.value
          ? { mode: 'hg', password: '', requireHg: true, remember: true }
          : { mode: 'password', password: password.value, requireHg: profileHg, remember: remember.value },
      )
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
    :title="dialogTitle"
    :description="
      account
        ? `${GAME_LABEL[account.game]} · ${account.nickName} · UID ${account.uid}`
        : quickProfile
          ? '这个浏览器第一次使用一键启用'
          : mode === 'profile'
          ? '只保存在这台设备上，之后其他账号一键开通、一键启用'
          : '用 UID 和云同步密码，把云端的记录取回到这个浏览器'
    "
    :dismissible="!working"
    :ui="{ content: 'sm:max-w-xl' }"
    @update:open="(open: boolean) => !open && close()"
  >
    <template #body>
      <div class="space-y-4 text-sm">
        <UAlert v-if="cloud.dialog?.note && !confirming && !quickProfile" color="warning" variant="subtle" icon="i-lucide-info" :description="cloud.dialog.note" />

        <!-- 发送鹰角 token 前的确认 -->
        <template v-if="confirming">
          <UAlert
            v-if="overwriteWarning"
            color="error"
            variant="soft"
            icon="i-lucide-triangle-alert"
            :title="overwriteWarning.title"
            :description="overwriteWarning.description"
            :ui="{ title: 'font-semibold' }"
          />
          <TokenDisclosure :steps="tokenSteps" :hg="usesHg || knownMode === 'hg'" />
        </template>

        <!-- 开通 / 覆盖 -->
        <template v-else-if="mode === 'enable' || mode === 'overwrite'">
          <UAlert
            v-if="mode === 'overwrite'"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="会用这个浏览器里的数据替换云端的全部数据"
            description="请在数据最全的浏览器上操作。云端会换一把新钥匙，原来的数据无法再解开。其他设备需要重新启用（输入新密码，或者用鹰角登录重新连接），之后它们多出来的记录会自动补传回来。"
          />
          <URadioGroup v-model="cloudMode" variant="card" :items="modeItems" size="sm" />
          <template v-if="usesHg">
            <HgModeNotice v-model="hgAck" />
            <USwitch v-model="saveAsProfile" :label="profileLabel" :description="usesHg ? PROFILE_HINT_HG : PROFILE_HINT" />
          </template>
          <template v-else>
          <p v-if="mode === 'enable'" class="leading-relaxed text-muted">
            记录在你的浏览器里用密码派生的钥匙加密后才上传，服务器只保存密文，解不开。在别的浏览器、别的设备上输入同一个 UID 和密码，就能取回并合并。
          </p>
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
          <USwitch v-model="saveAsProfile" :label="profileLabel" :description="usesHg ? PROFILE_HINT_HG : PROFILE_HINT" />
          </template>
        </template>

        <!-- 切换模式 -->
        <template v-else-if="mode === 'switch'">
          <UAlert
            v-if="overwriteWarning"
            color="error"
            variant="soft"
            icon="i-lucide-triangle-alert"
            :title="overwriteWarning.title"
            :description="overwriteWarning.description"
            :ui="{ title: 'font-semibold' }"
          />
          <p class="leading-relaxed text-muted">
            {{ knownMode ? `这个账号在云端现在是${MODE_LABEL[knownMode]}，` : '' }}切换为<b class="text-highlighted">{{ MODE_LABEL[cloudMode] }}</b>。
          </p>
          <div v-if="switchNeedsPassword" class="space-y-2 rounded-(--ui-radius) border border-default p-3">
            <p class="text-xs leading-relaxed text-muted">
              这台设备上没有这个账号的钥匙。先输入<b class="text-highlighted">现在的云同步密码</b>，把云端的记录合并到这个浏览器，再覆盖云端：别的设备上传过的记录不会丢。
            </p>
            <UFormField label="现在的云同步密码">
              <UInput v-model="currentPassword" type="password" autocomplete="current-password" class="w-full font-mono" :disabled="overwriteWithoutMerge" />
            </UFormField>
            <UCheckbox
              v-model="overwriteWithoutMerge"
              :disabled="currentPassword.length > 0"
              color="error"
              label="不知道现在的密码：不合并，直接用这个浏览器的数据覆盖"
              description="云端有、这个浏览器里没有的记录会丢失（只存在于其他设备上、还没上传的记录不受影响，那些设备重新启用后会补传）。"
            />
          </div>
          <template v-if="cloudMode === 'hg'">
            <HgModeNotice v-model="hgAck" />
          </template>
          <template v-else>
            <PasswordFields v-model="password" v-model:valid="passwordValid" :uid="account?.uid" :nick-name="account?.nickName" />
            <UAlert
              color="error"
              variant="subtle"
              icon="i-lucide-lock-keyhole"
              title="密码无法找回"
              description="切换后服务器解不开你的数据。忘记密码只能用数据最全的浏览器覆盖云端；本地数据不受影响。"
            />
            <USwitch v-model="remember" label="在这台设备上记住（推荐）" />
            <USwitch v-model="requireHg" label="鹰角 token 双重验证（可选）" />
          </template>
          <USwitch v-model="saveAsProfile" :label="profileLabel" :description="usesHg ? PROFILE_HINT_HG : PROFILE_HINT" />
        </template>

        <!-- 解锁 / 恢复 -->
        <template v-else-if="mode === 'unlock' || mode === 'restore'">
          <p class="leading-relaxed text-muted">
            {{
              hgMode
                ? '这个账号在云端用的是无密码模式：不需要密码，用鹰角 token 证明账号是你的就能连接、下载并合并。'
                : mode === 'unlock'
                  ? '这台设备上没有这个账号的云同步钥匙（新设备、清除过浏览器数据、选择了不记住，或者密码在别处改过、云端被覆盖）。'
                  : '在新设备上，不需要先添加账号：输入 UID 和云同步密码即可取回。'
            }}
          </p>
          <p v-if="mode === 'restore'" class="flex gap-1.5 text-xs leading-relaxed text-muted">
            <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" />
            <span>取回的是记录和账号信息，不包括鹰角登录：token 从来不会上传到云端。要在这台设备上从鹰角同步新记录，需要重新登录一次。</span>
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
          <div
            v-if="mode === 'unlock' && account && profileDiffers"
            class="space-y-2 rounded-(--ui-radius) border border-error/40 bg-error/5 p-3 text-xs leading-relaxed"
          >
            <p class="text-sm font-medium text-highlighted">
              同步配置是{{ MODE_LABEL[cloud.profile!.mode] }}，这个账号在云端是{{ MODE_LABEL[knownMode!] }}
            </p>
            <p class="text-muted">
              可以按同步配置切换：先合并云端的记录，再换新钥匙<b class="text-error">覆盖云端</b>；其他设备需要重新启用。也可以不切换，在下面{{
                knownMode === 'hg' ? '直接连接' : '输入它现在的密码'
              }}。
            </p>
            <UButton
              :label="`切换为${MODE_LABEL[cloud.profile!.mode]}（覆盖云端）`"
              icon="i-lucide-repeat"
              size="xs"
              color="error"
              variant="soft"
              @click="cloud.dialog = { mode: 'switch', accountId: account.id, to: cloud.profile!.mode }"
            />
          </div>
          <p v-if="mode === 'unlock' && knownMode" class="text-xs text-muted">
            云端模式：<b class="text-highlighted">{{ MODE_LABEL[knownMode] }}</b>{{ knownMode === 'hg' ? '（不需要密码）' : '' }}
          </p>
          <USwitch
            v-else
            v-model="hgMode"
            label="这个账号用的是无密码模式"
            description="无密码模式不需要密码：用鹰角 token 证明账号是你的，服务器核实后给出解开数据的钥匙。"
          />
          <template v-if="!hgMode">
            <UFormField label="云同步密码" required>
              <UInput v-model="password" type="password" autocomplete="current-password" class="w-full font-mono" @keydown.enter="submit" />
            </UFormField>
            <USwitch v-model="remember" label="在这台设备上记住（推荐）" />
            <USwitch
              v-model="withHg"
              label="这个账号开启了双重验证"
              :description="detected?.exists ? `检测结果：${detected.requireHg ? '已开启' : '没有开启'}` : undefined"
            />
          </template>
          <USwitch v-model="saveAsProfile" :label="profileLabel" :description="usesHg ? PROFILE_HINT_HG : PROFILE_HINT" />
          <p v-if="mode === 'unlock' && account && !hgMode" class="text-xs text-muted">
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

        <!-- 同步配置：一键启用时只输入一次已开通账号的密码 -->
        <template v-else-if="quickProfile">
          <p class="leading-relaxed text-muted">
            这个浏览器里还没有同步配置。已开通的「{{ knownName }}」在这里记住的是它自己的钥匙（由密码算出来，反推不出密码），所以一键启用需要你输入一次它的云同步密码。
          </p>
          <p class="text-xs leading-relaxed text-muted">
            输入后先在本地核对（不联网），再保存为这个浏览器的同步配置：之后这个浏览器里的其他账号点一下就能启用。同步配置按浏览器保存，换浏览器、换设备，或者测试站和正式站之间，都需要再输入一次。
          </p>
          <UFormField label="云同步密码" required>
            <UInput v-model="password" type="password" autocomplete="current-password" class="w-full font-mono" @keydown.enter="submit" />
          </UFormField>
          <USwitch v-model="remember" label="在这台设备上记住（推荐）" :description="PROFILE_HINT" />
        </template>

        <!-- 同步配置 -->
        <template v-else-if="mode === 'profile'">
          <p class="leading-relaxed text-muted">
            在这台设备上记下云同步密码和选项。之后这台设备上的其他账号（例如同一个鹰角账号下的另一个游戏、另一个服务器的角色）开通或启用云同步时，点一下就完成，不用再输入密码和选项。
          </p>
          <p class="text-xs leading-relaxed text-muted">
            同步配置只存在这台设备上，不上传，也不会同步到别的设备；不包含鹰角登录（token）。需要证明账号是你的时候，仍然用这台设备上保存的登录，或者临时粘贴 token。
          </p>
          <UAlert v-if="cloud.profile" color="neutral" variant="subtle" icon="i-lucide-info" description="保存后会替换现有的同步配置。" />
          <URadioGroup v-model="cloudMode" variant="card" :items="modeItems" size="sm" />
          <template v-if="usesHg">
            <HgModeNotice v-model="hgAck" />
          </template>
          <template v-else>
            <PasswordFields v-model="password" v-model:valid="passwordValid" label="云同步密码" />
            <p class="text-xs leading-relaxed text-muted">一般和已开通账号的密码相同。保存前会用一个已开通账号的钥匙在本地核对一次（不联网）。</p>
            <USwitch v-model="requireHg" label="新开通的账号开启鹰角 token 双重验证" />
            <USwitch v-model="remember" label="在这台设备上记住（推荐）" :description="PROFILE_HINT" />
          </template>
          <UAlert v-if="mismatch" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="mismatch" />
          <div v-if="profileMismatched.length" class="space-y-2 rounded-(--ui-radius) border border-error/40 bg-error/5 p-3 text-xs leading-relaxed">
            <p class="flex items-center gap-1.5 text-sm font-medium text-highlighted">
              <UIcon name="i-lucide-triangle-alert" class="size-4 text-error" />
              这台设备上已开通的 {{ profileMismatched.length }} 个账号是{{ cloudMode === 'hg' ? '密码模式' : '无密码模式' }}
            </p>
            <p class="text-muted">
              {{ profileMismatched.map((a) => a.nickName).join('、') }}。切换为{{ MODE_LABEL[cloudMode] }}要<b class="text-error">覆盖云端</b>：先下载云端的记录合并到这个浏览器，再换一把新钥匙替换云端的全部数据；其他设备需要重新启用。
            </p>
            <USwitch v-model="applyToEnabled" color="error" size="sm" :label="`保存后把这些账号切换为${MODE_LABEL[cloudMode]}（覆盖云端，会再请你确认一次）`" />
          </div>
        </template>

        <HgTokenField v-if="needsToken && !confirming" v-model="tokenText" v-model:ready="tokenReady" :account="account" :reason="tokenReason" />

        <UAlert v-if="hgBlocked" color="warning" variant="subtle" icon="i-lucide-cloud-off" description="服务器还没有配置无密码模式，请使用密码模式。" />
        <div v-if="working" class="space-y-1">
          <p class="text-xs text-muted">{{ usesHg ? '正在处理…' : '正在处理：由密码计算钥匙可能需要几秒，较旧的设备会更久。' }}</p>
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
            :color="mode === 'delete' || mode === 'overwrite' || (confirming && overwriteWarning) ? 'error' : 'primary'"
            :loading="working"
            :disabled="!canSubmit"
            @click="submit"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
