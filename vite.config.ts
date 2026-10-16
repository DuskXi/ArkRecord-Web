import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    vue(),
    ui({
      ui: {
        colors: { primary: 'sky', neutral: 'zinc' },
      },
      // 构建时扫描源码，把用到的图标打包进产物，运行时不再请求 Iconify 的在线接口（国内慢，也无法离线）。
      icon: { clientBundle: { scan: { globInclude: ['src/**/*.{vue,ts}'] } } },
    }),
    // 本地开发时由这个插件在 Vite 里运行 worker/index.ts，/api/* 与页面同源，和线上一致。
    cloudflare(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // 关闭开发服务器自带的 CORS，让本地行为与线上一致（/api/* 只接受同源请求）
  server: { cors: false },
  preview: { cors: false },
  build: {
    chunkSizeWarningLimit: 1200,
  },
})
