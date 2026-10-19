/**
 * 抽卡记录里的时间是区服的当地时间（没有时区），按区服的 UTC 偏移换算成时间戳。
 *
 * 偏移按 UIGF 的约定（固定偏移，不算夏令时）：美服 -5，欧服 +1，其余（国服、B 服、亚服、港澳台服）+8。
 * 星铁的接口会返回 region_time_zone，有的话以接口为准；原神的接口不返回（2026-10-19 实测）。
 */
const OFFSETS: Record<string, number> = {
  // 原神
  cn_gf01: 8,
  cn_qd01: 8,
  os_usa: -5,
  os_euro: 1,
  os_asia: 8,
  os_cht: 8,
  // 星铁
  prod_gf_cn: 8,
  prod_qd_cn: 8,
  prod_official_usa: -5,
  prod_official_eur: 1,
  prod_official_asia: 8,
  prod_official_cht: 8,
}

/** 区服的 UTC 偏移（小时）。不认识的区服按 +8（国服），并由调用方提示 */
export function regionOffset(region: string | null | undefined): number | undefined {
  return region ? OFFSETS[region] : undefined
}

/** 接口给的 region_time_zone（可能是数字或数字字符串），不合理时返回 undefined */
export function parseTimeZone(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d{1,2}$/.test(value.trim()) ? Number(value) : NaN
  return Number.isInteger(n) && n >= -12 && n <= 14 ? n : undefined
}

/** 区服的 UTC 偏移；不认识的区服按 +8（国服） */
export function offsetFor(region: string | null | undefined): number {
  return regionOffset(region) ?? 8
}

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** “YYYY-MM-DD HH:MM:SS”（区服当地时间）→ 毫秒时间戳；格式不对返回 NaN */
export function toTimestamp(time: string, offsetHours: number): number {
  const m = TIME_RE.exec(time)
  if (!m) return NaN
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number]
  const utc = Date.UTC(y, mo - 1, d, h, mi, s)
  // 日期本身不合法（例如 2 月 30 日）时 Date.UTC 会进位，换回来对不上就算格式不对
  const back = new Date(utc)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return NaN
  return utc - offsetHours * 3600_000
}
