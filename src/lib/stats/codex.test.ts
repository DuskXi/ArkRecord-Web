import { describe, expect, it } from 'vitest'
import type { AkMeta, EfMeta } from '../meta'
import { akCodexItems, buildCodex, efCodexItems, summarizeCodex } from './codex'
import type { PullEvent } from './events'

function ev(ts: number, itemId: string | null, name: string, star: number, isUp: boolean | null = null): PullEvent {
  return {
    key: `${ts}:${name}`,
    ts,
    order: 0,
    star,
    itemId,
    name,
    poolId: null,
    poolName: '',
    ruleType: 'NORMAL',
    family: 'standard',
    familyLabel: '',
    isolated: false,
    mainModel: true,
    isNew: false,
    countsForPity: true,
    isUp,
    weapon: false,
  }
}

const meta: AkMeta = {
  version: '',
  generatedAt: '',
  upAvailable: true,
  chars: {
    char_103_angel: { n: '能天使', r: 6, p: 'SNIPER', o: '招募寻访' },
    char_474_glady: { n: '歌蕾蒂娅', r: 6, p: 'SPECIAL', o: '活动获得' },
    char_4131_odda: { n: '奥达', r: 5, p: 'WARRIOR', o: '活动获得' },
    char_123_fang: { n: '芬', r: 3, p: 'PIONEER', o: '招募寻访' },
    char_009_12fce: { n: '12F', r: 2, p: 'CASTER', o: '招募寻访' },
    char_504_rguard: { n: '预备干员-近战', r: 3, p: 'WARRIOR', x: 1 },
  },
  pools: { LIMITED_1: { n: '限定', t: 'LIMITED', o: 0, e: 1, up: { '6': ['char_474_glady'] } } },
  avatars: [],
}

describe('明日方舟图鉴的干员范围', () => {
  it('只列 3★ 以上、可以获得的干员；当过 UP 的活动干员也算寻访可得', () => {
    const items = akCodexItems(meta)
    expect(items.map((i) => i.id).toSorted()).toEqual(['char_103_angel', 'char_123_fang', 'char_4131_odda', 'char_474_glady'])
    expect(Object.fromEntries(items.map((i) => [i.name, i.gacha]))).toEqual({ 能天使: true, 歌蕾蒂娅: true, 奥达: false, 芬: true })
  })
})

describe('对应寻访记录', () => {
  it('按 ID 对应；没有 ID 的旧版记录按名称对应；统计次数、UP 次数和首次 / 最近获得时间', () => {
    const codex = buildCodex(akCodexItems(meta), [
      ev(300, 'char_103_angel', '能天使', 6, true),
      ev(100, null, '能天使', 6, false),
      ev(200, 'char_123_fang', '芬', 3),
    ])
    const angel = codex.find((c) => c.id === 'char_103_angel')!
    expect(angel).toMatchObject({ count: 2, up: 1, firstTs: 100, lastTs: 300 })
    expect(codex.find((c) => c.id === 'char_474_glady')).toMatchObject({ count: 0, firstTs: null })
    // 星级高的在前
    expect(codex.map((c) => c.star)).toEqual([6, 6, 5, 3])
  })

  it('图鉴里没有的角色（元数据还没更新）也列出来，抽到过的“其他途径”干员改为寻访可得', () => {
    const codex = buildCodex(akCodexItems(meta), [ev(1, 'char_9999_new', '新干员', 6), ev(2, 'char_4131_odda', '奥达', 5)])
    expect(codex.find((c) => c.name === '新干员')).toMatchObject({ id: 'char_9999_new', count: 1, gacha: true })
    expect(codex.find((c) => c.name === '奥达')).toMatchObject({ gacha: true, count: 1 })
  })

  it('收集进度只算寻访可得的干员', () => {
    const codex = buildCodex(akCodexItems(meta), [ev(1, 'char_103_angel', '能天使', 6)])
    expect(summarizeCodex(codex)).toEqual([
      { star: 6, total: 2, owned: 1 },
      { star: 5, total: 0, owned: 0 },
      { star: 3, total: 1, owned: 0 },
    ])
  })
})

describe('终末地图鉴', () => {
  const ef: EfMeta = {
    generatedAt: '',
    pools: {},
    items: {
      chr_0002_endminm: { n: '管理员', r: 6 },
      chr_0016_laevat: { n: '莱万汀', r: 6 },
      chr_0019_karin: { n: '秋栗', r: 4 },
      wpn_0001_x: { n: '某武器', r: 6 },
      wpn_0002_y: { n: '基础武器', r: 3 },
    },
  }
  it('角色不含主角；武器只列 4★ 以上', () => {
    expect(efCodexItems(ef, false).map((i) => i.name)).toEqual(['莱万汀', '秋栗'])
    expect(efCodexItems(ef, true).map((i) => i.name)).toEqual(['某武器'])
  })
})
