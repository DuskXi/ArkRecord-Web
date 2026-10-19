/**
 * 米哈游游戏的账号（UID）和当前选中的那个：侧边栏（MhySidebar）和页面（MhyGamePage）共用。
 * 选中的记在 localStorage（每个游戏一项）；没选过、或者选的已经不在了，就用最近同步的那个。
 */
import { computed, reactive } from 'vue'
import { useLiveQuery } from '@/composables/useLiveQuery'
import { mhyDb } from '@/lib/mhy/db'
import type { MhyAccount, MhyGame } from '@/lib/mhy/types'

const selected = reactive<Partial<Record<MhyGame, string | null>>>({})
const storageKey = (game: MhyGame) => `arkrecord:mhy:${game}:account`

function selectedId(game: MhyGame): string | null {
  if (!(game in selected)) {
    try {
      selected[game] = localStorage.getItem(storageKey(game))
    } catch {
      selected[game] = null
    }
  }
  return selected[game] ?? null
}

export function selectMhyAccount(game: MhyGame, id: string): void {
  selected[game] = id
  try {
    localStorage.setItem(storageKey(game), id)
  } catch {
    // 记不住也不影响这次使用
  }
}

export function useMhyAccounts(game: () => MhyGame) {
  const accounts = useLiveQuery(() => mhyDb.accounts.where('game').equals(game()).toArray(), [game], [] as MhyAccount[])
  const account = computed<MhyAccount | undefined>(() => {
    const id = selectedId(game())
    return accounts.value.find((a) => a.id === id) ?? accounts.value.toSorted((a, b) => (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0))[0]
  })
  return { accounts, account, select: (id: string) => selectMhyAccount(game(), id) }
}
