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
import { cloudStatus, CloudSyncError, enableCloud, switchCloudMode, syncCloud, type SyncSummary, unlockCloud, unlockHgCloud } from '@/lib/cloud/engine'
import { loadProfile, profileInfo, type SyncProfile, type SyncProfileInfo } from '@/lib/cloud/profile'
import { type CloudState, isReady } from '@/lib/cloud/state'
import { db } from '@/lib/db'
import { loadConflicts, loadDeviceUser, resolveConflict, type SyncUserConflict } from '@/lib/sync-user'
import type { Account, Game } from '@/lib/types'
import type { CloudMode } from '../../shared/cloud-protocol'

export const MODE_LABEL: Record<CloudMode, string> = { password: '密码模式', hg: '无密码模式' }

/** 切换模式会覆盖云端：确认时醒目地写出来 */
/** merge：false 表示用户选择了不合并、直接覆盖 */
export function switchWarning(to: CloudMode, merge = true): { title: string; description: string } {
  return {
    title: `会用这个浏览器的数据覆盖云端，切换为${MODE_LABEL[to]}`,
    description:
      (merge
        ? '先下载云端的记录并合并到这个浏览器，再换一把新钥匙，用这个浏览器的数据替换云端的全部数据。'
        : '不合并云端的记录：直接换一把新钥匙，用这个浏览器的数据替换云端的全部数据，云端有、这个浏览器里没有的记录会丢失。') +
      `其他设备上的这个账号需要重新启用（${to === 'hg' ? '用鹰角登录连接' : '输入新的云同步密码'}），它们还没上传的记录在重新启用后会补传。` +
      (to === 'hg' ? '无密码模式下，本站运营者和拿到你有效鹰角 token 的人技术上能读取你的云端记录。' : ''),
  }
}

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
  /** switch：切换到哪种模式（默认切换到另一种） */
  to?: CloudMode
}

