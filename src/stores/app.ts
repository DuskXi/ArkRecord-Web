import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { db } from '@/lib/db'
import { type AkMeta, loadAkMeta } from '@/lib/meta'
import type { Account, Game } from '@/lib/types'

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

  const loginOpen = ref(false)

  return { game, accounts, gameAccounts, activeAccount, selectAccount, meta, loginOpen }
})
