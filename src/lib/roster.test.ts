import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildExport, type ExportFile, importExportFile } from './archive'
import { db } from './db'
import { currentState, mergeRoster, type RosterEntry, type RosterInput, timeFromExif, timeFromFilename } from './roster'

const ACCOUNT = 'endfield:1'
const T = new Date(2026, 9, 17, 6, 6, 36).getTime()

function input(itemId: string, potential: number, observedAt = T): RosterInput {
  return { itemId, name: itemId, copies: potential + 1, potential, observedAt, source: 'screenshot' }
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  await db.accounts.put({ id: ACCOUNT, game: 'endfield', uid: '1', nickName: '测试', createdAt: 0 })
})

describe('截图快照：幂等', () => {
  it('同一张截图导入多次，结果不变', async () => {
    const shot = [input('chr_a', 0), input('chr_b', 5)]
    expect(await mergeRoster(ACCOUNT, shot)).toEqual({ added: 2, updated: 0, unchanged: 0, older: 0 })
    const before = await db.roster.toArray()
    expect(await mergeRoster(ACCOUNT, shot)).toEqual({ added: 0, updated: 0, unchanged: 2, older: 0 })
    expect(await db.roster.toArray()).toEqual(before)
  })

  it('更新的截图覆盖，更早的截图不覆盖', async () => {
    await mergeRoster(ACCOUNT, [input('chr_a', 1)])
    expect(await mergeRoster(ACCOUNT, [input('chr_a', 0, T - 1000)])).toMatchObject({ older: 1 })
    expect((await db.roster.get([ACCOUNT, 'chr_a']))!.potential).toBe(1)
    expect(await mergeRoster(ACCOUNT, [input('chr_a', 3, T + 1000)])).toMatchObject({ updated: 1 })
    expect((await db.roster.get([ACCOUNT, 'chr_a']))!.potential).toBe(3)
  })

  it('一批里同一名干员出现两次（两张截图有重叠）：取截图时间新的', async () => {
    await mergeRoster(ACCOUNT, [input('chr_a', 2, T + 5000), input('chr_a', 1, T)])
    expect((await db.roster.get([ACCOUNT, 'chr_a']))!.potential).toBe(2)
  })

  it('进入导出文件，导入后不重复', async () => {
    await mergeRoster(ACCOUNT, [input('chr_a', 4)])
    const file = JSON.parse(JSON.stringify(await buildExport('test'))) as ExportFile
    expect(file.endfield[0]!.roster).toEqual([{ itemId: 'chr_a', name: 'chr_a', copies: 5, potential: 4, observedAt: T, importedAt: expect.any(Number), source: 'screenshot' }])
    await db.roster.clear()
    await importExportFile(file)
    await importExportFile(file)
    expect(await db.roster.count()).toBe(1)
  })
})

describe('截图之后又抽卡', () => {
  const entry: RosterEntry = { accountId: ACCOUNT, itemId: 'chr_si', name: '祀', copies: 4, potential: 3, observedAt: T, importedAt: T, source: 'screenshot' }

  it('只把截图之后的抽到、赠送加上去；潜能最多 5', () => {
    const pulls = [
      { itemId: 'chr_si', name: '祀', ts: T - 10_000 },
      { itemId: 'chr_si', name: '祀', ts: T + 10_000 },
      { itemId: 'chr_other', name: '别人', ts: T + 10_000 },
    ]
    const gifts = [{ itemId: 'chr_si', name: '祀', ts: T + 20_000 }]
    const state = currentState(entry, pulls, gifts, true)
    expect(state).toMatchObject({ pulledAfter: 1, giftedAfter: 1, copies: 6, potential: 5, conflict: false })
    expect(currentState(entry, [...pulls, ...pulls], gifts, true).potential).toBe(5)
  })

  it('截图之前的记录比截图上的份数还多：标出来请用户检查', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ itemId: 'chr_si', name: '祀', ts: T - i - 1 }))
    expect(currentState(entry, many, [], true).conflict).toBe(true)
  })

  it('明日方舟只知道拥有：份数未知', () => {
    const ak: RosterEntry = { ...entry, itemId: 'char_103_angel', copies: null, potential: null }
    expect(currentState(ak, [{ itemId: 'char_103_angel', name: '能天使', ts: T + 1 }], [], false)).toMatchObject({ copies: null, potential: null, pulledAfter: 1 })
  })
})