/** 发送鹰角 token 前的确认弹窗（TokenConsentDialog.vue） */
export interface ConsentRequest {
  title: string
  /** 这次会做的事，按顺序 */
  steps: string[]
  accounts: Account[]
  /** 刚才从鹰角同步记录时用过的账号 token（只在内存里） */
  accountToken?: string
  /** 醒目的提示（例如切换模式会覆盖云端） */
  warning?: { title: string; description: string }
  /** 涉及无密码模式：服务器核实后会给出解开数据的钥匙 */
  hg?: boolean
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
  /** 同步识别码对不上、要问用户的账号（同步时记下，见 src/lib/sync-user.ts），以及本机识别码的生成时间 */
  const userConflicts = useLiveQuery(
    async () => {
      const [conflicts, device] = await Promise.all([loadConflicts(), loadDeviceUser()])
      return { conflicts: conflicts as SyncUserConflict[], deviceCreatedAt: device?.createdAt }
    },
    [],
    { conflicts: [] as SyncUserConflict[], deviceCreatedAt: undefined as number | undefined },
  )
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
        hg: entry.state.mode === 'hg',
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
    // 同步配置的模式和云端不一致：按同步配置切换（覆盖云端），见 switchToProfile
    type Existing = Extract<CloudStatus, { exists: true }>
    const mismatched = (s: CloudStatus | null): boolean => Boolean(config && s?.exists && s.mode !== config.mode)
    if (mismatched(status)) return switchToProfile(account, config!, status as Existing)
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
              `云端已经开通：模式和同步配置一样就${config?.mode === 'hg' ? '直接连接' : '用同步配置里的密码解锁'}，下载并合并；不一样时会先再问你一次（切换模式要覆盖云端）`,
            ]
          : !status.exists
            ? ['用鹰角 token 向服务器证明账号是你的', enableStep]
            : status.mode === 'hg'
              ? ['这个账号用的是无密码模式：用鹰角 token 向服务器证明账号是你的，服务器核实后给出解开数据的钥匙', '下载并合并，上传本地多出来的记录']
              : ['这个账号开启了双重验证：用鹰角 token 向服务器证明账号是你的', '用同步配置里的密码解锁，下载并合并'],
        accounts: [account],
        hg: config?.mode === 'hg' || (status?.exists === true && status.mode === 'hg'),
      })
      if (!consent) return
    }
    busy.value = account.id
    progress.value = null
    const onProgress = (fraction: number) => (progress.value = fraction)
    /** 检测之后才发现模式不一致：结束这一步，再单独确认切换 */
    let switchTo: Existing | null = null
    try {
      const token = () => cloudOAuthToken(consent!, account.id, account)
      if (!status) {
        status = await cloudStatus(account, await token())
        setDetected(account.id, status)
      }
      if (mismatched(status)) {
        switchTo = status as Existing
      } else if (!status.exists) {
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
      } else if (!config) {
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
    if (switchTo && config) await switchToProfile(account, config, switchTo)
  }

  /**
   * 一键启用时云端的模式和同步配置不一样：按同步配置切换，也就是先合并云端数据、再用新的方式覆盖云端。
   * 能合并时（这台设备上能云同步这个账号，或者云端是无密码模式）弹出醒目的确认后直接切换；
   * 云端是密码模式、这台设备上又没有钥匙时，打开切换对话框：输入现在的密码合并，或者明确选择直接覆盖。
   */
  async function switchToProfile(account: Account, config: SyncProfile, status: Extract<CloudStatus, { exists: true }>): Promise<void> {
    const entry = byAccount.value.get(account.id)
    const canMerge = status.mode === 'hg' || Boolean(entry && entry.state.mode === status.mode && entry.hasKeys)
    if (!canMerge) {
      dialog.value = {
        mode: 'switch',
        accountId: account.id,
        to: config.mode,
        note: `同步配置是${MODE_LABEL[config.mode]}，这个账号在云端是${MODE_LABEL[status.mode]}，所以要按同步配置切换模式（覆盖云端）；这台设备上没有这个账号的钥匙，需要先输入现在的云同步密码合并云端数据，或者选择不合并、直接覆盖。`,
      }
      return
    }
    await switchAccounts([account], config)
  }

  /**
   * 把账号切换为同步配置的模式（覆盖云端）：一次确认涵盖全部账号，确认窗口醒目地写出会覆盖云端。
   * 需要先输入密码才能合并云端数据的账号跳过，并提示在它那一行单独切换。
   */
  async function switchAccounts(accounts: Account[], config?: SyncProfile | null): Promise<void> {
    config ??= await loadProfile()
    if (!config || busy.value || !accounts.length) return
    const to = config.mode
    const consent = await askConsent({
      title: accounts.length > 1 ? `把 ${accounts.length} 个账号切换为${MODE_LABEL[to]}` : `切换为${MODE_LABEL[to]}`,
      steps: [
        '用鹰角 token 向服务器证明账号是你的',
        '下载云端的记录，合并到这个浏览器（别的设备上传过的记录不会丢）',
        `换一把新钥匙，用这个浏览器的数据覆盖云端，切换为${MODE_LABEL[to]}${to === 'password' ? '（使用同步配置里的密码）' : ''}`,
      ],
      accounts,
      warning: switchWarning(to),
      hg: true,
    })
    if (!consent) return
    const done: string[] = []
    const skipped: Account[] = []
    const failed: string[] = []
    try {
      for (const a of accounts) {
        busy.value = a.id
        progress.value = null
        try {
          const result = await switchCloudMode(a, {
            to,
            password: config.password,
            oauthToken: await cloudOAuthToken(consent, a.id, a),
            requireHg: config.requireHg,
            remember: config.remember,
            onProgress: (fraction) => (progress.value = fraction),
          })
          done.push(result.created ? `${a.nickName}（云端原来没有开通，已直接开通）` : a.nickName)
        } catch (error) {
          if (error instanceof CloudSyncError && error.code === 'need_password') skipped.push(a)
          else if (error instanceof CloudSyncError && error.code === 'wrong_mode') done.push(a.nickName)
          else failed.push(`${a.nickName}：${describeError(error)}`)
        }
      }
    } finally {
      busy.value = null
      progress.value = null
      revokeConsent(consent)
      touchKeys()
    }
    if (done.length) {
      toast.add({
        title: `已切换为${MODE_LABEL[to]}`,
        description: `${done.join('、')}。其他设备需要重新启用（${to === 'hg' ? '用鹰角登录连接' : '输入新的云同步密码'}）。`,
        color: 'success',
        icon: 'i-lucide-cloud-check',
        duration: 10_000,
      })
    }
    if (skipped.length) {
      toast.add({
        title: '有账号需要先输入密码',
        description: `${skipped.map((a) => a.nickName).join('、')}：这台设备上没有它的钥匙，切换前要先输入现在的云同步密码合并云端数据（不知道密码也可以选择直接覆盖）。${skipped.length > 1 ? '请在它那一行的“…”里选择切换。' : ''}`,
        color: 'warning',
        icon: 'i-lucide-key-round',
        duration: 15_000,
        actions:
          skipped.length === 1
            ? [{ label: '切换', icon: 'i-lucide-arrow-left-right', color: 'warning', variant: 'soft', onClick: () => (dialog.value = { mode: 'switch', accountId: skipped[0]!.id, to }) }]
            : undefined,
      })
    }
    if (failed.length) toast.add({ title: '切换失败', description: failed.join('；'), color: 'error', icon: 'i-lucide-cloud-off', duration: 15_000 })
  }

  /** 回答同步识别码冲突。“是同一个人”改过的账号在下次云同步时上传 */
  async function answerUserConflict(accountId: string, answer: 'same' | 'other' | 'later'): Promise<void> {
    try {
      const changed = await resolveConflict(accountId, answer)
      if (answer === 'same') {
        toast.add({
          title: '已改用先生成的同步识别码',
          description: changed.length ? `下次云同步时随数据上传（${changed.length} 个账号）。` : '这台设备上的账号已经在用它。',
          color: 'success',
          icon: 'i-lucide-user-check',
        })
      }
    } catch (error) {
      toast.add({ title: '保存失败', description: describeError(error), color: 'error', icon: 'i-lucide-circle-x' })
    }
  }

  return {
    states,
    userConflicts,
    answerUserConflict,
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
    switchAccounts,
    refreshProfile,
    touchKeys,
  }
})
