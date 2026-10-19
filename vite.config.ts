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

/**
 * 给搜索引擎和 AI 助手的文件（见 public/llms.txt）：
 *   - robots.txt 按环境生成：正式环境欢迎抓取；测试环境要求不收录，避免和正式站内容重复；
 *   - /.well-known/llms.txt：llms.txt 的副本，有的工具会在这里找；
 *   - 测试环境的首页加上 noindex。
 * 正式环境 = 构建时 CLOUDFLARE_ENV=production（deploy-production.yml）。
 */
const readText = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function crawlerFiles(): Plugin {
  const production = process.env.CLOUDFLARE_ENV === 'production'
  const robots = () => readText(production ? './src/crawler/robots.production.txt' : './src/crawler/robots.preview.txt')
  return {
    name: 'arkrecord:crawler-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (path !== '/robots.txt' && path !== '/.well-known/llms.txt') return next()
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(path === '/robots.txt' ? robots() : readText('./public/llms.txt'))
      })
    },
    transformIndexHtml(html, ctx) {
      if (production || ctx.server) return html
      return html.replace('</title>', '</title>\n    <meta name="robots" content="noindex" />')
    },
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots() })
      this.emitFile({ type: 'asset', fileName: '.well-known/llms.txt', source: readText('./public/llms.txt') })
    },
  }
}

export default defineConfig(({ mode }) => {
  /**
   * 桌面版（vite build --mode desktop、npm run desktop:dev）：页面由 Electron 加载，请求交给本机的 Python 后端，
   * 不经过 Worker，所以不加载 cloudflare() 和给搜索引擎的文件；产物放在 Electron 主进程旁边。见 desktop/README.md。
   */
  const desktop = mode === 'desktop'
  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_COMMIT__: JSON.stringify(process.env.GITHUB_SHA ?? 'dev'),
      __OCR_BASE__: JSON.stringify(OCR_BASE),
    },
    plugins: [
      vue(),
      ocrAssets(),
      ...(desktop ? [] : [crawlerFiles()]),
      ui({
        ui: {
          colors: { primary: 'sky', neutral: 'zinc' },
        },
        // 构建时扫描源码，把用到的图标打包进产物，运行时不再请求 Iconify 的在线接口（国内慢，也无法离线）。
        icon: { clientBundle: { scan: { globInclude: ['src/**/*.{vue,ts}'] } } },
      }),
      // 本地开发时由这个插件在 Vite 里运行 worker/index.ts，/api/* 与页面同源，和线上一致。
      ...(desktop ? [] : [cloudflare()]),
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    // 关闭开发服务器自带的 CORS，让本地行为与线上一致（/api/* 只接受同源请求）
    server: { cors: false },
    preview: { cors: false },
    build: {
      chunkSizeWarningLimit: 1200,
      ...(desktop ? { outDir: 'desktop/electron/dist/renderer', emptyOutDir: true } : {}),
    },
  }
})
