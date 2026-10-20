/**
 * 桌面版的四款游戏（总览用）：怎么打开、本机有多少账号和记录。只在桌面版里（vite.config.ts 的 DESKTOP_ONLY）。
 * 鹰角两款的数据在 arkrecord 库（src/lib/db.ts），米哈游两款在 arkrecord-mhy 库（src/lib/mhy/db.ts）。
 */
import { db } from '@/lib/db'
import { DEMO_ACCOUNT_ID } from '@/lib/demo-account'
import { mhyDb } from '@/lib/mhy/db'
import type { MhyGame } from '@/lib/mhy/types'
import type { Game } from '@/lib/types'

export type AnyGame = Game | MhyGame

export interface DesktopGame {
  id: AnyGame
  label: string
  vendor: '鹰角' | '米哈游'
  /** 打开这款游戏的页面 */
  to: string
}

export const DESKTOP_GAMES: readonly DesktopGame[] = [
  { id: 'arknights', label: '明日方舟', vendor: '鹰角', to: '/' },
  { id: 'endfield', label: '终末地', vendor: '鹰角', to: '/' },
  { id: 'genshin', label: '原神', vendor: '米哈游', to: '/genshin' },
  { id: 'starrail', label: '崩坏：星穹铁道', vendor: '米哈游', to: '/starrail' },
]

export interface LocalCounts {
  accounts: number
  pulls: number
  lastSyncAt?: number
}

/** 本机每款游戏有几个账号、多少条记录、最近一次同步 / 读取的时间（不含演示数据） */
export async function localCounts(): Promise<Record<AnyGame, LocalCounts>> {
  const out = {} as Record<AnyGame, LocalCounts>
  const hgAccounts = (await db.accounts.toArray()).filter((a) => a.id !== DEMO_ACCOUNT_ID)
  for (const game of ['arknights', 'endfield'] as const) {
    const accounts = hgAccounts.filter((a) => a.game === game)
    const table = game === 'arknights' ? db.akPulls : db.efPulls
    let pulls = 0
    for (const a of accounts) pulls += await table.where('accountId').equals(a.id).count()
    out[game] = { accounts: accounts.length, pulls, lastSyncAt: latest(accounts.map((a) => a.lastSyncAt)) }
  }
  for (const game of ['genshin', 'starrail'] as const) {
    const accounts = await mhyDb.accounts.where('game').equals(game).toArray()
    let pulls = 0
    for (const a of accounts) pulls += await mhyDb.pulls.where('accountId').equals(a.id).count()
    out[game] = { accounts: accounts.length, pulls, lastSyncAt: latest(accounts.map((a) => a.lastSyncAt)) }
  }
  return out
}

function latest(values: (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => typeof v === 'number')
  return known.length ? Math.max(...known) : undefined
}
