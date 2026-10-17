/**
 * 云同步的界面状态与操作（流程见 src/lib/cloud/engine.ts）。
 * 打开哪个对话框、正在处理哪个账号、检测到的云端状态、同步配置，以及从鹰角同步记录之后顺便云同步。
 *
 * 鹰角 token：只有用户点击按钮、并在确认弹窗里点了“确认发送”才会发给云同步接口（见 src/lib/cloud/consent.ts）。
 * 自动进行的云同步（从鹰角同步记录之后）只处理不需要鹰角 token 的账号。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { apiInfo, CloudApiError, type CloudStatus } from '@/lib/cloud/api'
import { type Consent, ConsentError, cloudOAuthToken, revokeConsent } from '@/lib/cloud/consent'
import { cloudStatus, CloudSyncError, enableCloud, syncCloud, type SyncSummary, unlockCloud, unlockHgCloud } from '@/lib/cloud/engine'
import { loadProfile, profileInfo, type SyncProfileInfo } from '@/lib/cloud/profile'
import { type CloudState, isReady } from '@/lib/cloud/state'
import { db } from '@/lib/db'
import type { Account, Game } from '@/lib/types'

export type CloudDialogMode = 'enable' | 'overwrite' | 'unlock' | 'restore' | 'password' | 'twofactor' | 'delete' | 'profile' | 'switch'

export interface CloudDialog {
  mode: CloudDialogMode
  accountId?: string
  /** restore：预先选好的游戏 */
  game?: Game
  /** 打开时显示的提示（例如同步配置里的密码对这个账号不对） */
  note?: string
  /** profile：保存同步配置之后接着一键启用这个账号 */
  continueWith?: string
  /** unlock / restore：预先选好“无密码模式” */
  hg?: boolean
}

/** 发送鹰角 token 前的确认弹窗（TokenConsentDialog.vue） */
export interface ConsentRequest {
  title: string
  /** 这次会做的事，按顺序 */
  steps: string[]
  accounts: Account[]
  /** 刚才从鹰角同步记录时用过的账号 token（只在内存里） */
  accountToken?: string
  resolve: (consent: Consent | null) => void
}

export interface Detected {
  status: CloudStatus
  at: number
}

export function describeError(error: unknown): string {
  if (error instanceof CloudSyncError || error instanceof CloudApiError || error instanceof ConsentError) return error.message
  return error instanceof Error ? error.message : String(error)
}

