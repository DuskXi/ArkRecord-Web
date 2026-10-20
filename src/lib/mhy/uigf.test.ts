/**
 * 可选的 UIGF 导入导出。记录都是合成的（UID、id、时间都是编的）。
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { MhyDB } from './db'
import type { MhyPull } from './types'
import { exportUigf, importUigf, parseUigf, previewUigf, regionFromUid } from './uigf'

/** 比较两边记录时只看这些字段（来源、写入方式不同） */
const strip = (pulls: MhyPull[]) => pulls.map(({ accountId, id, pool, gachaType, name, rank, ts }) => ({ accountId, id, pool, gachaType, name, rank, ts }))

let dbCount = 0
const newDb = () => new MhyDB(`uigf-test-${++dbCount}`, { indexedDB: new IDBFactory(), IDBKeyRange })

const info = { export_timestamp: 1_760_000_000, export_app: 'SomeApp', export_app_version: '1.0', version: 'v4.2' }

function hk4e(n: number, extra: Record<string, unknown> = {}) {
  return {
    uigf_gacha_type: '301',
    gacha_type: '301',
    item_id: '',
    count: '1',
    time: `2026-01-0${1 + (n % 9)} 12:00:0${n % 10}`,
    name: n % 10 === 0 ? '琴' : '某个三星武器',
    item_type: n % 10 === 0 ? '角色' : '武器',
    rank_type: n % 10 === 0 ? '5' : '3',
    id: String(1_700_000_000_000_000_000n + BigInt(n)),
    ...extra,
  }
}

function hkrpg(n: number, extra: Record<string, unknown> = {}) {
  return {
    gacha_id: '2001',
    gacha_type: '11',
    item_id: '1003',
    count: '1',
    time: '2026-02-01 08:00:00',
    name: '姬子',
    item_type: '角色',
    rank_type: '5',
    id: String(1_800_000_000_000_000_000n + BigInt(n)),
    ...extra,
  }
}

describe('parseUigf', () => {
  it('v4：原神、星铁各自的账号；绝区零、千星奇域列为不支持', () => {
    const parsed = parseUigf({
      info,
      hk4e: [{ uid: 100000001, timezone: 8, lang: 'zh-cn', list: [hk4e(1)] }],
      hkrpg: [{ uid: '600000001', timezone: -5, list: [hkrpg(1)] }],
      nap: [{ uid: '10000001', timezone: 8, list: [{}, {}] }],
      hk4e_ugc: [{ uid: '100000001', timezone: 8, list: [{}] }],
    })
    expect(parsed.format).toBe('UIGF v4.2')
    expect(parsed.exportApp).toBe('SomeApp')
    expect(parsed.sections.map((s) => [s.game, s.uid, s.timezone])).toEqual([
      ['genshin', '100000001', 8],
      ['starrail', '600000001', -5],
    ])
    expect(parsed.unsupported).toEqual(['绝区零：1 个账号、2 条记录（不支持，已跳过）', '千星奇域：1 个账号、1 条记录（不支持，已跳过）'])
  })

  it('旧格式：UIGF v3（原神）、SRGF v1（星铁）；没有时区时按 UID 的区服', () => {
    const v3 = parseUigf({ info: { uid: '700000001', lang: 'zh-cn', uigf_version: 'v3.0' }, list: [hk4e(1)] })
    expect([v3.format, v3.sections[0]!.game, v3.sections[0]!.timezone]).toEqual(['UIGF v3.0', 'genshin', 1])
    const srgf = parseUigf({ info: { uid: '100000002', srgf_version: 'v1.0', region_time_zone: 8 }, list: [hkrpg(1)] })
    expect([srgf.format, srgf.sections[0]!.game, srgf.sections[0]!.timezone]).toEqual(['SRGF v1.0', 'starrail', 8])
  })

  it.each([
    [null, '缺少 info'],
    [{ info: { version: 'v5.0' } }, '不支持的 UIGF 版本'],
    [{ info: {} }, '看不出版本号'],
    [{ info, hk4e: {} }, '不是列表'],
    [{ info, hk4e: [{ uid: 'abc', timezone: 8, list: [] }] }, '缺少 UID'],
    [{ info, hk4e: [{ uid: '1', timezone: 99, list: [] }] }, '时区'],
    [{ info, hk4e: [{ uid: '1', timezone: 8 }] }, '没有记录列表'],
  ])('格式不对时给出中文的原因', (json, message) => {
    expect(() => parseUigf(json)).toThrow(message)
  })
})

