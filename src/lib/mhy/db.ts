/**
 * 米哈游游戏的记录单独放在一个 IndexedDB（arkrecord-mhy），和鹰角两款的库（db.ts）分开：
 * 网页版完全不碰它，桌面版两边互不影响；以后米哈游的云同步（M5）也是单独的服务。
 */
import { Dexie, type DexieOptions, type EntityTable, type Table } from 'dexie'
import type { MhyAccount, MhyPull } from './types'

export class MhyDB extends Dexie {
  accounts!: EntityTable<MhyAccount, 'id'>
  pulls!: Table<MhyPull, [string, string]>

  constructor(name = 'arkrecord-mhy', options?: DexieOptions) {
    super(name, options)
    this.version(1).stores({
      accounts: 'id, game, uid, createdAt',
      pulls: '[accountId+id], accountId, [accountId+pool], [accountId+ts]',
    })
  }
}

export const mhyDb = new MhyDB()
