/**
 * 截图识别的计算部分放在 Web Worker 里，长截图（1440×10000 以上）找网格要一两秒，不卡住页面。
 * 无状态：每个请求带上需要的数据，结果用 Transferable 传回。
 */
import { identifyNames, type NameResult } from './identify'
import type { RgbaImage } from './image'
import type { NameCandidate } from './names'
import { analyzeScreenshot, type AnalyzedScreenshot, type ScreenshotGame } from './pipeline'

export type WorkerRequest =
  | { id: number; type: 'analyze'; game: ScreenshotGame; image: RgbaImage }
  | { id: number; type: 'identify'; crops: RgbaImage[]; texts: string[]; candidates: NameCandidate[]; glyphs: Record<string, RgbaImage> }

export type WorkerResponse =
  | { id: number; type: 'analyze'; result: AnalyzedScreenshot }
  | { id: number; type: 'identify'; result: NameResult[] }
  | { id: number; type: 'error'; message: string }

const BLANK: RgbaImage = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) }

function buffersOf(result: AnalyzedScreenshot): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  for (const c of result.cards) {
    out.push(c.crop.data.buffer as ArrayBuffer)
    if (c.ocrInput) out.push(c.ocrInput.data.buffer as ArrayBuffer)
  }
  return out
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  try {
    if (req.type === 'analyze') {
      const result = analyzeScreenshot(req.image, req.game)
      const reply: WorkerResponse = { id: req.id, type: 'analyze', result }
      ;(self as unknown as Worker).postMessage(reply, buffersOf(result))
      return
    }
    const result = identifyNames(
      req.crops,
      req.texts,
      req.candidates,
      // 只按名字认：不用星级缩小范围
      req.crops.map(() => null),
      (name) => req.glyphs[name] ?? BLANK,
    )
    const reply: WorkerResponse = { id: req.id, type: 'identify', result }
    ;(self as unknown as Worker).postMessage(reply, [])
  } catch (error) {
    const reply: WorkerResponse = { id: req.id, type: 'error', message: error instanceof Error ? error.message : String(error) }
    ;(self as unknown as Worker).postMessage(reply, [])
  }
})