describe('预览和导入', () => {
  it('新增、重复、跳过（附原因）；400 归入 301；按文件的时区换算时间', async () => {
    const db = newDb()
    const parsed = parseUigf({
      info,
      hk4e: [
        {
          uid: '100000001',
          timezone: 8,
          lang: 'zh-cn',
          list: [
            hk4e(0),
            hk4e(1, { gacha_type: '400' }),
            hk4e(1),
            hk4e(2, { name: undefined }),
            hk4e(3, { rank_type: '' }),
            hk4e(4, { time: '2026/01/01' }),
            hk4e(5, { gacha_type: '999', uigf_gacha_type: '999' }),
          ],
        },
      ],
    })
    const preview = await previewUigf(parsed, db)
    expect(preview.items).toHaveLength(1)
    const item = preview.items[0]!
    expect([item.total, item.added, item.duplicate, item.skipped, item.accountExists]).toEqual([7, 2, 1, 4, false])
    expect(item.skippedReasons).toEqual({ '缺少名称（只有物品 ID）': 1, 缺少星级: 1, 时间格式不对: 1, 卡池类型不认识: 1 })
    expect(await db.pulls.count()).toBe(0)

    const result = await importUigf(parsed, db, () => 42)
    expect(result).toEqual({ accountIds: ['genshin:100000001'], added: 2 })
    const account = (await db.accounts.get('genshin:100000001'))!
    expect(account).toMatchObject({ region: 'cn_gf01', gameBiz: 'hk4e_cn', utcOffset: 8, createdAt: 42 })
    const pulls = await db.pulls.toArray()
    expect(pulls.every((p) => p.source === 'import' && p.pool === '301')).toBe(true)
    expect(pulls.find((p) => p.id.endsWith('0'))!.ts).toBe(Date.UTC(2026, 0, 1, 4, 0, 0))

    // 再导入一次：都是重复的
    const again = await previewUigf(parsed, db)
    expect([again.items[0]!.added, again.items[0]!.duplicate, again.items[0]!.accountExists]).toEqual([0, 3, true])
    expect((await importUigf(parsed, db)).added).toBe(0)
  })

  it('本机已有从接口拉到的同一条记录时保留接口的；导入只追加，不删除', async () => {
    const db = newDb()
    const api: MhyPull = {
      accountId: 'starrail:100000003',
      id: String(1_800_000_000_000_000_001n),
      gachaType: '11',
      pool: '11',
      gachaId: '2001',
      itemId: '1003',
      name: '姬子',
      itemType: '角色',
      rank: 5,
      count: 1,
      time: '2026-02-01 08:00:00',
      ts: Date.UTC(2026, 1, 1, 0, 0, 0),
      lang: 'zh-cn',
      source: 'api',
    }
    const extra = { ...api, id: String(1_900_000_000_000_000_000n) }
    await db.accounts.put({ id: api.accountId, game: 'starrail', uid: '100000003', region: 'prod_gf_cn', gameBiz: 'hkrpg_cn', utcOffset: 8, createdAt: 1 })
    await db.pulls.bulkPut([api, extra])
    const parsed = parseUigf({ info, hkrpg: [{ uid: '100000003', timezone: 9, lang: 'zh-cn', list: [hkrpg(1, { name: '改过的名字' }), hkrpg(2)] }] })
    const preview = await previewUigf(parsed, db)
    expect(preview.items[0]!.warnings.some((w) => w.includes('UTC+9'))).toBe(true)
    expect((await importUigf(parsed, db)).added).toBe(1)
    const kept = (await db.pulls.get([api.accountId, api.id]))!
    expect([kept.source, kept.name]).toEqual(['api', '姬子'])
    expect(await db.pulls.count()).toBe(3)
    // 已有账号的区服、时区不动
    expect((await db.accounts.get(api.accountId))!.utcOffset).toBe(8)
  })

  it('全是跳过的记录时不建账号；看不出区服时提示', async () => {
    const db = newDb()
    const parsed = parseUigf({ info, hk4e: [{ uid: '1234', timezone: 8, list: [hk4e(1, { name: '' })] }] })
    const preview = await previewUigf(parsed, db)
    expect(preview.items[0]!.warnings.some((w) => w.includes('看不出区服'))).toBe(true)
    expect(await importUigf(parsed, db)).toEqual({ accountIds: [], added: 0 })
    expect(await db.accounts.count()).toBe(0)
  })

  it('UID 推断区服', () => {
    expect(regionFromUid('genshin', '812345678')).toEqual({ region: 'os_asia', gameBiz: 'hk4e_global' })
    expect(regionFromUid('starrail', '512345678')).toEqual({ region: 'prod_qd_cn', gameBiz: 'hkrpg_cn' })
    expect(regionFromUid('genshin', '1812345678')).toEqual({ region: '', gameBiz: '' })
  })
})

