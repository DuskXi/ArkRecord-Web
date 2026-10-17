/**
 * 认名字：结合 OCR 和字形两个信号（实验）。
 *   - OCR（names.ts）：长名字很准，认错一两个字也能按编辑距离纠正；生僻的单字名（例如“黍”“锏”）经常认不出来；
 *   - 字形（visual.ts）：把同星级的候选名字画出来比形状，单字名也能分得开；长名字之间也分得开，
 *     但字体差别大、带符号的名字（例如“凯尔希·思衡托”）相似度偏低。
 * 两个信号一致时最可靠；只有一个有把握时用它；都没把握时给出猜测并标为请确认。
 * 星级只作为偏好：星级不同的候选只有在 OCR 完全一致、字形也像时才会被选上（多半是星星数错了），并标为请确认。
 * 一张截图里每个名字只分配一次：先分配把握大的。
 */
import type { RgbaImage } from './image'
import { editDistance, type NameCandidate } from './names'
import { compareShapes, shapeVector, shapeWidth, similarAspect } from './visual'

export type NameConfidence = 'high' | 'low'

export interface NameResult {
  candidate: NameCandidate | null
  confidence: NameConfidence
  /** OCR 原文 */
  ocr: string
  /** 判断依据（调试、界面提示用） */
  via: 'both' | 'ocr' | 'shape' | 'guess' | 'none'
}

interface Scored {
  candidate: NameCandidate
  ocr: number
  shape: number
  rarityOk: boolean
}

function ocrScore(text: string, name: string): number {
  if (!text) return 0
  const d = editDistance(text, name)
  return Math.max(0, 1 - d / Math.max([...text].length, [...name].length))
}

const clean = (text: string) => text.replace(/[\s|~·•.,，。:：'"`\-_]/g, '')

/**
 * @param crops 每张卡片的名字图（白底黑字、裁到文字范围），与 texts 一一对应
 * @param texts 每张卡片的 OCR 结果
 * @param render 把候选名字画成同样格式的图（结果会被缓存）
 */
export function identifyNames(
  crops: RgbaImage[],
  texts: string[],
  candidates: NameCandidate[],
  rarities: (number | null)[],
  render: (name: string) => RgbaImage,
): NameResult[] {
  const rendered = new Map<string, RgbaImage>()
  const glyphs = (name: string) => {
    let img = rendered.get(name)
    if (!img) rendered.set(name, (img = render(name)))
    return img
  }
  const vectors = new Map<string, Float32Array>()
  const vectorOf = (name: string, w: number) => {
    const key = `${w}:${name}`
    let v = vectors.get(key)
    if (!v) vectors.set(key, (v = shapeVector(glyphs(name), w)))
    return v
  }
  // 每张卡片对每个候选打两个分数。星级只作为偏好：星级不同的候选仍然参与，但不会被判为有把握
  const perCard: Scored[][] = crops.map((crop, i) => {
    const rarity = rarities[i]
    const text = clean(texts[i] ?? '')
    const w = shapeWidth(crop)
    const cropVector = shapeVector(crop, w)
    return candidates.map((candidate) => ({
      candidate,
      rarityOk: !rarity || candidate.rarity === rarity,
      ocr: ocrScore(text, clean(candidate.name)),
      shape: similarAspect(crop, glyphs(candidate.name)) ? compareShapes(cropVector, vectorOf(candidate.name, w)) : -1,
    }))
  })

  // 每张卡片的最佳候选和把握程度
  const proposals = perCard.flatMap((all, card) => {
    const preferred = all.filter((s) => s.rarityOk)
    const list = preferred.length ? preferred : all
    const byShape = list.toSorted((a, b) => b.shape - a.shape)
    const byOcr = list.toSorted((a, b) => b.ocr - a.ocr || b.shape - a.shape)
    const shapeBest = byShape[0]
    const shapeMargin = shapeBest ? shapeBest.shape - (byShape[1]?.shape ?? -1) : 0
    const ocrBest = byOcr[0]
    const ocrMargin = ocrBest ? ocrBest.ocr - (byOcr[1]?.ocr ?? 0) : 0
    const out: { card: number; candidate: NameCandidate; rank: number; via: NameResult['via']; confidence: NameConfidence }[] = []
    for (const s of list) {
      let rank = 0
      let via: NameResult['via'] = 'guess'
      let confidence: NameConfidence = 'low'
      const shapeSure = s === shapeBest && s.shape >= 0.45 && shapeMargin >= 0.1
      const ocrSure = s === ocrBest && s.ocr >= 0.6 && ocrMargin >= 0.2
      if (s.ocr === 1 && s.shape >= 0.1) {
        rank = 4
        via = 'both'
        confidence = 'high'
      } else if (shapeSure && s.ocr > 0) {
        rank = 3.5
        via = 'both'
        confidence = 'high'
      } else if (shapeSure) {
        rank = 3
        via = 'shape'
        confidence = 'high'
      } else if (ocrSure && s.shape >= 0.1) {
        rank = 2.5
        via = 'ocr'
        confidence = 'high'
      } else {
        // 没把握：按两个分数的和排序，作为猜测
        rank = s.ocr + Math.max(0, s.shape)
        if (rank < 0.5) continue
        rank = Math.min(rank, 1.9) / 1.9
      }
      // 星级和星星数不一致：不管多像都请用户确认
      out.push({ card, candidate: s.candidate, rank: rank + s.shape * 0.01, via, confidence: s.rarityOk ? confidence : 'low' })
    }
    if (list === all) return out
    // 星级不同的候选：OCR 完全一致、字形也像时才考虑（多半是星星数错了），一律标为请确认
    for (const s of all) {
      if (s.rarityOk || s.ocr < 1 || s.shape < 0.3) continue
      out.push({ card, candidate: s.candidate, rank: 0.4 + s.shape * 0.01, via: 'ocr', confidence: 'low' })
    }
    return out
  })

  proposals.sort((a, b) => b.rank - a.rank)
  const results: NameResult[] = texts.map((text) => ({ candidate: null, confidence: 'low', ocr: text, via: 'none' }))
  const used = new Set<string>()
  const done = new Set<number>()
  for (const p of proposals) {
    if (done.has(p.card) || used.has(p.candidate.id)) continue
    results[p.card] = { candidate: p.candidate, confidence: p.confidence, ocr: texts[p.card] ?? '', via: p.via }
    done.add(p.card)
    used.add(p.candidate.id)
  }
  return results
}
