import { fileURLToPath, URL } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    ui({
      ui: {
        colors: { primary: 'sky', neutral: 'zinc' },
      },
      // 构建时扫描源码，把用到的图标打包进产物，运行时不再请求 Iconify 的在线接口（国内慢，也无法离线）。
      icon: { clientBundle: { scan: true } },
    }),
    // 本地开发时由这个插件在 Vite 里运行 worker/index.ts，/api/* 与页面同源，和线上一致。
    cloudflare(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
})
