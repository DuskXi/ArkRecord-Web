import { describe, expect, it } from 'vitest'
import { DEMO_ACCOUNT_ID } from './demo-account'
import { buildPing, gamesForUsage } from './usage'

const NOON = Date.parse('2026-10-16T12:00:00+08:00')
const DAY = 86_400_000

describe('匿名使用统计的本地去重', () => {
  it('第一次打开：新浏览器、本月首次', () => {
    expect(buildPing(['arknights'], null, NOON)).toEqual({
      ping: { first: true, newMonth: true, games: ['arknights'], newGames: ['arknights'] },
      next: { day: '2026-10-16', month: '2026-10', games: ['arknights'] },
    })
  })

  it('同一天再打开不上报；加了新游戏的账号时补报一次', () => {
    const state = { day: '2026-10-16', month: '2026-10', games: ['arknights' as const] }
    expect(buildPing(['arknights'], state, NOON)).toBeNull()
    expect(buildPing(['arknights', 'endfield'], state, NOON)?.ping).toEqual({
      first: false,
      newMonth: false,
      games: ['arknights', 'endfield'],
      newGames: ['endfield'],
    })
  })

  it('第二天、下个月', () => {
    const state = { day: '2026-10-16', month: '2026-10', games: [] }
    expect(buildPing([], state, NOON + DAY)?.ping).toEqual({ first: false, newMonth: false, games: [], newGames: [] })
    expect(buildPing([], state, NOON + 20 * DAY)?.ping.newMonth).toBe(true)
  })

  it('演示账号不算作“有这个游戏的账号”', () => {
    expect(gamesForUsage([{ id: DEMO_ACCOUNT_ID, game: 'arknights' }])).toEqual([])
    expect(gamesForUsage([{ id: DEMO_ACCOUNT_ID, game: 'arknights' }, { id: 'endfield:123', game: 'endfield' }])).toEqual(['endfield'])
    expect(gamesForUsage([{ id: 'arknights:456', game: 'arknights' }])).toEqual(['arknights'])
  })
})