describe('导出 UIGF v4.2', () => {
  it('按账号导出，时间按账号的时区；导出再导入得到同样的记录', async () => {
    const db = newDb()
    const parsed = parseUigf({
      info,
      hk4e: [
        { uid: '100000001', timezone: 8, lang: 'zh-cn', list: [hk4e(0), hk4e(1, { gacha_type: '400' })] },
        { uid: '700000001', timezone: 1, lang: 'zh-cn', list: [hk4e(2)] },
      ],
    })
    await importUigf(parsed, db)
    const out = await exportUigf('genshin', ['genshin:100000001'], db, { now: 1_760_000_000_000, appVersion: '9.9.9' })
    expect(out.info).toEqual({ export_timestamp: 1_760_000_000, export_app: 'ArkRecord', export_app_version: '9.9.9', version: 'v4.2' })
    expect(out.hkrpg).toBeUndefined()
    const entries = out.hk4e as { uid: string; timezone: number; lang: string; list: Record<string, string>[] }[]
    expect(entries.map((e) => [e.uid, e.timezone, e.lang])).toEqual([['100000001', 8, 'zh-cn']])
    expect(entries[0]!.list.map((r) => [r.uigf_gacha_type, r.gacha_type])).toEqual([
      ['301', '301'],
      ['301', '400'],
    ])
    expect(Object.keys(entries[0]!.list[0]!)).toEqual(['uigf_gacha_type', 'gacha_type', 'item_id', 'count', 'time', 'name', 'item_type', 'rank_type', 'id'])

    // 导出的文件能原样导入另一个库
    const other = newDb()
    await importUigf(parseUigf(JSON.parse(JSON.stringify(out))), other)
    expect(strip(await other.pulls.toArray())).toEqual(strip(await db.pulls.where('accountId').equals('genshin:100000001').toArray()))

    // 不指定账号时导出这个游戏的全部账号
    const all = await exportUigf('genshin', [], db)
    expect((all.hk4e as unknown[]).length).toBe(2)
  })

  it('星铁带 gacha_id；导出的字段类型都是字符串', async () => {
    const db = newDb()
    await importUigf(parseUigf({ info, hkrpg: [{ uid: '100000003', timezone: 8, list: [hkrpg(1)] }] }), db)
    const out = await exportUigf('starrail', [], db)
    const row = (out.hkrpg as { list: Record<string, unknown>[] }[])[0]!.list[0]!
    expect(row.gacha_id).toBe('2001')
    expect(Object.values(row).every((v) => typeof v === 'string')).toBe(true)
  })
})
