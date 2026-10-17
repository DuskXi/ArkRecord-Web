/**
 * 云同步的界面状态与操作（流程见 src/lib/cloud/engine.ts）。
 * 打开哪个对话框、正在同步哪个账号，以及从鹰角同步记录之后自动做一次云同步。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { CloudApiError } from '@/lib/cloud/api'
import { CloudSyncError, syncCloud, type SyncSummary } from '@/lib/cloud/engine'
import { type CloudState, keysOf } from '@/lib/cloud/state'
import { db } from '@/lib/db'
import { grantOAuthToken, parseAccountToken } from '@/lib/hg/auth'
import type { Account, Game } from '@/lib/types'

export type CloudDialogMode = 'enable' | 'overwrite' | 'unlock' | 'restore' | 'password' | 'twofactor' | 'delete' | 'token'

export interface CloudDialog {
  mode: CloudDialogMode
  accountId?: string
  /** restore：预先选好的游戏 */
  game?: Game
}

export function describeError(error: unknown): string {
  if (error instanceof CloudSyncError || error instanceof CloudApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * 换取鹰角 OAuth token（只用于让 Worker 核实账号归属）：优先用对话框里粘贴的账号 token，
 * 否则用这个账号保存的登录。都没有时返回 null。
 */
export async function oauthFor(account: Account | undefined, pasted?: string): Promise<string | null> {
  const token = (pasted ? parseAccountToken(pasted) : null) ?? account?.accountToken
  return token ? grantOAuthToken(token) : null
}

export const useCloudStore = defineStore('cloud', () => {
  const toast = useToast()
  const states = useLiveQuery(() => db.cloud.toArray(), [], [] as CloudState[])
  /** 内存里的钥匙不在数据库里，变化时手动通知界面 */
  const keysVersion = ref(0)
  const byAccount = computed(() => {
    void keysVersion.value
    return new Map(states.value.map((s) => [s.accountId, { state: s, hasKeys: keysOf(s) !== null }]))
  })
  const busy = ref<string | null>(null)
  const dialog = ref<CloudDialog | null>(null)

  function touchKeys() {
    keysVersion.value++
  }

  function open(mode: CloudDialogMode, accountId?: string, game?: Game) {
    dialog.value = { mode, accountId, game }
  }

  /** 云同步一个账号；需要密码或鹰角 token 时打开对应的对话框。quiet：没开通时不提示 */
  async function sync(account: Account, options: { quiet?: boolean; oauthToken?: string } = {}): Promise<SyncSummary | null> {
    const entry = byAccount.value.get(account.id)
    if (!entry) {
      if (!options.quiet) open('enable', account.id)
      return null
    }
    if (busy.value) return null
    busy.value = account.id
    try {
      let oauthToken = options.oauthToken
      if (entry.state.requireHg && !oauthToken) {
        oauthToken = (await oauthFor(account)) ?? undefined
        if (!oauthToken) {
          open('token', account.id)
          return null
        }
      }
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
        toast.add({ title: '需要输入云同步密码', description: error.message, color: 'warning', icon: 'i-lucide-key-round' })
        open('unlock', account.id)
      } else if (error instanceof CloudSyncError && error.code === 'need_hg') {
        open('token', account.id)
      } else {
        toast.add({ title: '云同步失败', description: describeError(error), color: 'error', icon: 'i-lucide-cloud-off' })
      }
      return null
    } finally {
      busy.value = null
    }
  }

  /** 从鹰角同步记录成功之后：如果这个账号开通了云同步、这台设备上有钥匙，就顺便云同步一次 */
  async function afterHgSync(account: Account, accountToken: string): Promise<void> {
    const entry = byAccount.value.get(account.id)
    if (!entry?.hasKeys) return
    let oauthToken: string | undefined
    if (entry.state.requireHg) {
      try {
        oauthToken = await grantOAuthToken(accountToken)
      } catch {
        return
      }
    }
    await sync(account, { quiet: true, oauthToken })
  }

  return { states, byAccount, busy, dialog, open, oauthFor, sync, afterHgSync, touchKeys }
})
