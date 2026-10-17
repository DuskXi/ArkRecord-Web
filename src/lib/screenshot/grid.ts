/**
 * 找出截图里的卡片网格（森空岛的干员列表：每行 3–6 张同样大小的卡片）。
 *
 * 做法：用左边缘估计页面背景色，和背景差别大的像素算作前景；
 *   1. 按列统计前景比例，比例高的连续区间就是一列卡片；
 *   2. 卡片在竖直方向大致等间距：用自相关求出行距，折叠后最空的一段是卡片之间的空隙；
 *   3. 长截图是拼接的，行距会有几个像素的出入：每一行在预计位置附近和“平均卡片”对齐；
 *   4. 只保留完整在截图里、有内容的格子（截图上下边缘被截断的卡片会被去掉）。
 */
import { distance, median, pixel, type Rect, type Rgb, type RgbaImage, runs } from './image'

export interface Grid {
  background: Rgb
  cards: Rect[]
  /** 卡片的行、列（从 0 开始），与 cards 一一对应 */
  cells: { row: number; column: number }[]
}

const FOREGROUND = 40

export function detectBackground(img: RgbaImage): Rgb {
  const samples: Rgb[] = []
  const strip = Math.max(2, Math.round(img.width * 0.01))
  for (let y = Math.round(img.height * 0.1); y < img.height * 0.9; y += 2) {
    for (let x = 0; x < strip; x++) samples.push(pixel(img, x, y))
  }
  return [0, 1, 2].map((k) => median(samples.map((s) => s[k]!))) as Rgb
}

/** 自相关最大的间距 */
function bestPitch(profile: Float32Array, min: number, max: number): number {
  let mean = 0
  for (const v of profile) mean += v
  mean /= profile.length
  let best = min
  let bestScore = -Infinity
  for (let lag = min; lag <= max; lag++) {
    let score = 0
    for (let i = 0; i + lag < profile.length; i++) score += (profile[i]! - mean) * (profile[i + lag]! - mean)
    score /= profile.length - lag
    if (score > bestScore) {
      bestScore = score
      best = lag
    }
  }
  return best
}

export function detectGrid(img: RgbaImage): Grid {
  const background = detectBackground(img)
  const fg = (x: number, y: number) => distance(pixel(img, x, y), background) > FOREGROUND

  // 1. 列：跳过顶部的标题栏和底部，按列统计前景比例
  const top = Math.round(img.height * 0.08)
  const bottom = Math.round(img.height * 0.98)
  const colProfile = new Float32Array(img.width)
  for (let x = 0; x < img.width; x++) {
    let n = 0
    let total = 0
    for (let y = top; y < bottom; y += 2) {
      total++
      if (fg(x, y)) n++
    }
    colProfile[x] = n / total
  }
  let columns = runs(colProfile, (v) => v > 0.35).filter(([a, b]) => b - a >= img.width * 0.08)
  const colWidth = median(columns.map(([a, b]) => b - a))
  columns = columns.filter(([a, b]) => Math.abs(b - a - colWidth) <= colWidth * 0.15)

  // 2. 行：卡片在竖直方向也是等间距的。用所有列的前景比例做自相关求出行距，
  //    再把序列按行距折叠，最空的一段就是卡片之间的空隙
  const rowProfile = new Float32Array(img.height)
  for (let y = 0; y < img.height; y++) {
    let n = 0
    let total = 0
    for (const [x0, x1] of columns) {
      for (let x = x0; x < x1; x += 2) {
        total++
        if (fg(x, y)) n++
      }
    }
    rowProfile[y] = total ? n / total : 0
  }
  const pitch = bestPitch(rowProfile, Math.round(colWidth * 1.05), Math.round(colWidth * 3))
  const folded = new Float32Array(pitch)
  const counts = new Uint16Array(pitch)
  for (let y = 0; y < img.height; y++) {
    folded[y % pitch]! += rowProfile[y]!
    counts[y % pitch]!++
  }
  for (let i = 0; i < pitch; i++) folded[i]! /= counts[i]! || 1
  // 折叠后找最长的“低谷”（环形）：空隙结束的位置就是卡片顶部
  const low = Math.min(...folded) + (Math.max(...folded) - Math.min(...folded)) * 0.3
  let gapStart = 0
  let gapLength = 0
  for (let i = 0; i < pitch; i++) {
    let n = 0
    while (n < pitch && folded[(i + n) % pitch]! <= low) n++
    if (n > gapLength) {
      gapLength = n
      gapStart = i
    }
  }
  const phase = (gapStart + gapLength) % pitch
  const cardHeight = pitch - gapLength

  // 3. 长截图是拼接出来的，行距并不严格相等：从上一行的位置加一个行距出发，
  //    在附近找和“平均卡片”（折叠后的序列）最吻合的位置
  const template = Array.from({ length: pitch }, (_, i) => folded[(phase + i) % pitch]!)
  const tMean = template.reduce((a, b) => a + b, 0) / pitch
  const slack = Math.max(2, Math.round(pitch * 0.06))
  const align = (guess: number) => {
    let best = guess
    let bestScore = -Infinity
    for (let y = guess - slack; y <= guess + slack; y++) {
      let score = 0
      for (let i = 0; i < pitch; i++) {
        const v = y + i >= 0 && y + i < img.height ? rowProfile[y + i]! : 0
        score += (v - tMean) * (template[i]! - tMean)
      }
      if (score > bestScore) {
        bestScore = score
        best = y
      }
    }
    return best
  }
  const starts: number[] = []
  // 从最吻合的一行出发，向下、向上依次对齐
  let anchor = phase
  let anchorScore = -Infinity
  for (let y = phase; y + pitch <= img.height; y += pitch) {
    let score = 0
    for (let i = 0; i < pitch; i++) score += (rowProfile[y + i]! - tMean) * (template[i]! - tMean)
    if (score > anchorScore) {
      anchorScore = score
      anchor = y
    }
  }
  for (let y = anchor; y + cardHeight <= img.height + slack; y = align(y + pitch)) starts.push(y)
  for (let y = align(anchor - pitch); y >= -slack; y = align(y - pitch)) starts.unshift(y)

  // 4. 列出每个格子，只保留完整在截图里、而且有内容的
  const cards: Rect[] = []
  const cells: Grid['cells'] = []
  let row = 0
  for (const y of starts) {
    if (y < 0 || y + cardHeight > img.height) continue
    let any = false
    columns.forEach(([x0, x1], column) => {
      let n = 0
      let total = 0
      for (let yy = y; yy < y + cardHeight; yy += 2) {
        for (let x = x0; x < x1; x += 2) {
          total++
          if (fg(x, yy)) n++
        }
      }
      if (n / total > 0.5) {
        cards.push({ x: x0, y, width: x1 - x0, height: cardHeight })
        cells.push({ row, column })
        any = true
      }
    })
    if (any) row++
  }
  return { background, cards, cells }
}
