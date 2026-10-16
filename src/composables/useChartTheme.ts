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
