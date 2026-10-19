import { describe, expect, it } from 'vitest'
import { alreadySent, userHash } from './sync-user-stats'

const ID = '0123456789abcdef0123456789abcdef' // 假的同步识别码
const NOON = Date.parse('2026-10-16T12:00:00+08:00')

describe('同步识别码的统计', () => {
  it('上报加了前缀的 SHA-256，不上报识别码本身', async () => {
    const hash = await userHash(ID)
    // 和桌面版 Python 后端的 user_hash 一致（同一个人网页版、桌面版都用时，服务器上只算一次）
    expect(hash).toBe('5d4cf0e3d5499b08c735e6effd49a9b462c4aa9d0a09270333cca92198832512')
    expect(hash).not.toContain(ID)
    expect(await userHash(ID)).toBe(hash)
    expect(await userHash('f'.repeat(32))).not.toBe(hash)
  })

  it('每天一次（北京时间）；识别码换了当天也报新的', () => {
    expect(alreadySent(null, ID, NOON)).toBe(false)
    expect(alreadySent({ day: '2026-10-16', id: ID }, ID, NOON)).toBe(true)
    expect(alreadySent({ day: '2026-10-16', id: ID }, 'f'.repeat(32), NOON)).toBe(false)
    expect(alreadySent({ day: '2026-10-15', id: ID }, ID, NOON)).toBe(false)
    // 北京时间第二天零点之后
    expect(alreadySent({ day: '2026-10-16', id: ID }, ID, Date.parse('2026-10-17T00:30:00+08:00'))).toBe(false)
  })
})
