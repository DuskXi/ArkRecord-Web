/**
 * 在浏览器里识别森空岛 App 的干员列表截图（主线程部分）。截图不上传，全部在这台设备上完成：
 *   1. 解码图片（canvas）；
 *   2. Web Worker 里找卡片、读终末地潜能、裁出名字（pipeline.ts）；
 *   3. Tesseract 认字（ocr.ts）；
 *   4. 把候选名字用 canvas 画出来（MiSans），Web Worker 里结合 OCR 和字形认名字（identify.ts）。
 * 只按名字认干员，星级从游戏数据里查，不从截图里读。认不出、把握不大的交给用户在界面上选。
 */
import { clean, type NameResult } from './identify'
import type { Rect, RgbaImage } from './image'
import type { NameCandidate } from './names'
import { createOcr, type Ocr } from './ocr'
import { trimInk, type AnalyzedScreenshot, type ScreenshotGame } from './pipeline'
import type { WorkerRequest, WorkerResponse } from './recognize.worker'

export interface RecognizedCard {
  /** 在这张截图里的序号（从左到右、从上到下） */
  index: number
  rect: Rect
  /** 卡片缩略图（data URL），核对用 */
  thumb: string
  /** 终末地潜能 0–5；明日方舟为 null */
  potential: number | null
  potentialConfidence: 'high' | 'low' | null
  /** OCR 原文 */
  ocr: string
  candidate: NameCandidate | null
  confidence: 'high' | 'low'
  via: NameResult['via']
}

export interface RecognizedScreenshot {
  width: number
  height: number
  /** 解码时缩小过（图片面积超过浏览器 canvas 的上限） */
  scaled: boolean
  cardWidth: number
  cards: RecognizedCard[]
}

export type RecognizeStage = 'decode' | 'cards' | 'ocr-load' | 'ocr' | 'names'

export interface RecognizeProgress {
  stage: RecognizeStage
  done?: number
  total?: number
}

/** iOS Safari 的 canvas 面积上限约 1677 万像素 */
const MAX_AREA = 16_000_000
const THUMB_WIDTH = 120
const GLYPH_FONT = '500 40px "MiSans VF", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'

async function decode(file: Blob): Promise<{ canvas: HTMLCanvasElement; scaled: boolean }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('无法读取这张图片，请上传 PNG 或 JPEG 截图。')
  }
  const area = bitmap.width * bitmap.height
  const scale = area > MAX_AREA ? Math.sqrt(MAX_AREA / area) : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('浏览器不支持 canvas')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return { canvas, scaled: scale < 1 }
}

