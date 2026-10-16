import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { db } from '@/lib/db'
import { type AkMeta, type EfMeta, loadAkMeta, loadEfMeta } from '@/lib/meta'
import { markWelcomeSeen, welcomeSeen } from '@/lib/onboarding'
import type { Account, Game } from '@/lib/types'
import { loadCloudflareAnalytics } from '@/lib/analytics'
import { type Consent, readConsent, writeConsent } from '@/lib/consent'
import { fetchUsageSummary, reportUsage, type UsageSummary, usageNoticeSeen } from '@/lib/usage'

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

  // ── 第一次访问的引导：欢迎窗口 → 旧版数据迁移（有旧数据时）→ 统计同意 ──
  const consent = ref<Consent | null>(readConsent())
  /** 全新访问（没看过欢迎窗口、没做过统计选择、也没用过之前的版本）才显示欢迎窗口 */
  const welcomeOpen = ref(!welcomeSeen() && consent.value === null && !usageNoticeSeen())
  function closeWelcome() {
    markWelcomeSeen()
    welcomeOpen.value = false
  }
  /** 旧版数据迁移的进度（由 LegacyMigration 更新）：检查中 / 窗口打开 / 结束或不需要 */
  const legacyStep = ref<'checking' | 'open' | 'done'>('checking')
  /** 前面的窗口都关掉之后，才显示统计同意 */
  const introDone = computed(() => !welcomeOpen.value && legacyStep.value === 'done')
  /** 在“关于”页主动打开统计设置 */
  const consentRequested = ref(false)
  const consentOpen = computed(() => consentRequested.value || (consent.value === null && introDone.value))

  // ── 统计（见 src/lib/consent.ts）：本站匿名使用统计 + Cloudflare Web Analytics，只在“全部接受”后启用 ──
  const usage = shallowRef<UsageSummary | null>(null)
  void fetchUsageSummary().then((s) => (usage.value = s))
  function reportUsageNow() {
    void reportUsage(accounts.value.map((a) => a.game))
  }
  function startAnalytics() {
    loadCloudflareAnalytics()
    // 等账号列表从 IndexedDB 读出来之后再上报（每天最多一次）
    setTimeout(reportUsageNow, 3000)
  }
  function setConsent(value: Consent) {
    writeConsent(value)
    const wasAll = consent.value === 'all'
    consent.value = value
    consentRequested.value = false
    if (value === 'all' && !wasAll) startAnalytics()
  }
  if (consent.value === 'all') startAnalytics()

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
    welcomeOpen,
    closeWelcome,
    legacyStep,
    introDone,
    consent,
    consentOpen,
    consentRequested,
    setConsent,
    usage,
  }
})
