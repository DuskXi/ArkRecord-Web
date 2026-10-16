import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { hashToken, initFeedbackSchema, insertFeedback, newFeedbackId, newFeedbackToken, parseFeedback, type SqlLike } from './feedback'

/** 用 node:sqlite 模拟 Durable Object 的 ctx.storage.sql */
function memorySql(): SqlLike & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  return {
    db,
    exec(query, ...bindings) {
      const statement = db.prepare(query)
      if (/^\s*select/i.test(query)) return { toArray: () => statement.all(...bindings) }
      statement.run(...bindings)
      return { toArray: () => [] }
    },
  }
}

describe('反馈内容校验', () => {
  it('只保留白名单内的字段，去掉首尾空白；无效的版本号、游戏名置空', () => {
    expect(parseFeedback({ category: 'suggestion', message: '  希望加上武器图鉴  ', contact: '  ', appVersion: '1.0.0', game: 'endfield', uid: '1' })).toEqual({
      category: 'suggestion',
      message: '希望加上武器图鉴',
      contact: null,
      appVersion: '1.0.0',
      game: 'endfield',
    })
    expect(parseFeedback({ category: 'bug', message: '有问题啊', appVersion: '<script>', game: 'genshin' })).toMatchObject({ appVersion: null, game: null })
  })

  it('拒绝类型不对、太短或太长的内容', () => {
    expect(parseFeedback(null)).toBeNull()
    expect(parseFeedback({ category: 'ad', message: '一二三四五' })).toBeNull()
    expect(parseFeedback({ category: 'bug', message: '短' })).toBeNull()
    expect(parseFeedback({ category: 'bug', message: 'x'.repeat(2001) })).toBeNull()
    expect(parseFeedback({ category: 'bug', message: '一二三四五', contact: 123 })).toBeNull()
  })
})

describe('编号与凭证', () => {
  it('编号易于抄写，凭证足够长；哈希可以复现', async () => {
    expect(newFeedbackId()).toMatch(/^FB-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
    const token = newFeedbackToken()
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(await hashToken(token)).toBe(await hashToken(token))
    expect(await hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('存储', () => {
  const record = { id: 'FB-AAAAA-BBBBB', tokenHash: 'a'.repeat(64), createdAt: 1, category: 'bug' as const, message: '同步失败了', contact: null, appVersion: '1.0.0', game: 'arknights' as const }

  it('写入后状态为 new，回复字段留空（作者端以后再用）；编号重复时不覆盖', () => {
    const sql = memorySql()
    initFeedbackSchema(sql)
    expect(insertFeedback(sql, record)).toBe(true)
    expect(insertFeedback(sql, { ...record, message: '另一条' })).toBe(false)
    const rows = sql.exec('SELECT * FROM feedback').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: record.id, message: '同步失败了', status: 'new', reply: null, replied_at: null })
  })

  it('建表可以重复执行', () => {
    const sql = memorySql()
    initFeedbackSchema(sql)
    initFeedbackSchema(sql)
    expect(insertFeedback(sql, record)).toBe(true)
  })
})
