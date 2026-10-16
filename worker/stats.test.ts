import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { initSchema, parsePing, readSummary, recordPing, type SqlLike } from './stats'

/** 用 node:sqlite 模拟 Durable Object 的 ctx.storage.sql */
function memorySql(): SqlLike {
  const db = new DatabaseSync(':memory:')
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query)
      if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...bindings) }
      statement.run(...bindings)
      return { toArray: () => [] }
    },
  }
}

/** 2026-10-16 12:00 北京时间 */
const NOON = Date.parse('2026-10-16T12:00:00+08:00')
const DAY = 86_400_000

describe('上报内容校验', () => {
  it('只接受布尔值和白名单内的游戏名', () => {
    expect(parsePing({ first: true, newMonth: true, games: ['arknights'], newGames: ['arknights'] })).toEqual({
      first: true,
      newMonth: true,
      games: ['arknights'],
      newGames: ['arknights'],
    })
    expect(parsePing({ first: 'yes', newMonth: true, games: [], newGames: [] })).toBeNull()
    expect(parsePing({ first: true, newMonth: true, games: ['genshin'], newGames: [] })).toBeNull()
    expect(parsePing({ first: true, newMonth: true, games: [], newGames: ['endfield'] })).toBeNull()
    expect(parsePing({ first: true, newMonth: true, games: ['arknights', 'arknights', 'endfield'], newGames: [] })).toBeNull()
    expect(parsePing(null)).toBeNull()
  })

  it('不保留请求里的其他字段', () => {
    const ping = parsePing({ first: false, newMonth: false, games: [], newGames: [], uid: '123', token: 'x' })
    expect(Object.keys(ping!).toSorted()).toEqual(['first', 'games', 'newGames', 'newMonth'])
  })
})

describe('计数器', () => {
  it('累计人数、各游戏人数、今日活跃与新增、本月活跃', () => {
    const sql = memorySql()
    initSchema(sql)
    // 浏览器 A：第一次使用，有明日方舟账号
    recordPing(sql, { first: true, newMonth: true, games: ['arknights'], newGames: ['arknights'] }, NOON)
    // 浏览器 B：第一次使用，没有账号
    recordPing(sql, { first: true, newMonth: true, games: [], newGames: [] }, NOON)
    // 浏览器 C：老用户，本月第一次来，新加了终末地账号
    recordPing(sql, { first: false, newMonth: true, games: ['arknights', 'endfield'], newGames: ['endfield'] }, NOON)
    expect(readSummary(sql, NOON)).toEqual({
      users: 2,
      games: { arknights: 1, endfield: 1 },
      today: 3,
      todayNew: 2,
      month: 3,
      day: '2026-10-16',
    })
  })

  it('按北京时间分日；第二天的“今日”重新计数，累计与本月保留', () => {
    const sql = memorySql()
    initSchema(sql)
    recordPing(sql, { first: true, newMonth: true, games: [], newGames: [] }, NOON)
    // 浏览器 A 第二天又来了（浏览器本地已记录本月来过）
    recordPing(sql, { first: false, newMonth: false, games: [], newGames: [] }, NOON + DAY)
    expect(readSummary(sql, NOON + DAY)).toMatchObject({ users: 1, today: 1, todayNew: 0, month: 1, day: '2026-10-17' })
    // 北京时间 23:59 与次日 00:01 属于不同的日期
    const lateNight = Date.parse('2026-10-31T23:59:00+08:00')
    recordPing(sql, { first: false, newMonth: false, games: [], newGames: [] }, lateNight)
    recordPing(sql, { first: false, newMonth: true, games: [], newGames: [] }, lateNight + 2 * 60_000)
    expect(readSummary(sql, lateNight).today).toBe(1)
    expect(readSummary(sql, lateNight + 2 * 60_000)).toMatchObject({ today: 1, month: 1, day: '2026-11-01' })
  })

  it('建表可以重复执行', () => {
    const sql = memorySql()
    initSchema(sql)
    initSchema(sql)
    expect(readSummary(sql, NOON).users).toBe(0)
  })
})
