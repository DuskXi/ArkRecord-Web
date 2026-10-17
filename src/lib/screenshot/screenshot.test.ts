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

describe('名字区域整理（text.ts）', () => {
  it('去掉贯穿整行的线条和装饰，裁到文字范围，输出白底黑字', async () => {
    const { prepareText } = await import('./text')
    // 深色底、浅色字，左边一条中灰的斜条，底部一条亮线
    const img = canvas(120, 30, [20, 20, 20])
    for (let y = 0; y < 30; y++) for (let x = 0; x < 20; x++) if (x + y < 30) img.set(x, y, [70, 70, 70])
    img.fill(0, 28, 120, 2, [230, 230, 230])
    img.fill(80, 6, 14, 16, [240, 240, 240])
    img.fill(98, 6, 14, 16, [240, 240, 240])
    const r = prepareText(img, { x: 0, y: 0, width: 120, height: 30 }, true, 2)
    expect(r.box).toEqual({ x: 80, y: 6, width: 32, height: 16 })
    expect(r.image.width).toBe(36)
    // 左上角是留白（白），文字位置是黑
    expect(Array.from(r.image.data.slice(0, 3))).toEqual([255, 255, 255])
    const i = (2 * r.image.width + 2) * 4
    expect(Array.from(r.image.data.slice(i, i + 3))).toEqual([0, 0, 0])
  })
})

/** 每个名字一个确定的“字形”：按字符编码画几个方块 */
function glyph(name: string): RgbaImage {
  const chars = [...name]
  const img = canvas(chars.length * 20, 20, [255, 255, 255])
  chars.forEach((ch, k) => {
    const code = ch.codePointAt(0)!
    for (let b = 0; b < 9; b++) if ((code >> b) & 1) img.fill(k * 20 + (b % 3) * 6 + 1, Math.floor(b / 3) * 6 + 1, 5, 5, [0, 0, 0])
  })
  return img
}

describe('认名字：OCR 和字形结合（identify.ts）', () => {
  const candidates = [
    { id: 'a', name: '黍', rarity: 6 },
    { id: 'b', name: '陈', rarity: 6 },
    { id: 'c', name: '令', rarity: 6 },
    { id: 'd', name: '焰狐龙梓兰', rarity: 6 },
    { id: 'e', name: '温蒂', rarity: 6 },
  ]

  it('OCR 认不出的单字名按字形挑出来；OCR 完全一致的直接采用', async () => {
    const { identifyNames } = await import('./identify')
    const crops = ['黍', '令', '焰狐龙梓兰'].map(glyph)
    const r = identifyNames(crops, ['了', '令', '焰狐龙梓兰'], candidates, [6, 6, 6], glyph)
    expect(r.map((x) => x.candidate?.name)).toEqual(['黍', '令', '焰狐龙梓兰'])
    expect(r.map((x) => x.confidence)).toEqual(['high', 'high', 'high'])
    expect(r[0]!.via).toBe('shape')
  })

  it('星星数错了：OCR 完全一致的其他星级的名字仍然会被选上，但标为请确认', async () => {
    const { identifyNames } = await import('./identify')
    const r = identifyNames([glyph('焰狐龙梓兰')], ['焰狐龙梓兰'], candidates, [5], glyph)
    expect(r[0]).toMatchObject({ candidate: { name: '焰狐龙梓兰' }, confidence: 'low' })
  })

  it('谁都不像（游戏数据里还没有的名字）：不硬套，交给用户确认', async () => {
    const { identifyNames } = await import('./identify')
    const r = identifyNames([glyph('锏')], ['铀'], candidates, [6], glyph)
    expect(r[0]!.confidence).toBe('low')
  })
})

/** 3×3 的方块图案，再加几块噪点 */
function pattern(bits: number[], noise: [number, number, number][] = []): RgbaImage {
  const img = canvas(20, 20, [255, 255, 255])
  for (const b of bits) img.fill((b % 3) * 6 + 1, Math.floor(b / 3) * 6 + 1, 5, 5, [0, 0, 0])
  for (const [x, y, s] of noise) img.fill(x, y, s, s, [0, 0, 0])
  return img
}

describe('OCR 认错的字：把认出的字画出来比字形（identify.ts）', () => {
  // “铜”和“锏”长得很像（多一块），其他名字都不像
  const shapes: Record<string, number[]> = { 锏: [0, 2, 4, 6, 8], 铜: [0, 2, 4, 6, 8, 1], 黍: [1, 3, 5, 7], 令: [0, 1, 2, 4, 7], 陈: [3, 4, 5, 1, 7] }
  const render = (name: string) => pattern(shapes[name] ?? [4])
  const candidates = ['锏', '黍', '令', '陈'].map((name, i) => ({ id: String(i), name, rarity: 6 }))
  // 截图里的字很模糊：只和“锏”有点像，单靠字形没有把握
  const blurry = pattern([0, 2], [[1, 9, 3], [3, 14, 2], [12, 2, 2], [11, 11, 4]])

  it('单靠字形没把握时，OCR 认成的“铜”画出来最像“锏”，两个信号一致 → 有把握', async () => {
    const { identifyNames } = await import('./identify')
    expect(identifyNames([blurry], [''], candidates, [null], render)[0]!.confidence).toBe('low')
    expect(identifyNames([blurry], ['铜'], candidates, [null], render)[0]).toMatchObject({ candidate: { name: '锏' }, confidence: 'high', via: 'both' })
  })

  it('截图字形很清楚时，OCR 认成了别的名字也按字形', async () => {
    const { identifyNames } = await import('./identify')
    const r = identifyNames([render('锏')], ['黍'], candidates, [null], render)
    expect(r[0]).toMatchObject({ candidate: { name: '锏' }, via: 'shape' })
  })
})

describe('识别流程的图像处理（pipeline.ts）', () => {
  it('trimInk 裁到文字范围；全白时返回 1×1', async () => {
    const { trimInk } = await import('./pipeline')
    const img = canvas(40, 20, [255, 255, 255])
    img.fill(10, 5, 8, 6, [0, 0, 0])
    const t = trimInk(img)
    expect([t.width, t.height]).toEqual([8, 6])
    expect([trimInk(canvas(5, 5, [255, 255, 255])).width, trimInk(canvas(5, 5, [250, 250, 250])).width]).toEqual([1, 1])
  })

  it('scaleForOcr 留白后放大到字高约 48 像素', async () => {
    const { scaleForOcr } = await import('./pipeline')
    const image = canvas(30, 12, [255, 255, 255])
    image.fill(0, 0, 30, 12, [0, 0, 0])
    const out = scaleForOcr({ image, box: { x: 0, y: 0, width: 30, height: 12 } })!
    // (30 + 24) × 4, (12 + 24) × 4
    expect([out.width, out.height]).toEqual([216, 144])
    expect(scaleForOcr({ image, box: null })).toBeNull()
  })
})
