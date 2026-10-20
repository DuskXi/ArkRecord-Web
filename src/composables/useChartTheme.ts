import { useMutationObserver } from '@vueuse/core'
import { ref } from 'vue'

export interface ChartPalette {
  text: string
  muted: string
  dimmed: string
  border: string
  bg: string
  primary: string
  rarity6: string
  rarity5: string
  rarity4: string
  rarity3: string
  dark: boolean
}

const canvas = document.createElement('canvas')
canvas.width = canvas.height = 1
const ctx = canvas.getContext('2d', { willReadFrequently: true })

/** ECharts 不认识 oklch() 等新颜色语法，借助 canvas 统一转成 rgb() */
function toRgb(color: string): string {
  if (!ctx || !color) return color
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#000'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${((a ?? 0) / 255).toFixed(3)})`
}

function read(): ChartPalette {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string) => style.getPropertyValue(name).trim()
  // --ui-* 变量可能引用其他变量，借助一个临时元素解析成实际颜色
  const probe = document.createElement('span')
  document.body.appendChild(probe)
  const resolve = (name: string) => {
    probe.style.color = `var(${name})`
    return toRgb(getComputedStyle(probe).color)
  }
  const palette: ChartPalette = {
    text: resolve('--ui-text'),
    muted: resolve('--ui-text-muted'),
    dimmed: resolve('--ui-text-dimmed'),
    border: resolve('--ui-border'),
    bg: resolve('--ui-bg'),
    primary: resolve('--ui-primary'),
    rarity6: toRgb(v('--color-rarity-6')),
    rarity5: toRgb(v('--color-rarity-5')),
    rarity4: toRgb(v('--color-rarity-4')),
    rarity3: toRgb(v('--color-rarity-3')),
    dark: document.documentElement.classList.contains('dark'),
  }
  probe.remove()
  return palette
}

/** 图表配色跟随深浅色模式和游戏主题变化 */
export function useChartTheme() {
  const palette = ref<ChartPalette>(read())
  useMutationObserver(
    document.documentElement,
    () => {
      palette.value = read()
    },
    { attributes: true, attributeFilter: ['class', 'data-game'] },
  )
  return palette
}

/** 星级对应的图表颜色（和 lib/format.ts 的 rarityVar 一致） */
export function rarityColor(p: ChartPalette, star: number): string {
  return star >= 6 ? p.rarity6 : star === 5 ? p.rarity5 : star === 4 ? p.rarity4 : p.rarity3
}

/** 坐标轴的统一样式 */
export function axisStyle(p: ChartPalette) {
  return {
    axisLine: { lineStyle: { color: p.border } },
    axisLabel: { color: p.dimmed, fontSize: 11 },
    splitLine: { lineStyle: { color: p.border, type: 'dashed' as const } },
  }
}

function parseRgb(color: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number)
  return [r, g, b]
}

/** 两个 rgb() 颜色按比例混合，t 为 a 的占比 */
export function mixRgb(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseRgb(a)
  const [br, bg, bb] = parseRgb(b)
  const mix = (x: number, y: number) => Math.round(x * t + y * (1 - t))
  return `rgb(${mix(ar, br)}, ${mix(ag, bg)}, ${mix(ab, bb)})`
}

/**
 * 热力图的分档配色（类似 GitHub 贡献图）：0 用边框色，其余按非零数值的四分位分成 4 档。
 * 线性渐变时，数值小的格子在浅色主题下几乎看不见。
 */
export function heatPieces(values: number[], p: ChartPalette, accent: string) {
  const ramp = [0.3, 0.55, 0.8, 1].map((t) => mixRgb(accent, p.bg, t))
  const pieces: { min?: number; max?: number; color: string }[] = [{ min: 0, max: 0, color: p.border }]
  const nonzero = values.filter((v) => v > 0).toSorted((a, b) => a - b)
  if (!nonzero.length) return pieces
  const at = (f: number) => nonzero[Math.floor(f * (nonzero.length - 1))]!
  const cuts = [...new Set([at(0.25), at(0.5), at(0.75)])]
  const ranges: { min: number; max?: number }[] = []
  let lower = Math.min(1, nonzero[0]!)
  for (const cut of cuts) {
    if (cut < lower) continue
    ranges.push({ min: lower, max: cut })
    lower = cut + Number.EPSILON
  }
  ranges.push({ min: lower })
  const colors = ramp.slice(ramp.length - ranges.length)
  ranges.forEach((r, i) => pieces.push({ ...r, color: colors[i]! }))
  return pieces
}
