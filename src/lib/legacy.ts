/**
 * 旧版 ArkRecord（2022–2023，Quasar 版）数据迁移。
 *
 * 支持三种来源：
 *   1. 同一域名下旧版留在 localStorage 里的 UserDataSet（新版首次打开时自动迁移）
 *   2. 旧版导出的 JSON：{ version, dataBody: [{ pool, stone, recharge, userInfo }] }
 *   3. 更早的导出 JSON：{ poolsData, poolsDataB, officialStones, ... }（没有 uid，需要用户指定账号）
 *
 * 旧版每条记录是一次寻访（十连合并为一条），字段为 { timestamp(秒), pool(卡池名), result: [{ name, rarity(从 0 开始), isNew }] }。
 */
import { toLedgerEntries } from './ledger'
import type { AkMeta } from './meta'
import { buildNameIndex, resolvePoolId } from './meta'
import type { AkLedgerEntry, AkPull } from './types'

export interface LegacyPoolEntry {
  timestamp: number
  pool: string
  result: { name: string; rarity: number; isNew: boolean }[]
}

export interface LegacyAccount {
  uid: string
  nickName: string
  channel: 'official' | 'bilibili' | 'unknown'
  /** 旧版官服保存的 token 就是鹰角通行证账号 token，可用于新的登录流程；B 服的 token 不是 */
  accountToken?: string
  pools: LegacyPoolEntry[]
  stone: unknown[]
  recharge: unknown[]
}

interface LegacyUserInfo {
  type?: string
  token?: string
  info?: { uid?: string | number; nickName?: string }
}

interface LegacyUserData {
  userInfo?: LegacyUserInfo
  poolData?: LegacyPoolEntry[]
  stoneData?: unknown[]
  rechargeData?: unknown[]
}

function fromUserData(data: LegacyUserData): LegacyAccount | null {
  const uid = data.userInfo?.info?.uid
  if (uid === undefined || uid === null) return null
  const channel = data.userInfo?.type === 'official' ? 'official' : data.userInfo?.type === 'bilibili' ? 'bilibili' : 'unknown'
  return {
    uid: String(uid),
    nickName: data.userInfo?.info?.nickName ?? String(uid),
    channel,
    accountToken: channel === 'official' ? data.userInfo?.token : undefined,
    pools: Array.isArray(data.poolData) ? data.poolData : [],
    stone: Array.isArray(data.stoneData) ? data.stoneData : [],
    recharge: Array.isArray(data.rechargeData) ? data.rechargeData : [],
  }
}

/** 读取旧版留在 localStorage 中的数据（旧版用 JSON.stringify 存储每个键） */
export function readLegacyLocalStorage(storage: Pick<Storage, 'getItem'>): LegacyAccount[] {
  try {
    const raw = storage.getItem('UserDataSet')
    if (!raw) return []
    const dataSet = JSON.parse(raw) as Record<string, LegacyUserData>
    return Object.values(dataSet ?? {})
      .map(fromUserData)
      .filter((a): a is LegacyAccount => a !== null)
  } catch {
    return []
  }
}

export interface LegacyExport {
  accounts: LegacyAccount[]
  /** 最早期格式没有 uid 的数据，按渠道分开 */
  anonymous: { official?: Omit<LegacyAccount, 'uid' | 'nickName' | 'channel'>; bilibili?: Omit<LegacyAccount, 'uid' | 'nickName' | 'channel'> }
}

export function isLegacyExport(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false
  return 'dataBody' in json || 'poolsData' in json || 'poolsDataB' in json
}

export function parseLegacyExport(json: Record<string, unknown>): LegacyExport {
  const result: LegacyExport = { accounts: [], anonymous: {} }
  if (Array.isArray(json.dataBody)) {
    for (const body of json.dataBody as { pool?: LegacyPoolEntry[]; stone?: unknown[]; recharge?: unknown[]; userInfo?: LegacyUserInfo }[]) {
      const account = fromUserData({ userInfo: body.userInfo, poolData: body.pool, stoneData: body.stone, rechargeData: body.recharge })
      if (account) result.accounts.push(account)
    }
    return result
  }
  const list = (key: string) => (Array.isArray(json[key]) ? (json[key] as unknown[]) : [])
  const official = { pools: list('poolsData') as LegacyPoolEntry[], stone: list('officialStones'), recharge: list('officialRecharge') }
  const bilibili = { pools: list('poolsDataB') as LegacyPoolEntry[], stone: list('bilibiliStones'), recharge: list('bilibiliRecharge') }
  if (official.pools.length || official.stone.length || official.recharge.length) result.anonymous.official = official
  if (bilibili.pools.length || bilibili.stone.length || bilibili.recharge.length) result.anonymous.bilibili = bilibili
  return result
}

/** 旧版寻访记录 → 新版单抽记录 */
export function legacyToAkPulls(accountId: string, pools: LegacyPoolEntry[], meta: AkMeta): AkPull[] {
  const names = buildNameIndex(meta)
  const out: AkPull[] = []
  for (const entry of pools) {
    if (!entry || typeof entry.timestamp !== 'number' || !Array.isArray(entry.result)) continue
    const tsSec = entry.timestamp
    const poolId = resolvePoolId(meta, entry.pool, tsSec)
    entry.result.forEach((r, i) => {
      if (!r || typeof r.name !== 'string' || typeof r.rarity !== 'number') return
      out.push({
        accountId,
        key: `legacy:${tsSec}:${i}`,
        poolId,
        poolName: entry.pool,
        charId: names.get(r.name) ?? null,
        charName: r.name,
        rarity: r.rarity,
        isNew: Boolean(r.isNew),
        gachaTs: tsSec * 1000,
        tsSec,
        pos: i,
        source: 'legacy',
      })
    })
  }
  return out
}

/** 旧版源石 / 充值记录原样保留（解析与去重规则见 ledger.ts） */
export function legacyLedger(accountId: string, stone: unknown[], recharge: unknown[]): AkLedgerEntry[] {
  return [...toLedgerEntries(accountId, 'stone', stone), ...toLedgerEntries(accountId, 'recharge', recharge)]
}
