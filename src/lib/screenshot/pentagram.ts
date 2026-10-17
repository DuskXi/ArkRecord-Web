/**
 * 五角星图标（终末地森空岛卡片左下角）：由 5 笔组成，每一笔可能是白色、黄色，或者没有画出来。
 *
 * 几何：顶点 V_k = 中心 + R·(sin(θ + 72°k), −cos(θ + 72°k))，第 k 笔连接 V_k 和 V_{k+2}。
 * 每一笔上取若干个采样点（避开和其他笔交叉的位置），算两个相对的分数：
 *   - 黄色程度：只认“明显比其他四笔都黄”的那一笔（最多一笔），不用固定的颜色门槛；
 *   - 亮度对比：比至少一侧的背景亮多少。亮的笔画是白色（或者颜色被压缩掉的黄色）；
 *   - 都不是：这一笔没有画出来（或者背景太亮、看不清）。
 */
import { hsv, median, type Rgb, type RgbaImage, sample } from './image'

export interface PentagramGeometry {
  cx: number
  cy: number
  r: number
  /** 弧度 */
  theta: number
}

export type StrokeState = 'yellow' | 'white' | 'none'

export interface PentagramReading {
  geometry: PentagramGeometry
  strokes: StrokeState[]
  /** 每一笔的分数：黄色程度、亮度对比（都是 0–1） */
  detail: { yellow: number; white: number }[]
}

const TAU = Math.PI * 2

export function vertices(g: PentagramGeometry): [number, number][] {
  return Array.from({ length: 5 }, (_, k) => {
    const a = g.theta + (k * TAU) / 5
    return [g.cx + g.r * Math.sin(a), g.cy - g.r * Math.cos(a)] as [number, number]
  })
}

/** 第 k 笔的两个端点 */
export function stroke(g: PentagramGeometry, k: number): [[number, number], [number, number]] {
  const v = vertices(g)
  return [v[k]!, v[(k + 2) % 5]!]
}

// 每一笔在 t≈0.38、0.62 处与其他两笔交叉，采样时避开
const T = [0.08, 0.16, 0.24, 0.3, 0.46, 0.5, 0.54, 0.7, 0.76, 0.84, 0.92]

/**
 * 黄色程度（0–1）：色相在黄色附近时取 (R+G)/2 − B。用相对的色度而不是固定的饱和度门槛，
 * 压缩（JPEG 的色度模糊）、变暗、降低饱和度之后，黄色那一笔仍然比其他笔画明显更黄。
 */
export function yellowScore(c: Rgb): number {
  const [h] = hsv(c)
  return h >= 28 && h <= 80 ? Math.max(0, (c[0] + c[1]) / 2 - c[2]) / 255 : 0
}

function luminance(c: Rgb): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

/** 黄色那一笔：分数至少这么高，并且比第二黄的笔画高出这么多 */
const YELLOW_MIN = 0.12
const YELLOW_GAP = 0.06
/** 亮的笔画（白色或黄色）：比至少一侧的背景亮这么多（亮度 0–1） */
const LIT_MIN = 0.12

export function readStrokes(img: RgbaImage, g: PentagramGeometry): PentagramReading {
  const detail: PentagramReading['detail'] = []
  const offset = Math.max(1.5, g.r * 0.22)
  for (let k = 0; k < 5; k++) {
    const [a, b] = stroke(g, k)
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const normal: [number, number] = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]
    let y = 0
    const contrasts: number[] = []
    for (const t of T) {
      const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const c = sample(img, p[0], p[1])
      y += yellowScore(c)
      // 至少比一侧亮（另一侧可能紧挨着相交的笔画）
      const side = Math.min(
        luminance(sample(img, p[0] + normal[0] * offset, p[1] + normal[1] * offset)),
        luminance(sample(img, p[0] - normal[0] * offset, p[1] - normal[1] * offset)),
      )
      contrasts.push(Math.max(0, luminance(c) - side) / 255)
    }
    // 亮度对比取中位数：笔画两端的采样点挨着相邻的笔画，取平均会被它们带偏
    detail.push({ yellow: y / T.length, white: median(contrasts) })
  }
  const order = detail.map((d, k) => ({ k, y: d.yellow })).toSorted((a, b) => b.y - a.y)
  const yellow = order[0]!.y >= YELLOW_MIN && order[0]!.y - order[1]!.y >= YELLOW_GAP ? order[0]!.k : -1
  const strokes: StrokeState[] = detail.map((d, k) => (k === yellow ? 'yellow' : d.white >= LIT_MIN ? 'white' : 'none'))
  return { geometry: g, strokes, detail }
}

/** 一组几何参数和图像的吻合程度：笔画上亮、星星中心和外侧暗 */
export function fitScore(img: RgbaImage, g: PentagramGeometry): number {
  let on = 0
  let n = 0
  for (let k = 0; k < 5; k++) {
    const [a, b] = stroke(g, k)
    for (const t of T) {
      const c = sample(img, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
      on += Math.max(Math.min(1, yellowScore(c) * 3) * 255, luminance(c))
      n++
    }
  }
  // 对照：中心（内五边形）和每两个尖角之间的外侧
  let off = luminance(sample(img, g.cx, g.cy))
  let m = 1
  for (let k = 0; k < 5; k++) {
    const a = g.theta + ((k + 0.5) * TAU) / 5
    off += luminance(sample(img, g.cx + g.r * 0.75 * Math.sin(a), g.cy - g.r * 0.75 * Math.cos(a)))
    m++
  }
  return on / n - off / m
}

/** 在给定范围内搜索最吻合的几何参数 */
export function fitPentagram(
  img: RgbaImage,
  start: PentagramGeometry,
  range: { shift: number; scale: number; rotate: number; step?: number },
): PentagramGeometry {
  const step = range.step ?? 0.5
  let best = start
  let bestScore = -Infinity
  for (let dx = -range.shift; dx <= range.shift; dx += step) {
    for (let dy = -range.shift; dy <= range.shift; dy += step) {
      for (let s = 1 - range.scale; s <= 1 + range.scale + 1e-9; s += 0.04) {
        for (let dt = -range.rotate; dt <= range.rotate + 1e-9; dt += Math.PI / 90) {
          const g = { cx: start.cx + dx, cy: start.cy + dy, r: start.r * s, theta: start.theta + dt }
          const score = fitScore(img, g)
          if (score > bestScore) {
            bestScore = score
            best = g
          }
        }
      }
    }
  }
  return best
}
