/**
 * 文字识别：Tesseract.js（简体中文 chi_sim，4.0.0_best_int）。
 *
 * 引擎（worker、WASM）和中文模型都由本站提供（构建时从 npm 包复制到 /ocr/，见 vite.config.ts 的 ocrAssets），
 * 不请求外部 CDN；模型第一次下载后由 Tesseract.js 缓存在浏览器的 IndexedDB 里。
 * 只在用户打开截图导入时才加载。
 */
import type { RgbaImage } from './image'

export interface OcrResult {
  text: string
  /** 0–100 */
  confidence: number
}

export interface Ocr {
  recognize(img: RgbaImage): Promise<OcrResult>
  terminate(): Promise<void>
}

/** 本站提供的文件路径（带版本号，可以长期缓存） */
export const OCR_BASE = __OCR_BASE__

/** progress：0–1，加载引擎和下载模型的进度 */
export async function createOcr(onProgress?: (status: string, progress: number) => void): Promise<Ocr> {
  const { createWorker, OEM, PSM } = await import('tesseract.js')
  const worker = await createWorker('chi_sim', OEM.LSTM_ONLY, {
    workerPath: `${OCR_BASE}worker.min.js`,
    corePath: `${OCR_BASE}core`,
    langPath: `${OCR_BASE}lang`,
    gzip: true,
    // 直接从本站加载 worker（不经过 blob: URL）
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => onProgress?.(m.status, m.progress),
  })
  // 名字是单独一行
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 canvas')
  return {
    async recognize(img) {
      canvas.width = img.width
      canvas.height = img.height
      ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
      const { data } = await worker.recognize(canvas)
      return { text: data.text.trim().replace(/\s+/g, ''), confidence: data.confidence }
    },
    async terminate() {
      await worker.terminate()
    },
  }
}
