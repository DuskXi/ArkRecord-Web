import { defineStore } from 'pinia'
import { ref } from 'vue'
import { HgError } from '@/lib/hg/client'
import { syncArknights, type SyncProgress } from '@/lib/sync/arknights'
import { syncEndfield } from '@/lib/sync/endfield'
import type { Account } from '@/lib/types'
import { useAppStore } from './app'

export const useSyncStore = defineStore('sync', () => {
  const running = ref(false)
  const progress = ref<SyncProgress | null>(null)
  const toast = useToast()

  /** 同步一个账号；没有保存账号 token 时打开登录窗口 */
  async function sync(account: Account, options: { token?: string; full?: boolean } = {}): Promise<boolean> {
    const app = useAppStore()
    const token = options.token ?? account.accountToken
    if (!token) {
      app.loginOpen = true
      return false
    }
    if (running.value) return false
    running.value = true
    progress.value = { stage: '准备中', added: 0 }
    try {
      const run = account.game === 'arknights' ? syncArknights : syncEndfield
      const result = await run(account, token, { full: options.full, onProgress: (p) => (progress.value = p) })
      toast.add({
        title: result.added ? `同步完成，新增 ${result.added} 条记录` : '同步完成，没有新记录',
        description: `${account.nickName} · 本次读取 ${result.fetched} 条`,
        color: 'success',
        icon: 'i-lucide-circle-check',
      })
      return true
    } catch (error) {
      if (error instanceof HgError && error.kind === 'auth') {
        toast.add({ title: '登录状态已失效', description: '请重新粘贴账号 token', color: 'warning', icon: 'i-lucide-key-round' })
        app.loginOpen = true
      } else {
        toast.add({
          title: '同步失败',
          description: error instanceof Error ? error.message : String(error),
          color: 'error',
          icon: 'i-lucide-circle-x',
        })
      }
      return false
    } finally {
      running.value = false
      progress.value = null
    }
  }

  return { running, progress, sync }
})
