/**
 * 明日方舟：森空岛“干员资产”页的卡片（实验）。
 *
 * 每张卡片：左上职业图标，右边一排黄色星星（稀有度），立绘，精英化图标、等级圈、潜能和技能图标，最下面是名字。
 *   - 稀有度：在卡片顶部找黄色星星所在的那一行，量出这一排的长度，除以一颗星的间距（与卡片宽度成正比）；
 *     截图分辨率高时星星彼此分开，再用连通块的个数核对；
 *   - 名字的位置交给 OCR。
 * 坐标都是相对卡片宽高的比例，在 271 宽的截图上标定。
 */
import { hsv, type Rect, type RgbaImage, pixel, runs } from './image'

/** 一颗星的间距 / 卡片宽度 */
export const STAR_PITCH = 0.0817
/** 星星这一排开始的位置 / 卡片宽度 */
const ROW_START = 0.3
/** 在卡片顶部这个范围里找星星那一行 */
const BAND = { top: 0, bottom: 0.14 }

export interface AkStarRow {
  /** 星星那一行的上下沿（像素） */
  y0: number
  y1: number
  /** 这一排的左右端（像素） */
  x0: number
  x1: number
  /** 由长度算出的星数（未取整） */
  estimate: number
  /** 连通块的个数（分辨率低时星星连在一起，只作参考） */
  blobs: number
  count: number | null
}

export interface AkCard {
  rect: Rect
  stars: AkStarRow | null
  rarity: number | null
  nameRect: Rect
}

function isStarYellow(img: RgbaImage, x: number, y: number): boolean {
  const [h, s, v] = hsv(pixel(img, x, y))
  return h >= 35 && h <= 70 && s >= 0.45 && v >= 0.55
}

export function readStars(img: RgbaImage, card: Rect): AkStarRow | null {
  const x0 = Math.round(card.x + card.width * (ROW_START - 0.08))
  const x1 = Math.round(card.x + card.width)
  const top = Math.round(card.y + card.height * BAND.top)
  const bottom = Math.round(card.y + card.height * BAND.bottom)
  // 1. 黄色像素最多的那几行就是星星那一行
  const rows: number[] = []
  for (let y = top; y < bottom; y++) {
    let n = 0
    for (let x = x0; x < x1; x++) if (isStarYellow(img, x, y)) n++
    rows.push(n)
  }
  const peak = Math.max(...rows)
  if (peak < card.width * STAR_PITCH * 0.8) return null
  const band = runs(rows, (n) => n >= peak * 0.35)
    .map(([a, b]) => [a + top, b + top] as [number, number])
    .toSorted((a, b) => rows.slice(b[0] - top, b[1] - top).reduce((s, v) => s + v, 0) - rows.slice(a[0] - top, a[1] - top).reduce((s, v) => s + v, 0))[0]!
  const [y0, y1] = band
  // 2. 每一列在这一行里有没有黄色
  const cols: number[] = []
  for (let x = x0; x < x1; x++) {
    let n = 0
    for (let y = y0; y < y1; y++) if (isStarYellow(img, x, y)) n++
    cols.push(n)
  }
  // 3. 从预计的起点开始，允许星星之间有小空隙，连成一段
  const pitch = card.width * STAR_PITCH
  const maxGap = Math.max(1, Math.round(pitch * 0.45))
  const segments = runs(cols, (n) => n > 0).map(([a, b]) => [a + x0, b + x0] as [number, number])
  const expected = card.x + card.width * ROW_START
  const first = segments.findIndex(([a, b]) => b > expected - pitch * 0.6 && a < expected + pitch * 0.8)
  if (first < 0) return null
  let [sx, ex] = segments[first]!
  let blobs = 1
  for (const [a, b] of segments.slice(first + 1)) {
    if (a - ex > maxGap) break
    ex = b
    blobs++
  }
  // 一排 n 颗星的长度约为 (n - 1) 个间距 + 一颗星的宽度（约 0.9 个间距）
  const estimate = (ex - sx) / pitch + 0.1
  const count = Math.round(estimate)
  const ok = count >= 1 && count <= 6 && Math.abs(estimate - count) <= 0.45
  return { y0, y1, x0: sx, x1: ex, estimate, blobs, count: ok ? count : null }
}

export function readCard(img: RgbaImage, card: Rect): AkCard {
  const stars = readStars(img, card)
  return {
    rect: card,
    stars,
    rarity: stars?.count ?? null,
    nameRect: { x: card.x + card.width * 0.05, y: card.y + card.height * 0.9, width: card.width * 0.95, height: card.height * 0.1 },
  }
}
