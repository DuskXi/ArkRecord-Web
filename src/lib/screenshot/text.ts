/**
 * 交给 OCR 之前整理名字区域：二值化（Otsu 自动门槛）、去掉贯穿整行的线条（卡片边框、分隔线）、
 * 裁到文字的范围并留白，输出白底黑字。卡片上的装饰（明日方舟名字左边的斜条）会被门槛或裁剪去掉。
 */
import type { Rect, RgbaImage } from './image'

function luminanceAt(img: RgbaImage, x: number, y: number): number {
  const i = (y * img.width + x) * 4
  return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!
}

/** Otsu：使两类方差之和最小的门槛 */
export function otsu(values: ArrayLike<number>): number {
  const hist = Array.from({ length: 256 }, () => 0)
  for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, Math.round(values[i]!)))]!++
  const total = values.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]!
  let sumB = 0
  let wB = 0
  let best = 0
  let bestVar = -1
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]!
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > bestVar) {
      bestVar = between
      best = t
    }
  }
  return best
}

export interface TextCrop {
  image: RgbaImage
  /** 文字在原图里的范围；没有找到文字时为 null */
  box: Rect | null
}

/**
 * @param lightText 浅色字（明日方舟的深色卡片）还是深色字（终末地的白色名字栏）
 * @param pad 四周留白（像素）
 */
export function prepareText(img: RgbaImage, rect: Rect, lightText: boolean, pad = 12): TextCrop {
  const x0 = Math.max(0, Math.round(rect.x))
  const y0 = Math.max(0, Math.round(rect.y))
  const w = Math.max(1, Math.min(img.width - x0, Math.round(rect.width)))
  const h = Math.max(1, Math.min(img.height - y0, Math.round(rect.height)))
  const lum = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum[y * w + x] = luminanceAt(img, x0 + x, y0 + y)
  const t = otsu(lum)
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < ink.length; i++) ink[i] = (lightText ? lum[i]! > t : lum[i]! < t) ? 1 : 0
  // 贯穿整行、整列的线条不是文字
  for (let y = 0; y < h; y++) {
    let n = 0
    for (let x = 0; x < w; x++) n += ink[y * w + x]!
    if (n > w * 0.6) for (let x = 0; x < w; x++) ink[y * w + x] = 0
  }
  for (let x = 0; x < w; x++) {
    let n = 0
    for (let y = 0; y < h; y++) n += ink[y * w + x]!
    if (n > h * 0.85) for (let y = 0; y < h; y++) ink[y * w + x] = 0
  }
  // 文字的范围：去掉零星的噪点（少于 2 个像素的行、列）
  const rows: number[] = []
  const cols: number[] = []
  for (let y = 0; y < h; y++) {
    let n = 0
    for (let x = 0; x < w; x++) n += ink[y * w + x]!
    if (n >= 2) rows.push(y)
  }
  for (let x = 0; x < w; x++) {
    let n = 0
    for (let y = 0; y < h; y++) n += ink[y * w + x]!
    if (n >= 2) cols.push(x)
  }
  if (!rows.length || !cols.length) return { image: { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) }, box: null }
  const bx0 = cols[0]!
  const bx1 = cols.at(-1)! + 1
  const by0 = rows[0]!
  const by1 = rows.at(-1)! + 1
  const ow = bx1 - bx0 + pad * 2
  const oh = by1 - by0 + pad * 2
  const out = new Uint8ClampedArray(ow * oh * 4).fill(255)
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      if (!ink[y * w + x]) continue
      const o = ((y - by0 + pad) * ow + (x - bx0 + pad)) * 4
      out[o] = out[o + 1] = out[o + 2] = 0
    }
  }
  return { image: { width: ow, height: oh, data: out }, box: { x: x0 + bx0, y: y0 + by0, width: bx1 - bx0, height: by1 - by0 } }
}
