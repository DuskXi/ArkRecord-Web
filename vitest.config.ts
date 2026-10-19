import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_COMMIT__: JSON.stringify(process.env.GITHUB_SHA ?? 'dev'), __OCR_BASE__: JSON.stringify('/ocr/test/'), __DESKTOP__: 'false' },
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts', 'shared/**/*.test.ts', 'scripts/**/*.test.ts', 'desktop/electron/**/*.test.ts'],
    environment: 'node',
  },
})
