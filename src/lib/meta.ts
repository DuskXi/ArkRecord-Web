/**
 * 明日方舟元数据：构建时由 scripts/sync-gamedata.mjs 生成，与页面同源提供。
 * 包含 charId → 名称 / 星级，poolId → 规则类型 / 开放时间 / UP 名单，以及本站已镜像的头像列表。
 */

export interface AkCharMeta {
  /** 名称 */
  n: string
  /** 星级 1–6 */
  r: number
  /** 职业 */
  p: string
}

export interface AkPoolMeta {
  n: string
  /** gachaRuleType：NORMAL / SINGLE / DOUBLE / LIMITED / LINKAGE / CLASSIC / … / BOOT */
  t: string
  /** 开放、结束时间（秒） */
  o: number
  e: number
  /** 联动池：每 N 抽循环必得 */
  loop6?: number
  /** 联动池：N 抽内必得（旧规则） */
  g6?: number
  g6c?: string
  /** 限定池：累计 N 抽赠送限定干员 */
  free?: number
  lim?: string
  attain6?: string[]
  /** UP 名单：{ "6": [charId], "5": [charId] } */
  up?: Record<string, string[]>
}

export interface AkMeta {
  version: string
  generatedAt: string
  upAvailable: boolean
  chars: Record<string, AkCharMeta>
  pools: Record<string, AkPoolMeta>
  avatars: string[]
}

const EMPTY_META: AkMeta = { version: '', generatedAt: '', upAvailable: false, chars: {}, pools: {}, avatars: [] }

let metaPromise: Promise<AkMeta> | null = null
let avatarSet: Set<string> = new Set()

export function loadAkMeta(): Promise<AkMeta> {
  metaPromise ??= fetch('/gamedata/ak-meta.json')
    .then((r) => (r.ok ? (r.json() as Promise<AkMeta>) : EMPTY_META))
    .catch(() => EMPTY_META)
    .then((meta) => {
      avatarSet = new Set(meta.avatars)
      return meta
    })
  return metaPromise
}

/** 头像：优先用本站镜像（同源，分享图导出不受跨域影响），否则浏览器直连 PRTS 的 torappu */
export function akAvatarUrl(charId: string | null | undefined): string | undefined {
  if (!charId) return undefined
  if (avatarSet.has(charId)) return `/gamedata/avatars/${charId}.webp`
  return `https://torappu.prts.wiki/assets/char_avatar/${charId}.png`
}

/** 按名称反查 charId（旧版数据没有 charId）。重名时取干员表中先出现的一个，通常是较早实装的那位。 */
export function buildNameIndex(meta: AkMeta): Map<string, string> {
  const index = new Map<string, string>()
  for (const [id, c] of Object.entries(meta.chars)) {
    if (!index.has(c.n)) index.set(c.n, id)
  }
  return index
}

/** 按卡池名 + 时间匹配 poolId（旧版数据只有卡池名） */
export function resolvePoolId(meta: AkMeta, poolName: string, tsSec: number): string | null {
  let best: string | null = null
  for (const [id, p] of Object.entries(meta.pools)) {
    if (p.n === poolName && tsSec >= p.o && tsSec <= p.e) {
      best = id
      break
    }
  }
  return best
}

// ───────────────────────── 终末地 ─────────────────────────

export interface EfPoolMeta {
  n: string
  /** special / rerun / standard / beginner / joint / weapon / weapon_rerun */
  t: string
  /** UP 6★ 的角色或武器 ID */
  up: string[]
}

export interface EfMeta {
  generatedAt: string
  pools: Record<string, EfPoolMeta>
  /** 角色与武器：ID → 名称、星级 */
  items: Record<string, { n: string; r: number }>
}

export const EMPTY_EF_META: EfMeta = { generatedAt: '', pools: {}, items: {} }

let efMetaPromise: Promise<EfMeta> | null = null

/** 终末地元数据：构建时由 scripts/sync-gamedata.mjs 从游戏数据表生成（卡池类型、UP 名单、名称） */
export function loadEfMeta(): Promise<EfMeta> {
  efMetaPromise ??= fetch('/gamedata/ef-meta.json')
    .then((r) => (r.ok ? (r.json() as Promise<EfMeta>) : EMPTY_EF_META))
    .catch(() => EMPTY_EF_META)
  return efMetaPromise
}
