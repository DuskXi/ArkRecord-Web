/**
 * 仅供测试：用 node:sqlite 模拟云同步的 Durable Object 命名空间（每个 locator 一个独立的内存数据库）。
 */
import { DatabaseSync } from 'node:sqlite'
import { CloudVault, type VaultSql } from '../cloud-vault'

export function memoryVaultSql(): { sql: VaultSql; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  const sql: VaultSql = {
    exec(query, ...bindings) {
      const params = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b))
      const statement = db.prepare(query)
      if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...params) }
      statement.run(...params)
      return { toArray: () => [] }
    },
  }
  return { sql, db }
}

export function memoryStorage() {
  const { sql, db } = memoryVaultSql()
  return {
    db,
    sql,
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    async deleteAll() {
      db.exec('DROP TABLE IF EXISTS meta')
      db.exec('DROP TABLE IF EXISTS batches')
    },
  }
}

export interface FakeCloud {
  namespace: DurableObjectNamespace
  storages: Map<string, ReturnType<typeof memoryStorage>>
  requests: { url: string; headers: Headers; body: Uint8Array }[]
}

export function fakeCloud(pepper: string): FakeCloud {
  const objects = new Map<string, CloudVault>()
  const storages = new Map<string, ReturnType<typeof memoryStorage>>()
  const requests: FakeCloud['requests'] = []
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let vault = objects.get(id)
      if (!vault) {
        const storage = memoryStorage()
        storages.set(id, storage)
        vault = new CloudVault({ storage } as never, { SYNC_PEPPER: pepper })
        objects.set(id, vault)
      }
      const target = vault
      return {
        fetch: async (url: string, init: RequestInit) => {
          const request = new Request(url, init)
          requests.push({ url, headers: request.headers, body: new Uint8Array(await request.clone().arrayBuffer()) })
          return target.fetch(request)
        },
      }
    },
  }
  return { namespace: namespace as unknown as DurableObjectNamespace, storages, requests }
}
