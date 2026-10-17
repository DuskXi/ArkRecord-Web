/**
 * OCR 结果 → 干员名（实验）。名字是有限的已知集合（游戏数据表），所以不需要 OCR 完全认对：
 * 按编辑距离找最接近的候选，再用识别出的星级缩小范围。
 */

export interface NameCandidate {
  id: string
  name: string
  rarity: number
}

export interface NameMatch {
  candidate: NameCandidate
  /** 编辑距离 */
  distance: number
  /** 0–1，1 为完全一致 */
  score: number
  /** 第二接近的候选的分数（两者接近时说明不确定） */
  runnerUp: number
}

export function editDistance(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[y.length]!
}

export function matchName(text: string, candidates: NameCandidate[], rarity?: number | null): NameMatch | null {
  const cleaned = text.replace(/[\s|~·•.,，。:：'"`-]/g, '')
  if (!cleaned) return null
  const pool = rarity ? candidates.filter((c) => c.rarity === rarity) : candidates
  const scored = (pool.length ? pool : candidates)
    .map((candidate) => {
      const distance = editDistance(cleaned, candidate.name)
      const score = 1 - distance / Math.max([...cleaned].length, [...candidate.name].length)
      return { candidate, distance, score }
    })
    .toSorted((a, b) => b.score - a.score || a.distance - b.distance)
  const best = scored[0]
  if (!best || best.score <= 0) return null
  return { ...best, runnerUp: scored[1]?.score ?? 0 }
}

/**
 * 一张截图里每个干员最多出现一次：先给最有把握的卡片分配名字，已经分配出去的名字不再用。
 * 例如“礼”同样接近“祀”和“别礼”，而“别礼”已经被另一张卡片完全一致地认出，就分给“祀”。
 */
export function assignNames(texts: string[], candidates: NameCandidate[], rarities: (number | null)[] = []): (NameMatch | null)[] {
  const pairs: { card: number; match: NameMatch }[] = []
  texts.forEach((text, card) => {
    const cleaned = text.replace(/[\s|~·•.,，。:：'"`-]/g, '')
    if (!cleaned) return
    const rarity = rarities[card]
    const pool = rarity ? candidates.filter((c) => c.rarity === rarity) : candidates
    for (const candidate of pool.length ? pool : candidates) {
      const distance = editDistance(cleaned, candidate.name)
      const length = [...cleaned].length
      let score = 1 - distance / Math.max(length, [...candidate.name].length)
      // 字数相同、每个字都认错（例如单字名“祀”认成“礼”）时，只作为最后的选择
      if (score <= 0 && length === [...candidate.name].length) score = 0.01
      if (score > 0) pairs.push({ card, match: { candidate, distance, score, runnerUp: 0 } })
    }
  })
  pairs.sort((a, b) => b.match.score - a.match.score || a.match.distance - b.match.distance)
  const result: (NameMatch | null)[] = texts.map(() => null)
  const used = new Set<string>()
  for (const { card, match } of pairs) {
    if (result[card] || used.has(match.candidate.id)) continue
    result[card] = match
    used.add(match.candidate.id)
  }
  return result
}
