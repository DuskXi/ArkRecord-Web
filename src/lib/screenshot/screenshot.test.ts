/**
 * 截图识别（实验）：用合成图片测试网格、五角星、星级和名字分配。
 * 真实截图上的结果见 docs/rewrite/screenshot-recognition.md（截图是用户的，不放进仓库）。
 */
import { describe, expect, it } from 'vitest'
import * as ak from './arknights'
import { POTENTIAL_ORDER, potentialOf } from './endfield'
import { detectGrid } from './grid'
import type { RgbaImage } from './image'
import { assignNames } from './names'
import { type PentagramGeometry, readStrokes, stroke } from './pentagram'

type Color = [number, number, number]

function canvas(width: number, height: number, bg: Color): RgbaImage & { set(x: number, y: number, c: Color): void; fill(x: number, y: number, w: number, h: number, c: Color): void } {
  const data = new Uint8ClampedArray(width * height * 4)
  const set = (x: number, y: number, c: Color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (Math.floor(y) * width + Math.floor(x)) * 4
    data.set([...c, 255], i)
  }
  const fill = (x: number, y: number, w: number, h: number, c: Color) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c)
  }
  fill(0, 0, width, height, bg)
  return { width, height, data, set, fill }
}

/** 粗线段 */
function line(img: ReturnType<typeof canvas>, a: [number, number], b: [number, number], width: number, c: Color) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  for (let t = 0; t <= len; t += 0.25) {
    const x = a[0] + ((b[0] - a[0]) * t) / len
    const y = a[1] + ((b[1] - a[1]) * t) / len
    for (let dx = -width / 2; dx <= width / 2; dx += 0.5) for (let dy = -width / 2; dy <= width / 2; dy += 0.5) img.set(x + dx, y + dy, c)
  }
}

describe('网格', () => {
  it('找出等间距的卡片，去掉被截断的', () => {
    const img = canvas(600, 1300, [219, 219, 219])
    // 4 列 × 6 行，最上面一行被截掉一半，最后一行只有两张
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 4; col++) {
        if (row === 5 && col >= 2) continue
        const y = -100 + row * 228 + (row % 2) // 行距有一点出入，像拼接的长截图
        img.fill(24 + col * 140, y, 128, 212, [40 + row * 10, 60, 80 + col * 20])
      }
    }
    const grid = detectGrid(img)
    expect(grid.cards).toHaveLength(4 * 4 + 2)
    expect(grid.cards[0]).toMatchObject({ x: 24, width: 128 })
    expect(Math.abs(grid.cards[0]!.y - 128)).toBeLessThanOrEqual(2)
    expect(grid.cells.at(-1)).toEqual({ row: 4, column: 1 })
  })
})

describe('终末地五角星', () => {
  const g: PentagramGeometry = { cx: 40, cy: 40, r: 20, theta: (-31 * Math.PI) / 180 }
  const WHITE: Color = [250, 250, 250]
  const YELLOW: Color = [250, 210, 20]

  function draw(states: ('W' | 'Y' | '.')[], bg: Color = [60, 70, 80]) {
    const img = canvas(80, 80, bg)
    states.forEach((s, k) => {
      if (s !== '.') line(img, ...stroke(g, k), 3, s === 'W' ? WHITE : YELLOW)
    })
    return img
  }

  it('读出每一笔的颜色', () => {
    const r = readStrokes(draw(['W', '.', '.', 'Y', 'W']), g)
    expect(r.strokes).toEqual(['white', 'none', 'none', 'yellow', 'white'])
  })

  it('潜能：黄色那一笔在解锁顺序里的位置；全白为 5', () => {
    for (let p = 0; p < 5; p++) {
      const states: ('W' | 'Y' | '.')[] = ['.', '.', '.', '.', '.']
      POTENTIAL_ORDER.slice(0, p).forEach((k) => (states[k] = 'W'))
      states[POTENTIAL_ORDER[p]!] = 'Y'
      expect(potentialOf(readStrokes(draw(states), g))).toBe(p)
    }
    expect(potentialOf(readStrokes(draw(['W', 'W', 'W', 'W', 'W']), g))).toBe(5)
  })

  it('浅色背景上白色笔画看不清，但黄色那一笔仍然能确定潜能', () => {
    const states: ('W' | 'Y' | '.')[] = ['W', '.', '.', 'Y', 'W']
    const r = readStrokes(draw(states, [235, 235, 235]), g)
    expect(r.strokes[3]).toBe('yellow')
    expect(potentialOf(r)).toBe(2)
  })
})

/** 一张只有星星的明日方舟卡片 */
function card(stars: number, width: number) {
  const height = Math.round(width * 2.16)
  const img = canvas(width + 20, height + 20, [30, 30, 30])
  img.fill(10, 10, width, height, [15, 15, 15])
  const pitch = width * ak.STAR_PITCH
  const size = pitch * 0.85
  for (let i = 0; i < stars; i++) {
    const x = 10 + width * 0.3 + i * pitch
    img.fill(Math.round(x), Math.round(10 + height * 0.035), Math.max(1, Math.round(size)), Math.max(2, Math.round(height * 0.03)), [255, 215, 0])
  }
  return { img, rect: { x: 10, y: 10, width, height } }
}

describe('明日方舟星级', () => {
  it.each([56, 120, 225])('卡片宽 %i 像素时数对 1–6 颗星', (width) => {
    for (let n = 1; n <= 6; n++) {
      const { img, rect } = card(n, width)
      expect(ak.readCard(img, rect).rarity).toBe(n)
    }
  })
})

describe('名字分配', () => {
  const candidates = [
    { id: 'a', name: '别礼', rarity: 6 },
    { id: 'b', name: '祀', rarity: 6 },
    { id: 'c', name: '诀', rarity: 6 },
    { id: 'd', name: '陈千语', rarity: 5 },
  ]

  it('认错的字按最接近的已知名字纠正；每个名字只分给一张卡片', () => {
    const r = assignNames(['别礼', '礼', '诀', '陈干语'], candidates, [6, 6, 6, 5])
    expect(r.map((m) => m?.candidate.name)).toEqual(['别礼', '祀', '诀', '陈千语'])
  })

  it('什么都没认出来的卡片不分配', () => {
    expect(assignNames(['', '诀'], candidates)[0]).toBeNull()
  })
})
