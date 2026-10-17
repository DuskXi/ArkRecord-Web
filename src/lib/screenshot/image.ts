/**
 * 截图识别（实验）用到的最基本的图像操作。只依赖 RGBA 像素数组，
 * 浏览器里来自 canvas 的 ImageData，Node 里来自任意解码库，两边运行同一份代码。
 */

export interface RgbaImage {
  width: number
  height: number
  /** RGBA，每个像素 4 字节 */
  data: Uint8ClampedArray | Uint8Array
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type Rgb = [number, number, number]

export function pixel(img: RgbaImage, x: number, y: number): Rgb {
  const i = (Math.min(img.height - 1, Math.max(0, Math.round(y))) * img.width + Math.min(img.width - 1, Math.max(0, Math.round(x)))) * 4
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]
}

/** 双线性采样（坐标可以是小数） */
export function sample(img: RgbaImage, x: number, y: number): Rgb {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const a = pixel(img, x0, y0)
  const b = pixel(img, x0 + 1, y0)
  const c = pixel(img, x0, y0 + 1)
  const d = pixel(img, x0 + 1, y0 + 1)
  return [0, 1, 2].map((k) => a[k]! * (1 - fx) * (1 - fy) + b[k]! * fx * (1 - fy) + c[k]! * (1 - fx) * fy + d[k]! * fx * fy) as Rgb
}

export function crop(img: RgbaImage, r: Rect): RgbaImage {
  const x0 = Math.max(0, Math.round(r.x))
  const y0 = Math.max(0, Math.round(r.y))
  const w = Math.max(1, Math.min(img.width - x0, Math.round(r.width)))
  const h = Math.max(1, Math.min(img.height - y0, Math.round(r.height)))
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4
    out.set(img.data.subarray(from, from + w * 4), y * w * 4)
  }
  return { width: w, height: h, data: out }
}

/** HSV：h 为 0–360，s、v 为 0–1 */
export function hsv([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : d / max, max / 255]
}

export function distance(a: Rgb, b: Rgb): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
}

export function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** 一维序列里连续满足条件的区间 [start, end) */
export function runs(values: ArrayLike<number>, test: (v: number) => boolean): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  for (let i = 0; i <= values.length; i++) {
    const on = i < values.length && test(values[i]!)
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      out.push([start, i])
      start = -1
    }
  }
  return out
}