const at = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(y, mo - 1, d, h, mi, s).getTime()

describe('截图时间', () => {
  it('从常见的文件名读出', () => {
    expect(timeFromFilename('Screenshot_2026-10-17-06-05-25-51.jpg')).toBe(at(2026, 10, 17, 6, 5, 25))
    expect(timeFromFilename('Screenshot_20261017-060525.png')).toBe(at(2026, 10, 17, 6, 5, 25))
    expect(timeFromFilename('IMG_20261017_060525.jpg')).toBe(at(2026, 10, 17, 6, 5, 25))
    expect(timeFromFilename('微信图片_20261017060525.jpg')).toBe(at(2026, 10, 17, 6, 5, 25))
    expect(timeFromFilename('截屏2026-10-17 06.05.25.png')).toBe(at(2026, 10, 17, 6, 5, 25))
    expect(timeFromFilename('Screen Shot 2026-10-17 at 6.05.25 PM.png')).toBe(at(2026, 10, 17, 18, 5, 25))
    expect(timeFromFilename('Screen Shot 2026-10-17 at 12.05.25 AM.png')).toBe(at(2026, 10, 17, 0, 5, 25))
    expect(timeFromFilename('photo.jpg')).toBeNull()
    expect(timeFromFilename('Screenshot_2026-13-45-06-05-25.jpg')).toBeNull()
  })

  it('JPEG 的 EXIF 时间', () => {
    const head = new TextEncoder().encode('\u0000\u0000Exif\u0000\u00002026:10:17 06:05:25\u0000')
    const bytes = new Uint8Array([0xff, 0xd8, ...head])
    expect(timeFromExif(bytes)).toBe(new Date(2026, 9, 17, 6, 5, 25).getTime())
    expect(timeFromExif(new Uint8Array([0x89, 0x50]))).toBeNull()
  })
})

describe('多台设备之间合并：与顺序无关', () => {
  it('同一名干员的不同版本，按任何顺序合并，结果都一样', async () => {
    const versions: RosterInput[] = [
      { itemId: 'chr_a', name: 'chr_a', copies: 2, potential: 1, observedAt: T, importedAt: T + 10, source: 'screenshot' },
      { itemId: 'chr_a', name: 'chr_a', copies: 3, potential: 2, observedAt: T, importedAt: T + 20, source: 'screenshot' },
      { itemId: 'chr_a', name: 'chr_a', copies: 1, potential: 0, observedAt: T - 1000, importedAt: T + 30, source: 'screenshot' },
      { itemId: 'chr_a', name: 'chr_a', copies: 4, potential: 3, observedAt: T, importedAt: T + 20, source: 'manual' },
    ]
    const results = new Set<string>()
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ]
    for (const order of orders) {
      await db.roster.clear()
      for (const i of order) await mergeRoster(ACCOUNT, [versions[i]!])
      results.add(JSON.stringify(await db.roster.toArray()))
    }
    // 一次合并一批（同一批里有重复）也一样
    await db.roster.clear()
    await mergeRoster(ACCOUNT, versions)
    results.add(JSON.stringify(await db.roster.toArray()))
    expect(results.size).toBe(1)
    // 截图时间最新的那几条里，导入时间新的；再相同时按规范编码
    expect((await db.roster.get([ACCOUNT, 'chr_a']))!.observedAt).toBe(T)
  })

  it('这台设备上重新导入同一张截图、改正了识别结果：改正的生效', async () => {
    await mergeRoster(ACCOUNT, [input('chr_a', 1)])
    expect(await mergeRoster(ACCOUNT, [input('chr_a', 2)])).toMatchObject({ updated: 1 })
    expect((await db.roster.get([ACCOUNT, 'chr_a']))!.potential).toBe(2)
  })
})