export const useCloudStore = defineStore('cloud', () => {
  const toast = useToast()
  const states = useLiveQuery(() => db.cloud.toArray(), [], [] as CloudState[])
  /** 内存里的钥匙不在数据库里，变化时手动通知界面 */
  const keysVersion = ref(0)
  const byAccount = computed(() => {
    void keysVersion.value
    // hasKeys：这台设备上能直接云同步（无密码模式不需要钥匙，每次用鹰角 token）
    return new Map(states.value.map((s) => [s.accountId, { state: s, hasKeys: isReady(s) }]))
  })
  const busy = ref<string | null>(null)
  /** 正在处理的账号的进度（由密码计算钥匙） */
  const progress = ref<number | null>(null)
  const dialog = ref<CloudDialog | null>(null)
  const consentRequest = ref<ConsentRequest | null>(null)
  /** 点击“检测云端状态”得到的结果（只在内存里） */
  const detected = ref(new Map<string, Detected>())
  const profile = ref<SyncProfileInfo | null>(null)
  /** 服务器是否配置了云同步、无密码模式（null：还不知道） */
  const available = ref<boolean | null>(null)
  const hgAvailable = ref<boolean | null>(null)
  void apiInfo().then((info) => {
    available.value = info ? info.available : null
    hgAvailable.value = info ? Boolean(info.hgAvailable) : null
  })

  function touchKeys() {
    keysVersion.value++
  }

  async function refreshProfile() {
    profile.value = await profileInfo()
  }
  void refreshProfile()

  function open(mode: CloudDialogMode, accountId?: string, game?: Game, note?: string, continueWith?: string) {
    dialog.value = { mode, accountId, game, note, continueWith }
  }

  /** 弹出确认窗口；用户点“确认发送”返回 Consent，取消返回 null */
  function askConsent(request: Omit<ConsentRequest, 'resolve'>): Promise<Consent | null> {
    consentRequest.value?.resolve(null)
    return new Promise((resolve) => {
      consentRequest.value = {
        ...request,
        resolve: (consent) => {
          consentRequest.value = null
          resolve(consent)
        },
      }
    })
  }

  function setDetected(accountId: string, status: CloudStatus) {
    const next = new Map(detected.value)
    next.set(accountId, { status, at: Date.now() })
    detected.value = next
  }

  /** 云同步一个账号；开启了双重验证的账号先弹出确认。quiet：没开通时不提示 */
  async function sync(account: Account, options: { quiet?: boolean; accountToken?: string } = {}): Promise<SyncSummary | null> {
    const entry = byAccount.value.get(account.id)
    if (!entry) {
      if (!options.quiet) open('enable', account.id)
      return null
    }
    if (busy.value) return null
    let consent: Consent | null = null
    if (entry.state.requireHg) {
      consent = await askConsent({
        title: '云同步需要核实账号',
        steps: [
          entry.state.mode === 'hg'
            ? '这个账号用的是无密码模式：每次云同步都要用鹰角 token 向服务器证明账号是你的，服务器核实后给出解开数据的钥匙'
            : '这个账号开启了双重验证：每次云同步都要用鹰角 token 向服务器证明账号是你的',
          '下载云端的新记录并合并，上传本地多出来的记录',
        ],
        accounts: [account],
        accountToken: options.accountToken,
      })
      if (!consent) return null
    }
    busy.value = account.id
    try {
      const oauthToken = consent ? await cloudOAuthToken(consent, account.id, account) : undefined
      const result = await syncCloud(account.id, { oauthToken })
      toast.add({
        title: '云同步完成',
        description:
          result.downloaded || result.uploaded
            ? `${account.nickName}：从云端新增 ${result.downloaded} 条，上传 ${result.uploaded} 条`
            : `${account.nickName}：本地与云端一致`,
        color: 'success',
        icon: 'i-lucide-cloud-check',
      })
      return result
    } catch (error) {
      if (error instanceof CloudSyncError && (error.code === 'need_password' || error.code === 'auth_changed')) {
        touchKeys()
        toast.add({ title: error.code === 'auth_changed' ? '需要重新启用云同步' : '需要输入云同步密码', description: error.message, color: 'warning', icon: 'i-lucide-key-round' })
        open('unlock', account.id)
      } else {
        toast.add({ title: '云同步失败', description: describeError(error), color: 'error', icon: 'i-lucide-cloud-off' })
      }
      return null
    } finally {
      busy.value = null
      revokeConsent(consent)
    }
  }

  /**
   * 从鹰角同步记录成功之后：开通了云同步、这台设备上有钥匙的账号顺便云同步一次。
   * 开启了双重验证的账号需要发送鹰角 token，不自动进行，只提示用户点击。
   */
  async function afterHgSync(account: Account, accountToken: string): Promise<void> {
    const entry = byAccount.value.get(account.id)
    if (!entry?.hasKeys) return
    if (entry.state.requireHg) {
      toast.add({
        title: '要顺便云同步吗？',
        description: `${account.nickName} ${entry.state.mode === 'hg' ? '用的是无密码模式' : '开启了双重验证'}，云同步需要发送鹰角 token，所以不会自动进行。`,
        color: 'neutral',
        icon: 'i-lucide-cloud',
        duration: 15_000,
        actions: [{ label: '云同步', icon: 'i-lucide-refresh-cw', color: 'primary', variant: 'soft', onClick: () => void sync(account, { accountToken }) }],
      })
      return
    }
    await sync(account, { quiet: true })
  }

  /** 检测云端状态（需要发送鹰角 token，先弹出确认）。只检测这台设备上还没开通的账号 */
  async function detect(accounts: Account[]): Promise<void> {
    const targets = accounts.filter((a) => !byAccount.value.has(a.id))
    if (!targets.length || busy.value) return
    const consent = await askConsent({
      title: targets.length > 1 ? `检测 ${targets.length} 个账号的云端状态` : '检测云端状态',
      steps: ['用鹰角 token 向服务器证明账号是你的', '服务器回答：云端有没有开通这个账号、是否开启了双重验证（不返回任何数据）'],
      accounts: targets,
    })
    if (!consent) return
    const failed: string[] = []
    try {
      for (const a of targets) {
        busy.value = a.id
        try {
          setDetected(a.id, await cloudStatus(a, await cloudOAuthToken(consent, a.id, a)))
        } catch (error) {
          failed.push(`${a.nickName}：${describeError(error)}`)
        }
      }
    } finally {
      busy.value = null
      revokeConsent(consent)
    }
    if (failed.length) {
      toast.add({ title: '部分账号检测失败', description: failed.join('；'), color: 'error', icon: 'i-lucide-cloud-off', duration: 10_000 })
    } else {
      const found = targets.filter((a) => detected.value.get(a.id)?.status.exists).length
      toast.add({
        title: '检测完成',
        description: found
          ? `${found} 个账号已在云端开通，可以${targets.some((a) => isHgDetected(a.id)) ? '直接连接（无密码模式）、' : ''}输入密码${profile.value ? '或一键启用' : ''}。`
          : '这些账号都还没有在云端开通。',
        color: 'success',
        icon: 'i-lucide-search-check',
      })
    }
  }

  function isHgDetected(accountId: string): boolean {
    const d = detected.value.get(accountId)?.status
    return Boolean(d?.exists && d.mode === 'hg')
  }

  /**
   * 用同步配置一键开始：云端没开通就开通，开通了就解锁并合并（无密码模式的账号直接连接，不需要密码）。
   * 需要鹰角 token 的步骤（检测、开通、双重验证账号的解锁）会先弹出确认，一次确认涵盖整个流程。
   */
  async function quickStart(account: Account): Promise<void> {
    if (busy.value) return
    const entry = byAccount.value.get(account.id)
    const config = await loadProfile()
    // 已知是无密码模式的账号：不需要同步配置，也不需要密码
    const hgKnown = entry ? entry.state.mode === 'hg' : isHgDetected(account.id)
    if (!config && !hgKnown) {
      // 还没有同步配置：先设置（只保存在这台设备上），保存后接着为这个账号启用
      open(
        'profile',
        undefined,
        undefined,
        `这个浏览器里还没有同步配置（同步配置按浏览器保存）。保存后接着为「${account.nickName}」启用：云端还没开通就开通，已经开通就用这个密码解锁。`,
        account.id,
      )
      return
    }
    let status: CloudStatus | null = entry
      ? { exists: true, mode: entry.state.mode, requireHg: entry.state.requireHg }
      : (detected.value.get(account.id)?.status ?? null)
    const needsToken = !status || !status.exists || status.requireHg
    const enableStep = config?.mode === 'hg' ? '按同步配置用无密码模式开通（记录在浏览器里加密后上传；服务器技术上能解密）' : '按同步配置开通（记录在浏览器里加密后上传）'
    let consent: Consent | null = null
    if (needsToken) {
      consent = await askConsent({
        title: '一键启用云同步',
        steps: !status
          ? [
              '用鹰角 token 向服务器证明账号是你的，并检测云端状态',
              `云端还没开通：${enableStep}`,
              '云端已经开通：无密码模式直接连接；密码模式用同步配置里的密码解锁，下载并合并',
            ]
          : !status.exists
            ? ['用鹰角 token 向服务器证明账号是你的', enableStep]
            : status.mode === 'hg'
              ? ['这个账号用的是无密码模式：用鹰角 token 向服务器证明账号是你的，服务器核实后给出解开数据的钥匙', '下载并合并，上传本地多出来的记录']
              : ['这个账号开启了双重验证：用鹰角 token 向服务器证明账号是你的', '用同步配置里的密码解锁，下载并合并'],
        accounts: [account],
      })
      if (!consent) return
    }
    busy.value = account.id
    progress.value = null
    const onProgress = (fraction: number) => (progress.value = fraction)
    try {
      const token = () => cloudOAuthToken(consent!, account.id, account)
      if (!status) {
        status = await cloudStatus(account, await token())
        setDetected(account.id, status)
      }
      if (!status.exists) {
        if (!config) {
          // 检测结果过期了（云端已经被删除）：先设置同步配置
          open('profile', undefined, undefined, `「${account.nickName}」在云端还没有开通。保存同步配置后接着开通。`, account.id)
          return
        }
        await enableCloud(account, {
          mode: config.mode,
          password: config.password,
          oauthToken: await token(),
          requireHg: config.requireHg,
          remember: config.remember,
          overwrite: false,
          onProgress,
        })
        toast.add({
          title: '已开通云同步',
          description: `${account.nickName}：按同步配置开通完成${config.mode === 'hg' ? '（无密码模式）' : ''}。`,
          color: 'success',
          icon: 'i-lucide-cloud-check',
        })
      } else if (status.mode === 'hg') {
        const result = await unlockHgCloud(account, { oauthToken: await token() })
        toast.add({
          title: '云同步完成',
          description: `${account.nickName}（无密码模式）：从云端新增 ${result.downloaded} 条，上传 ${result.uploaded} 条`,
          color: 'success',
          icon: 'i-lucide-cloud-check',
        })
      } else if (!config || config.mode === 'hg') {
        open('unlock', account.id, undefined, '这个账号用的是密码模式，请输入它的云同步密码。')
        return
      } else {
        const result = await unlockCloud(account, {
          password: config.password,
          remember: config.remember,
          oauthToken: status.requireHg ? await token() : undefined,
          onProgress,
        })
        toast.add({
          title: '云同步完成',
          description: `${account.nickName}：从云端新增 ${result.downloaded} 条，上传 ${result.uploaded} 条`,
          color: 'success',
          icon: 'i-lucide-cloud-check',
        })
      }
      touchKeys()
    } catch (error) {
      if (error instanceof CloudSyncError && error.code === 'wrong_password') {
        open('unlock', account.id, undefined, '同步配置里的密码对这个账号不对（这个账号可能用的是别的密码），请手动输入。')
      } else if (error instanceof CloudSyncError && error.code === 'already_enabled') {
        open('unlock', account.id, undefined, error.message)
      } else if (error instanceof CloudSyncError && error.code === 'weak_password') {
        open('enable', account.id, undefined, '同步配置里的密码不能用于这个账号（例如包含了这个账号的 UID 或昵称），请手动设置。')
      } else {
        toast.add({ title: '一键启用失败', description: describeError(error), color: 'error', icon: 'i-lucide-cloud-off' })
      }
    } finally {
      busy.value = null
      progress.value = null
      revokeConsent(consent)
    }
  }

  return {
    states,
    byAccount,
    busy,
    progress,
    dialog,
    consentRequest,
    detected,
    profile,
    available,
    hgAvailable,
    open,
    askConsent,
    setDetected,
    sync,
    afterHgSync,
    detect,
    quickStart,
    refreshProfile,
    touchKeys,
  }
})
