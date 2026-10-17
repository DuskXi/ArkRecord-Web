/**
 * 终末地：森空岛“干员”页的卡片（实验）。
 *
 * 每张卡片：立绘、左下角的五角星、Lv、白色名字栏，最下面一条颜色条。
 *   - 稀有度：颜色条的色相（橙 6★、金 5★、紫 4★）；
 *   - 潜能（推测，待确认）：五角星由 5 笔组成，白色是已解锁的潜能，黄色是下一级，按固定顺序解锁；
 *     5 笔全白就是满潜能。白色笔画在浅色背景上看不清，但黄色那一笔很好认，
 *     所以直接用黄色那一笔在解锁顺序里的位置得到潜能等级，白色笔画只用来核对；
 *   - 名字栏的位置交给 OCR。
 * 坐标都是相对卡片宽高的比例，在 594 宽的截图上标定。
 */
import { hsv, type Rect, type RgbaImage, sample } from './image'
import { type PentagramGeometry, type PentagramReading, fitPentagram, readStrokes } from './pentagram'

/** 名字栏上沿在卡片里的相对高度 */
const LABEL_TOP = 0.83
/** 五角星（相对名字栏上沿）：中心、半径、旋转 */
const STAR = { dx: 0.135, dy: -0.0798, r: 0.0672, theta: (-31 * Math.PI) / 180 }
/** 笔画的解锁顺序（笔画编号见 pentagram.ts） */
export const POTENTIAL_ORDER = [0, 4, 3, 2, 1]

export interface EfCard {
  rect: Rect
  rarity: 4 | 5 | 6 | null
  /** 潜能 0–5；看不出来时为 null */
  potential: number | null
  star: PentagramReading
  /** 名字所在的区域，交给 OCR */
  nameRect: Rect
}

/** 用名字栏的上沿（立绘 → 白色的分界）校准卡片的竖直位置，误差在 1 像素以内 */
export function anchorCard(img: RgbaImage, card: Rect): Rect {
  const x0 = card.x + card.width * 0.25
  const x1 = card.x + card.width * 0.75
  const isWhiteRow = (y: number) => {
    let n = 0
    let total = 0
    for (let x = x0; x < x1; x += 1) {
      const [, s, v] = hsv(sample(img, x, y))
      total++
      if (s < 0.08 && v > 0.9) n++
    }
    return n / total > 0.9
  }
  const expected = card.y + card.height * LABEL_TOP
  const slack = Math.round(card.height * 0.05)
  for (let y = Math.round(expected - slack); y <= expected + slack; y++) {
    if (isWhiteRow(y) && isWhiteRow(y + 1) && isWhiteRow(y + 2)) {
      return { ...card, y: card.y + (y - expected) }
    }
  }
  return card
}

export function rarityOf(img: RgbaImage, card: Rect): 4 | 5 | 6 | null {
  // 颜色条在卡片最下面几行：找饱和度最高的一行
  let best: [number, number, number] | null = null
  for (let y = card.y + card.height * 0.94; y < Math.min(img.height, card.y + card.height * 1.02); y++) {
    let h = 0
    let s = 0
    let v = 0
    let n = 0
    for (let x = card.x + card.width * 0.1; x < card.x + card.width * 0.9; x += 2) {
      const c = hsv(sample(img, x, y))
      // 色相是角度，紫色在 260 附近，不会跨过 0，这里直接平均
      h += c[0]
      s += c[1]
      v += c[2]
      n++
    }
    if (n && (!best || s / n > best[1])) best = [h / n, s / n, v / n]
  }
  if (!best || best[1] < 0.3) return null
  const [h] = best
  if (h >= 15 && h < 38) return 6
  if (h >= 38 && h < 70) return 5
  if (h >= 240 && h < 300) return 4
  return null
}

export function starGeometry(card: Rect): PentagramGeometry {
  const labelTop = card.y + card.height * LABEL_TOP
  return {
    cx: card.x + card.width * STAR.dx,
    cy: labelTop + card.height * STAR.dy,
    r: card.width * STAR.r,
    theta: STAR.theta,
  }
}

/** 由五角星推出潜能：黄色那一笔在解锁顺序里的位置；没有黄色、而且大多数笔画是白色时为满潜能 5 */
export function potentialOf(reading: PentagramReading): number | null {
  const yellow = reading.detail.map((d, k) => ({ k, y: d.yellow })).filter((d) => d.y >= 0.5)
  if (yellow.length === 1) return POTENTIAL_ORDER.indexOf(yellow[0]!.k)
  if (yellow.length === 0 && reading.strokes.filter((s) => s === 'white').length >= 4) return 5
  return null
}

export function readCard(img: RgbaImage, rect: Rect): EfCard {
  const card = anchorCard(img, rect)
  // 只在 1 像素内微调：笔画少、背景亮时大范围搜索会跑偏
  const geometry = fitPentagram(img, starGeometry(card), { shift: 1, scale: 0.04, rotate: Math.PI / 90, step: 0.5 })
  const star = readStrokes(img, geometry)
  const labelTop = card.y + card.height * LABEL_TOP
  return {
    rect: card,
    rarity: rarityOf(img, card),
    potential: potentialOf(star),
    star,
    nameRect: { x: card.x + card.width * 0.04, y: labelTop + card.height * 0.01, width: card.width * 0.7, height: card.height * 0.13 },
  }
}
