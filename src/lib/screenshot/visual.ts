/**
 * 用字形核对名字：把候选名字用系统字体画出来，和截图里裁出的文字比较形状。
 * OCR 认不出的生僻字（例如“黍”），只要候选名单里有，就能按形状挑出来；
 * 谁都不像时（例如游戏数据里还没有的新干员）就判为“不认识”，交给用户确认。
 *
 * 文字图都是白底黑字、裁到文字范围（见 text.ts 的 prepareText）。字体不同没关系：
 * 比较前缩放到同样大小并模糊一点，比的是整体形状。
 */
import type { RgbaImage } from './image'

const H = 32

/** 缩放到 w×h 的“墨量”（0–1，黑为 1），按面积平均 */
export function inkGrid(img: RgbaImage, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const sx = img.width / w
  const sy = img.height / h
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let n = 0
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      const y0 = Math.floor(y * sy)
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4
          sum += 1 - (0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!) / 255
          n++
        }
      }
      out[y * w + x] = n ? sum / n : 0
    }
  }
  return out
}

function blur(a: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(a.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          s += a[yy * w + xx]!
          n++
        }
      }
      out[y * w + x] = s / n
    }
  }
  return out
}

function pearson(a: Float32Array, b: Float32Array): number {
  let ma = 0
  let mb = 0
  for (let i = 0; i < a.length; i++) {
    ma += a[i]!
    mb += b[i]!
  }
  ma /= a.length
  mb /= b.length
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

/** 比较用的形状向量：缩放到 w×32、模糊一点的墨量 */
export function shapeVector(img: RgbaImage, w: number): Float32Array {
  return blur(inkGrid(img, w, H), w, H)
}

/** 比较时用的宽度（由裁出的文字图的宽高比决定） */
export function shapeWidth(img: RgbaImage): number {
  return Math.max(8, Math.round((H * img.width) / img.height))
}

/** 宽高比差得多（字数不同）时不用比 */
export function similarAspect(a: RgbaImage, b: RgbaImage): boolean {
  return Math.abs(Math.log(a.width / a.height / (b.width / b.height))) <= 0.45
}

export const compareShapes = pearson

/** 两张文字图的形状相似度（−1–1）。宽高比差得多（字数不同）时直接很低 */
export function shapeSimilarity(a: RgbaImage, b: RgbaImage): number {
  if (!similarAspect(a, b)) return -1
  const w = shapeWidth(a)
  return pearson(shapeVector(a, w), shapeVector(b, w))
}

export interface VisualPick {
  name: string
  similarity: number
  /** 和第二像的差距 */
  margin: number
}

/**
 * 在候选里按形状找最像的。render 把名字画成白底黑字、裁到文字范围的图（浏览器里用 canvas）。
 * 返回最像的一个；最像的不够像、或者和第二像的差不多时返回 null。
 */
export function pickByShape(
  crop: RgbaImage,
  names: string[],
  render: (name: string) => RgbaImage,
  options: { min?: number; margin?: number } = {},
): VisualPick | null {
  const scored = names
    .map((name) => ({ name, similarity: shapeSimilarity(crop, render(name)) }))
    .toSorted((x, y) => y.similarity - x.similarity)
  const best = scored[0]
  if (!best) return null
  const margin = best.similarity - (scored[1]?.similarity ?? -1)
  if (best.similarity < (options.min ?? 0.55) || margin < (options.margin ?? 0.06)) return null
  return { name: best.name, similarity: best.similarity, margin }
}
