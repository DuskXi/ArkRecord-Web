const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const number = new Intl.NumberFormat('zh-CN')

export const formatDateTime = (ts: number) => dateTime.format(ts)
export const formatDate = (ts: number) => date.format(ts)
export const formatNumber = (n: number) => number.format(n)
export const formatPercent = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`

/** 用于文字的星级色：与正文高亮色混合，保证在浅色、深色背景下都有足够对比度 */
export function rarityTextVar(star: number): string {
  return `color-mix(in oklab, ${rarityVar(star)} 72%, var(--ui-text-highlighted))`
}

/** 星级对应的 CSS 颜色变量（在 main.css 的 @theme 中定义） */
export function rarityVar(star: number): string {
  return star >= 6 ? 'var(--color-rarity-6)' : star === 5 ? 'var(--color-rarity-5)' : star === 4 ? 'var(--color-rarity-4)' : 'var(--color-rarity-3)'
}
