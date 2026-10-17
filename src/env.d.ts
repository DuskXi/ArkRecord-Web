/// <reference types="vite/client" />

declare const __APP_VERSION__: string
/** 构建时写入的 commit（GitHub Actions 的 GITHUB_SHA；本地开发为 dev） */
declare const __BUILD_COMMIT__: string
/** 文字识别（Tesseract.js）文件在本站的路径，带版本号，见 vite.config.ts 的 ocrAssets */
declare const __OCR_BASE__: string
