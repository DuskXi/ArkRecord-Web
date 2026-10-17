import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

const modulePath = (path: string) => fileURLToPath(new URL(`./node_modules/${path}`, import.meta.url))
const versionOf = (name: string) => (JSON.parse(readFileSync(modulePath(`${name}/package.json`), 'utf8')) as { version: string }).version

/**
 * 截图识别用的文字识别引擎（Tesseract.js）和简体中文模型：由本站提供，不请求外部 CDN（CSP 只允许本站脚本）。
 * 路径带版本号，可以长期缓存；开发时直接从 node_modules 读取，构建时复制到产物里。
 */
const OCR_BASE = `/ocr/${versionOf('tesseract.js')}-${versionOf('tesseract.js-core')}/`
const OCR_FILES: Record<string, string> = {
  'worker.min.js': modulePath('tesseract.js/dist/worker.min.js'),
  // 只用 LSTM 引擎：支持 SIMD 的浏览器用 simd 版，否则用普通版（由 Tesseract.js 自己选择）
  'core/tesseract-core-simd-lstm.wasm.js': modulePath('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'),
  'core/tesseract-core-lstm.wasm.js': modulePath('tesseract.js-core/tesseract-core-lstm.wasm.js'),
  'lang/chi_sim.traineddata.gz': modulePath('@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz'),
}

function ocrAssets(): Plugin {
  return {
    name: 'arkrecord:ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? ''
        const file = path.startsWith(OCR_BASE) ? OCR_FILES[path.slice(OCR_BASE.length)] : undefined
        if (!file) return next()
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/gzip')
        res.end(readFileSync(file))
      })
    },
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle() {
      for (const [name, file] of Object.entries(OCR_FILES)) {
        this.emitFile({ type: 'asset', fileName: `${OCR_BASE.slice(1)}${name}`, source: readFileSync(file) })
      }
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(process.env.GITHUB_SHA ?? 'dev'),
    __OCR_BASE__: JSON.stringify(OCR_BASE),
  },
  plugins: [
    vue(),
    ocrAssets(),
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
