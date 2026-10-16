import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { generateDemoPulls } from './demo'
import type { AkMeta } from './meta'
import { analyze } from './stats/analyze'
import { normalizeArknights } from './stats/events'
import { arknightsRate, distribution } from './stats/pity'

describe('演示数据', () => {
  it('按保底规则生成：任何分组的单个 6★ 都不超过 99 抽', () => {
    let meta: AkMeta
    try {
      meta = JSON.parse(readFileSync('public/gamedata/ak-meta.json', 'utf8')) as AkMeta
    } catch {
      return // 未生成游戏数据时跳过
    }
    const pulls = generateDemoPulls(meta, Date.parse('2026-10-16T00:00:00Z'))
    const result = analyze(normalizeArknights(pulls, meta), { dist: distribution(arknightsRate), softPity: 50, hardPity: 99 })
    expect(result.total).toBeGreaterThan(100)
    expect(Math.max(...result.hits.map((h) => h.pity))).toBeLessThanOrEqual(99)
  })
})