function thumbnail(source: HTMLCanvasElement, rect: Rect): string {
  const canvas = document.createElement('canvas')
  canvas.width = THUMB_WIDTH
  canvas.height = Math.max(1, Math.round((THUMB_WIDTH * rect.height) / rect.width))
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

/** 把候选名字画成白底黑字、裁到文字范围的图（和截图里裁出的名字同样格式） */
async function renderGlyphs(names: readonly string[]): Promise<Record<string, RgbaImage>> {
  // 只下载用到的字（MiSans 按字符范围分包）；字体加载不了就用系统字体
  await Promise.race([document.fonts?.load(GLYPH_FONT, names.join('')).catch(() => undefined), new Promise((r) => setTimeout(r, 5000))])
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('浏览器不支持 canvas')
  const out: Record<string, RgbaImage> = {}
  for (const name of names) {
    canvas.width = 44 * [...name].length + 40
    canvas.height = 60
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.font = GLYPH_FONT
    ctx.fillStyle = '#000'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(name, 10, 44)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    out[name] = trimInk({ width: data.width, height: data.height, data: data.data })
  }
  return out
}

/**
 * 识别器：一次导入（可能有多张截图）共用一个 Web Worker、一个 OCR 引擎和一份画好的候选名字。用完调用 dispose()。
 */
export class ScreenshotRecognizer {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>()
  private ocr: Promise<Ocr> | null = null
  private glyphs: Promise<Record<string, RgbaImage>> | null = null

  constructor(
    private readonly game: ScreenshotGame,
    private readonly candidates: NameCandidate[],
  ) {
    this.worker = new Worker(new URL('./recognize.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const waiting = this.pending.get(event.data.id)
      if (!waiting) return
      this.pending.delete(event.data.id)
      if (event.data.type === 'error') waiting.reject(new Error(event.data.message))
      else waiting.resolve(event.data)
    })
    this.worker.addEventListener('error', (event) => {
      for (const waiting of this.pending.values()) waiting.reject(new Error(event.message || '识别出错'))
      this.pending.clear()
    })
  }

  private call(request: WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ ...request, id }, transfer)
    })
  }

  /** 提前加载 OCR（下载模型约 2 MB，第一次之后从浏览器缓存读取） */
  loadOcr(onProgress?: (progress: number) => void): Promise<Ocr> {
    this.ocr ??= createOcr((status, progress) => {
      if (status.startsWith('loading')) onProgress?.(progress)
    }).catch((error: unknown) => {
      this.ocr = null
      throw error
    })
    return this.ocr
  }

  async recognize(file: Blob, onProgress?: (p: RecognizeProgress) => void): Promise<RecognizedScreenshot> {
    onProgress?.({ stage: 'decode' })
    const { canvas, scaled } = await decode(file)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)

    onProgress?.({ stage: 'cards' })
    const analyzed = (await this.call(
      { type: 'analyze', game: this.game, image: { width: pixels.width, height: pixels.height, data: pixels.data } },
      [pixels.data.buffer],
    )) as Extract<WorkerResponse, { type: 'analyze' }>
    const result: AnalyzedScreenshot = analyzed.result
    const thumbs = result.cards.map((c) => thumbnail(canvas, c.rect))
    const size = { width: canvas.width, height: canvas.height }
    // 释放大图
    canvas.width = 0
    canvas.height = 0
    if (!result.cards.length) return { ...size, scaled, cardWidth: 0, cards: [] }

    onProgress?.({ stage: 'ocr-load' })
    const ocr = await this.loadOcr((p) => onProgress?.({ stage: 'ocr-load', done: p, total: 1 }))
    const texts: string[] = []
    for (const [i, card] of result.cards.entries()) {
      onProgress?.({ stage: 'ocr', done: i, total: result.cards.length })
      texts.push(card.ocrInput ? (await ocr.recognize(card.ocrInput)).text : '')
    }

    onProgress?.({ stage: 'names' })
    this.glyphs ??= renderGlyphs([...new Set(this.candidates.map((c) => c.name))])
    // OCR 认出的字也画出来：认错的字多半和原来的字长得像（见 identify.ts）
    const textGlyphs = await renderGlyphs([...new Set(texts.map(clean).filter(Boolean))])
    const glyphs = { ...textGlyphs, ...(await this.glyphs) }
    const named = (await this.call({
      type: 'identify',
      crops: result.cards.map((c) => c.crop),
      texts,
      candidates: this.candidates,
      glyphs,
    })) as Extract<WorkerResponse, { type: 'identify' }>

    return {
      ...size,
      scaled,
      cardWidth: result.cardWidth,
      cards: result.cards.map((card, index) => {
        const name = named.result[index]!
        return {
          index,
          rect: card.rect,
          thumb: thumbs[index] ?? '',
          potential: card.potential,
          potentialConfidence: card.potentialConfidence,
          ocr: name.ocr,
          candidate: name.candidate,
          confidence: name.confidence,
          via: name.via,
        }
      }),
    }
  }

  dispose(): void {
    this.worker.terminate()
    for (const waiting of this.pending.values()) waiting.reject(new Error('已取消'))
    this.pending.clear()
    void this.ocr?.then((o) => o.terminate()).catch(() => undefined)
    this.ocr = null
  }
}
