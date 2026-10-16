import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { db } from '@/lib/db'
import { type AkMeta, type EfMeta, loadAkMeta, loadEfMeta } from '@/lib/meta'
import type { Account, Game } from '@/lib/types'
import { fetchUsageSummary, reportUsage, setUsageOptOut, type UsageSummary, usageNoticeSeen, usageOptedOut } from '@/lib/usage'

export const APP_VERSION = __APP_VERSION__

export const useAppStore = defineStore('app', () => {
  const game = ref<Game>(localStorage.getItem('arkrecord:game') === 'endfield' ? 'endfield' : 'arknights')
  watch(
    game,
    (value) => {
      localStorage.setItem('arkrecord:game', value)
      document.documentElement.dataset.game = value
    },
    { immediate: true },
  )

  const accounts = useLiveQuery(() => db.accounts.orderBy('createdAt').toArray(), [], [] as Account[])
  const activeIds = useLocalStorage<Record<Game, string>>('arkrecord:active', { arknights: '', endfield: '' })
  const gameAccounts = computed(() => accounts.value.filter((a) => a.game === game.value))
  const activeAccount = computed<Account | null>(
    () => gameAccounts.value.find((a) => a.id === activeIds.value[game.value]) ?? gameAccounts.value[0] ?? null,
  )

  function selectAccount(account: Account) {
    game.value = account.game
    activeIds.value = { ...activeIds.value, [account.game]: account.id }
  }

  const meta = shallowRef<AkMeta | null>(null)
  void loadAkMeta().then((m) => (meta.value = m))
  const efMeta = shallowRef<EfMeta | null>(null)
  void loadEfMeta().then((m) => (efMeta.value = m))
  /** 已镜像到本站的头像，元数据加载完成后头像组件会自动切换到图片 */
  const akAvatars = computed(() => new Set(meta.value?.avatars ?? []))
  const efAvatars = computed(() => new Set(efMeta.value?.avatars ?? []))

  const loginOpen = ref(false)

  // ── 匿名使用统计（见 src/lib/usage.ts） ──
  const usage = shallowRef<UsageSummary | null>(null)
  const usageOptOut = ref(usageOptedOut())
  function setUsageParticipation(participate: boolean) {
    setUsageOptOut(!participate)
    usageOptOut.value = !participate
  }
  void fetchUsageSummary().then((s) => (usage.value = s))
  // 等账号列表从 IndexedDB 读出来之后再上报（每天最多一次）。
  // 第一次打开时先显示统计说明，等说明消失（约 20 秒）后再上报，让用户有机会先选择不参与。
  const firstVisit = !usageNoticeSeen()
  setTimeout(() => void reportUsage(accounts.value.map((a) => a.game)), firstVisit ? 25_000 : 3000)

  return {
    game,
    accounts,
    gameAccounts,
    activeAccount,
    selectAccount,
    meta,
    efMeta,
    akAvatars,
    efAvatars,
    loginOpen,
    usage,
    usageOptOut,
    setUsageParticipation,
  }
})
