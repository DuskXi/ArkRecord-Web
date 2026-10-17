/**
 * 一张截图的识别流程里不需要浏览器 API 的部分（在 Web Worker 里运行，Node 里也能测试）：
 *   找卡片 → 读潜能（终末地） → 裁出名字（白底黑字） → 放大给 OCR
 * OCR（Tesseract）和把候选名字画出来（canvas）在主线程做，见 recognize.ts。
 */
import * as ak from './arknights'
import * as ef from './endfield'
import { detectGrid } from './grid'
import { type Rect, type RgbaImage, sample } from './image'
import { prepareText, type TextCrop } from './text'

export type ScreenshotGame = 'arknights' | 'endfield'

export interface AnalyzedCard {
  rect: Rect
  /** 终末地潜能 0–5；明日方舟、看不出来时为 null */
  potential: number | null
  potentialConfidence: 'high' | 'low' | null
  /** 名字：白底黑字、裁到文字范围（比字形用） */
  crop: RgbaImage
  /** 交给 OCR 的版本：字高约 48 像素、四周留白；没找到文字时为 null */
  ocrInput: RgbaImage | null
}

export interface AnalyzedScreenshot {
  cards: AnalyzedCard[]
  /** 卡片宽度（像素）：太小时识别结果不可靠 */
  cardWidth: number
}

/** OCR 前把文字放大到这个高度 */
const OCR_TEXT_HEIGHT = 48
const OCR_PAD = 12

/** 留白之后放大到字高约 48 像素（Tesseract 在这个大小上最准） */
export function scaleForOcr(text: TextCrop): RgbaImage | null {
  if (!text.box) return null
  const src = padImage(text.image, OCR_PAD)
  const s = Math.max(1, OCR_TEXT_HEIGHT / text.box.height)
  if (s === 1) return src
  return resize(src, Math.round(src.width * s), Math.round(src.height * s))
}

export function padImage(img: RgbaImage, pad: number): RgbaImage {
  const w = img.width + pad * 2
  const h = img.height + pad * 2
  const out = new Uint8ClampedArray(w * h * 4).fill(255)
  for (let y = 0; y < img.height; y++) {
    out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + pad) * w + pad) * 4)
  }
  return { width: w, height: h, data: out }
}

/** 双线性缩放 */
export function resize(img: RgbaImage, width: number, height: number): RgbaImage {
  const out = new Uint8ClampedArray(width * height * 4)
  const sx = img.width / width
  const sy = img.height / height
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = sample(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5)
      const o = (y * width + x) * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = 255
    }
  }
  return { width, height, data: out }
}

/**
 * 裁掉四周的白边（候选名字画出来以后用）：和白色差别超过 threshold 的像素算作文字。
 * 全白时返回 1×1 的白图。
 */
export function trimInk(img: RgbaImage, threshold = 10): RgbaImage {
  let x0 = img.width
  let y0 = img.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const diff = 765 - img.data[i]! - img.data[i + 1]! - img.data[i + 2]!
      if (diff <= threshold * 3) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) }
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x1 + 1) * 4), y * w * 4)
  return { width: w, height: h, data: out }
}

export function analyzeScreenshot(img: RgbaImage, game: ScreenshotGame): AnalyzedScreenshot {
  const grid = detectGrid(img)
  const cards = grid.cards.map((rect): AnalyzedCard => {
    if (game === 'endfield') {
      const card = ef.readCard(img, rect)
      const text = prepareText(img, card.nameRect, false, 0)
      return { rect: card.rect, potential: card.potential, potentialConfidence: card.potentialConfidence, crop: text.image, ocrInput: scaleForOcr(text) }
    }
    const card = ak.readCard(img, rect)
    const text = prepareText(img, card.nameRect, true, 0)
    return { rect: card.rect, potential: null, potentialConfidence: null, crop: text.image, ocrInput: scaleForOcr(text) }
  })
  return { cards, cardWidth: grid.cards[0]?.width ?? 0 }
}
