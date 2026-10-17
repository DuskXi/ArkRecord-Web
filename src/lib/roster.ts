/**
 * 账号实际拥有的干员：从森空岛 App 的干员列表截图识别出来，按“截图时的状态”保存（docs/rewrite/screenshot-recognition.md）。
 *
 * 幂等：每条记录带截图时间 observedAt。
 *   - 同一张截图再导入一次：截图时间相同、内容相同，什么都不变；
 *   - 更早的截图不会覆盖更新的；
 *   - 截图之后又抽到的、又获得赠送的，不改快照，显示时用寻访记录往上加（currentState），
 *     所以截完图再抽卡、再同步，不会重复计算，也不用重新截图。
 *
 * 只存在这台设备上，会进入导出文件和本地快照；目前不参与云同步。
 */
import { db } from './db'

export interface RosterEntry {
  accountId: string
  /** 明日方舟 charId / 终末地 chr_ ID */
  itemId: string
  name: string
  /** 截图时这名干员的份数：终末地 = 潜能 + 1；明日方舟暂时读不出潜能，为 null（只知道拥有） */
  copies: number | null
  /** 截图时的潜能（终末地 0–5） */
  potential: number | null
  /** 截图时间（毫秒） */
  observedAt: number
  /** 导入时间（毫秒） */
  importedAt: number
  /** screenshot：识别结果（含用户核对、修改过的）；manual：手动添加 */
  source: 'screenshot' | 'manual'
}

export type RosterInput = Omit<RosterEntry, 'accountId' | 'importedAt'>

export interface RosterMergeSummary {
  added: number
  updated: number
  /** 和已保存的一样（同一张截图重复导入） */
  unchanged: number
  /** 已经有更新的截图，这张更早的没有覆盖 */
  older: number
}

/** 终末地潜能 → 份数（潜能 5 = 一共获得 6 次） */
export function copiesFromPotential(potential: number): number {
  return potential + 1
}

/** 终末地份数 → 潜能（满潜能 5，多余的信物不再提升潜能） */
export function potentialFromCopies(copies: number): number {
  return Math.max(0, Math.min(5, copies - 1))
}

type Decision = 'add' | 'update' | 'unchanged' | 'older'

/** 一条识别结果和已保存的记录相比该怎么处理（纯函数，便于测试） */
export function decide(existing: RosterEntry | undefined, incoming: RosterInput): Decision {
  if (!existing) return 'add'
  if (incoming.observedAt < existing.observedAt) return 'older'
  if (incoming.observedAt === existing.observedAt && incoming.copies === existing.copies && incoming.potential === existing.potential && incoming.name === existing.name) {
    return 'unchanged'
  }
  return 'update'
}

/** 保存识别结果；同一名干员只保留截图时间最新的一条 */
export async function mergeRoster(accountId: string, items: readonly RosterInput[]): Promise<RosterMergeSummary> {
  const summary: RosterMergeSummary = { added: 0, updated: 0, unchanged: 0, older: 0 }
  // 同一批里同一名干员出现多次（两张截图有重叠）：取截图时间最新的
  const latest = new Map<string, RosterInput>()
  for (const item of items) {
    const prev = latest.get(item.itemId)
    if (!prev || item.observedAt >= prev.observedAt) latest.set(item.itemId, item)
  }
  const importedAt = Date.now()
  await db.transaction('rw', db.roster, async () => {
    const keys = [...latest.keys()].map((itemId) => [accountId, itemId] as [string, string])
    const existing = await db.roster.bulkGet(keys)
    const writes: RosterEntry[] = []
    ;[...latest.values()].forEach((item, i) => {
      const decision = decide(existing[i], item)
      if (decision === 'add') summary.added++
      else if (decision === 'update') summary.updated++
      else if (decision === 'unchanged') summary.unchanged++
      else summary.older++
      if (decision === 'add' || decision === 'update') writes.push({ ...item, accountId, importedAt })
    })
    if (writes.length) await db.roster.bulkPut(writes)
  })
  return summary
}

export async function removeRosterEntry(accountId: string, itemId: string): Promise<void> {
  await db.roster.delete([accountId, itemId])
}

export async function clearRoster(accountId: string): Promise<number> {
  return db.roster.where('accountId').equals(accountId).delete()
}

// ───────────────────────── 当前状态 ─────────────────────────

/** 寻访记录里的一次获得（抽到或赠送）；只需要这几个字段 */
export interface Acquisition {
  itemId: string | null
  name: string
  ts: number
}

export interface OwnedState {
  snapshot: RosterEntry
  /** 截图之后抽到的次数 */
  pulledAfter: number
  /** 截图之后赠送的份数（信物赠礼等） */
  giftedAfter: number
  /** 当前份数 = 截图时 + 之后获得的；份数未知（明日方舟）时为 null */
  copies: number | null
  /** 终末地当前潜能（最多 5）；未知时为 null */
  potential: number | null
  /**
   * 截图之前的寻访记录比截图上的份数还多：可能是识别错了（潜能 / 名字），或者截图时间不对。
   * 界面上提示用户检查。
   */
  conflict: boolean
}

