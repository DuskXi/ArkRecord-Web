<script setup lang="ts">
/**
 * 桌面版的标题栏（替代系统标题栏，只在桌面版显示）：可以拖动窗口，双击最大化。
 * Windows / Linux 的最小化、最大化、关闭按钮由 Electron 画在右边（titleBarOverlay），颜色和这里的背景色、文字色一致，
 * 跟着深浅色切换；macOS 的红绿灯在左边，留出位置。高度和 desktop/electron/main.ts 的 TITLE_BAR_HEIGHT 一致（40px）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { desktopBridge } from '@/lib/transport'

const bridge = desktopBridge()
/** macOS 的窗口按钮（红绿灯）由系统画在左上角，不用设置颜色 */
const mac = bridge?.platform === 'darwin'
const bar = ref<HTMLElement>()

/** 任意 CSS 颜色（Tailwind 用的是 oklch）转成 #rrggbb：画一个像素再读回来 */
function toHex(color: string): string | undefined {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return undefined
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

let timer: ReturnType<typeof setTimeout> | undefined
/** 把标题栏的颜色告诉主进程，让右边的窗口按钮用同样的颜色 */
function syncControls() {
  if (!bridge || mac) return
  clearTimeout(timer)
  // 等深浅色切换的过渡结束再取颜色
  timer = setTimeout(() => {
    if (!bar.value) return
    const style = getComputedStyle(bar.value)
    const color = toHex(style.backgroundColor)
    const symbolColor = toHex(style.color)
    if (color && symbolColor) void bridge.rpc('app.setTitleBar', { color, symbolColor }).catch(() => undefined)
  }, 100)
}

// 深浅色切换时 <html> 的 class 会变
const observer = new MutationObserver(syncControls)
onMounted(() => {
  syncControls()
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})
onBeforeUnmount(() => {
  observer.disconnect()
  clearTimeout(timer)
})
</script>

<template>
  <header ref="bar" class="desktop-titlebar fixed inset-x-0 top-0 z-50 h-10 border-b border-default text-muted select-none" />
</template>

<style>
/* 和侧边栏同色（侧边栏是半透明的 bg-elevated/40，这里换成不透明的同色，窗口按钮才能取到一样的颜色）；用来拖动窗口 */
.desktop-titlebar {
  background: color-mix(in oklab, var(--ui-bg-elevated) 40%, var(--ui-bg));
  -webkit-app-region: drag;
  app-region: drag;
}
/* 弹窗、菜单、通知都挂在 body 下面：盖到标题栏上时要能点到 */
body > :not(#app) {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
</style>
