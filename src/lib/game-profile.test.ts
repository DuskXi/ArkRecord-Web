import { describe, expect, it } from 'vitest'
import { HG_PROFILES, starsFrom } from './game-profile'
import { arknightsRate, endfieldRate } from './stats/pity'
import { AK_PRESETS, EF_PRESETS } from './stats/planner'

// 档案替代了页面里“明日方舟 / 终末地”的分支：这里核对和原来写死的值一样
describe('HG_PROFILES', () => {
  const ak = HG_PROFILES.arknights
  const ef = HG_PROFILES.endfield

  it('名称、星级和叫法', () => {
    expect([ak.label, ak.topStar, ak.topTerm, ak.playerTitle, ak.reportTitle]).toEqual(['明日方舟', 6, '出金', 'DOCTOR', 'RHODES ISLAND'])
    expect([ef.label, ef.topStar, ef.topTerm, ef.playerTitle, ef.reportTitle]).toEqual(['终末地', 6, '出红', 'ENDMINISTRATOR', 'ENDFIELD'])
    expect(ak.stars).toEqual([6, 5, 4, 3])
    expect(ef.stars).toEqual([6, 5, 4])
  })

  it('记录的叫法、角色 / 武器切换、没有记录时的提示', () => {
    expect([ak.recordName, ef.recordName]).toEqual(['寻访记录', '寻访记录'])
    expect([ak.hasScope, ef.hasScope]).toEqual([false, true])
    expect(ak.emptyHint).toEqual({ description: '点击右上角的“同步”从鹰角服务器拉取最近 90 天的记录，或在“数据”页导入旧数据。', importLink: true })
    expect(ef.emptyHint).toEqual(ak.emptyHint)
  })

  it('保底卡片的标题、UP 统计的说法', () => {
    expect([ak.guaranteeTitle, ef.guaranteeTitle]).toEqual(['定向保底与累计奖励', '定向保底与累计奖励'])
    expect([ak.fiftyFifty, ef.fiftyFifty]).toEqual([false, false])
    expect(ak.upUnknownNote).toBe('没有可以判断是否为 UP 的 6★（需要卡池的 UP 名单）。')
  })

  it('从最高星往下的星级', () => {
    expect(starsFrom(6)).toEqual([6, 5, 4, 3])
    expect(starsFrom(5)).toEqual([5, 4, 3])
  })

  it('只有明日方舟有源石记录和资源换算；赠送的说明', () => {
    expect([ak.hasLedger, ef.hasLedger]).toEqual([true, false])
    expect([ak.planner?.resources, ef.planner?.resources]).toEqual([true, false])
    expect(ak.giftNote).toBe('限定池累计 300 抽赠送')
    expect(ef.giftNote).toBe('信物赠礼，潜能 +1')
  })

  it('总览的抽数说明', () => {
    expect(ak.spendNote(10)).toBe('约 6,000 合成玉')
    expect(ef.spendNote(10)).toBe('含免费十连，不含赠送')
  })

  it('卡池筛选', () => {
    expect(ak.poolFilters.map((f) => f.label)).toEqual(['全部', '限定 / 联动', '标准', '中坚'])
    expect(ef.poolFilters.map((f) => f.label)).toEqual(['全部', '特许 / 重构', '基础', '武器'])
  })

  it('期望的星级占比', () => {
    expect(ak.rarityRates(0.03)).toEqual({ 6: 0.03, 5: 0.08, 4: 0.5, 3: 0.42 - 0.03 })
    expect(ef.rarityRates(0.03)).toEqual({ 6: 0.03, 5: 0.08, 4: 0.92 - 0.03, 3: 0 })
  })

  it('图鉴和抽卡规划', () => {
    expect([ak.codex?.professionFilter, ef.codex?.professionFilter]).toEqual([true, false])
    expect([ak.codex?.potential, ef.codex?.potential]).toEqual([false, true])
    expect(ak.planner).toMatchObject({ presets: AK_PRESETS, rate: arknightsRate, includeIsolated: true })
    expect(ef.planner).toMatchObject({ presets: EF_PRESETS, rate: endfieldRate, includeIsolated: false })
  })
})