function matches(a: Acquisition, entry: RosterEntry): boolean {
  return a.itemId ? a.itemId === entry.itemId : a.name === entry.name
}

/**
 * 截图 + 截图之后的寻访记录 → 现在的状态。
 * pulls：抽到的（不含赠送）；gifts：赠送的、给了这名干员一份的（信物赠礼）。
 */
export function currentState(entry: RosterEntry, pulls: readonly Acquisition[], gifts: readonly Acquisition[], potentialGame: boolean): OwnedState {
  let pulledAfter = 0
  let giftedAfter = 0
  let before = 0
  for (const p of pulls) {
    if (!matches(p, entry)) continue
    if (p.ts > entry.observedAt) pulledAfter++
    else before++
  }
  for (const g of gifts) {
    if (!matches(g, entry)) continue
    if (g.ts > entry.observedAt) giftedAfter++
    else before++
  }
  const copies = entry.copies === null ? null : entry.copies + pulledAfter + giftedAfter
  return {
    snapshot: entry,
    pulledAfter,
    giftedAfter,
    copies,
    potential: potentialGame && copies !== null ? potentialFromCopies(copies) : null,
    conflict: entry.copies !== null && before > entry.copies,
  }
}

// ───────────────────────── 截图时间 ─────────────────────────

const FILENAME_PATTERNS: RegExp[] = [
  // Screenshot_2026-10-17-06-05-25-51.jpg（安卓 / MIUI / ColorOS）、Screenshot_20261017-060525.png
  /(?<y>20\d{2})-?(?<mo>\d{2})-?(?<d>\d{2})[-_ ]?(?<h>\d{2})[-_.:]?(?<mi>\d{2})[-_.:]?(?<s>\d{2})/,
  // 截屏2026-10-17 06.05.25 / Screen Shot 2026-10-17 at 6.05.25
  /(?<y>20\d{2})-(?<mo>\d{1,2})-(?<d>\d{1,2})\D{1,4}(?<h>\d{1,2})[.:](?<mi>\d{2})[.:](?<s>\d{2})/,
]

/**
 * 从文件名读出截图时间（手机本地时间）；读不出时返回 null。
 * 常见格式：Screenshot_2026-10-17-06-05-25-51.jpg、IMG_20261017_060525.jpg、截屏2026-10-17 06.05.25.png、
 * 微信图片_20261017060525.jpg。
 */
export function timeFromFilename(name: string): number | null {
  for (const re of FILENAME_PATTERNS) {
    const m = re.exec(name)
    const g = m?.groups
    if (!g) continue
    const [y, mo, d, hour, mi, s] = [g.y, g.mo, g.d, g.h, g.mi, g.s].map(Number) as [number, number, number, number, number, number]
    // macOS 英文系统：Screen Shot 2026-10-17 at 6.05.25 PM
    const meridiem = /^\s*(AM|PM|上午|下午)/i.exec(name.slice((m?.index ?? 0) + (m?.[0].length ?? 0)))?.[1]?.toUpperCase()
    const h = meridiem === 'PM' || meridiem === '下午' ? (hour % 12) + 12 : meridiem ? hour % 12 : hour
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) continue
    const date = new Date(y, mo - 1, d, h, mi, s)
    if (date.getMonth() !== mo - 1) continue
    return date.getTime()
  }
  return null
}

/** JPEG 的 EXIF 拍摄时间（DateTimeOriginal / DateTime）；没有时返回 null。截图一般没有 EXIF，作为备用。 */
export function timeFromExif(bytes: Uint8Array): number | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  // 只找前 64 KB 里的 "YYYY:MM:DD HH:MM:SS"
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)))
  if (!head.includes('Exif')) return null
  const m = /(20\d{2}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(head)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const date = new Date(y, mo - 1, d, h, mi, s)
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

export interface ScreenshotTime {
  ts: number
  /** filename：文件名；exif：图片信息；file：文件的修改时间（可能是传输时间，不一定准） */
  source: 'filename' | 'exif' | 'file'
}

/** 截图时间：文件名 → EXIF → 文件修改时间。界面上可以修改 */
export async function screenshotTime(file: File): Promise<ScreenshotTime> {
  const fromName = timeFromFilename(file.name)
  if (fromName !== null) return { ts: fromName, source: 'filename' }
  try {
    const fromExif = timeFromExif(new Uint8Array(await file.slice(0, 65536).arrayBuffer()))
    if (fromExif !== null) return { ts: fromExif, source: 'exif' }
  } catch {
    // 读不了就用文件时间
  }
  return { ts: file.lastModified || Date.now(), source: 'file' }
}
