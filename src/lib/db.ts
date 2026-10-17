import { Dexie, type EntityTable, type Table } from 'dexie'
import type { CloudState } from './cloud/state'
import type { Account, AkLedgerEntry, AkPull, EfPoolInfo, EfPull, Snapshot } from './types'

/** 所有数据只存在用户浏览器的 IndexedDB 里 */
export class ArkRecordDB extends Dexie {
  accounts!: EntityTable<Account, 'id'>
  akPulls!: Table<AkPull, [string, string]>
  efPulls!: Table<EfPull, [string, string]>
  akLedger!: Table<AkLedgerEntry, [string, string, string]>
  efPools!: EntityTable<EfPoolInfo, 'poolId'>
  snapshots!: EntityTable<Snapshot, 'id'>
  kv!: Table<{ key: string; value: unknown }, string>
  cloud!: EntityTable<CloudState, 'accountId'>

  constructor(name = 'arkrecord') {
    super(name)
    this.version(1).stores({
      accounts: 'id, game, uid, createdAt',
      akPulls: '[accountId+key], accountId, [accountId+gachaTs], [accountId+tsSec], [accountId+poolId]',
      efPulls: '[accountId+key], accountId, [accountId+gachaTs], [accountId+poolId]',
      akLedger: '[accountId+kind+key], accountId',
      efPools: 'poolId',
      snapshots: '++id, createdAt',
      kv: 'key',
    })
    // 云同步：每个开通了云同步的账号在这台设备上的状态与钥匙（见 src/lib/cloud/state.ts）
    this.version(2).stores({ cloud: 'accountId' })
  }
}

export const db = new ArkRecordDB()

/** 请求浏览器把本站数据标记为持久化，避免空间紧张时被自动清理 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}
