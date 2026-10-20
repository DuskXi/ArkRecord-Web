import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { mhyDb } from '@/lib/mhy/db'
import { type MhyGame, type MhyPull, mhyAccountId } from '@/lib/mhy/types'
import { useMhyRecords } from './records'

// 合成的记录（不是真实数据）：星铁角色池 3 抽、光锥池 2 抽
const UID = '100000001'
const ACCOUNT = mhyAccountId('starrail', UID)

function pull(id: number, pool: string, rank: number, itemType: string): MhyPull {
  const ts = Date.UTC(2026, 9, 1, 0, 0, id)
  return {
    accountId: ACCOUNT,
    id: String(1_700_000_000_000_000_000n + BigInt(id)),
    gachaType: pool,
    pool,
    gachaId: pool === '11' ? '2001' : '3001',
    itemId: String(20000 + id),
    name: `测试${id}`,
    itemType,
    rank,
    count: 1,
    time: '2026-10-01 08:00:00',
    ts,
    lang: 'zh-cn',
    source: 'api',
  }
}

describe('useMhyRecords', () => {
  it('把米哈游的记录交给统计引擎：最高 5★，角色 / 光锥分开看，没有的项是空值', async () => {
    await mhyDb.accounts.put({ id: ACCOUNT, game: 'starrail', uid: UID, region: 'prod_gf_cn', gameBiz: 'hkrpg_cn', utcOffset: 8, createdAt: 0, lastSyncAt: 1 })
    await mhyDb.pulls.bulkPut([pull(1, '11', 3, '光锥'), pull(2, '11', 4, '角色'), pull(3, '11', 5, '角色'), pull(4, '12', 3, '光锥'), pull(5, '12', 5, '光锥')])

    const game = ref<MhyGame>('starrail')
    const scope = effectScope()
    const source = scope.run(() => useMhyRecords(() => game.value))!

    await vi.waitFor(() => expect(source.events).toHaveLength(3))
    expect(source.accountId).toBe(ACCOUNT)
    expect(source.profile.id).toBe('starrail')
    expect(source.profile.topStar).toBe(5)
    expect(source.model.topStar).toBe(5)
    expect(source.analysis.topStar).toBe(5)
    expect(source.analysis.stars[5]).toBe(1)
    expect(source.weaponScope).toBe(false)
    expect([source.gifts, source.roster, source.guarantees, source.efPools.size]).toEqual([[], [], [], 0])

    // 页面右上角的“角色 / 光锥”切换直接改 efScope
    source.efScope = 'weapon'
    expect(source.weaponScope).toBe(true)
    expect(source.events.map((e) => e.star)).toEqual([3, 5])
    expect(source.model.hardPity).toBe(80)

    // 换游戏时回到“角色”
    game.value = 'genshin'
    await vi.waitFor(() => expect(source.efScope).toBe('char'))
    expect(source.profile.recordName).toBe('祈愿记录')
    scope.stop()
  })
})
