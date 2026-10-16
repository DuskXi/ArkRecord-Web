/**
 * 演示数据：用真实的卡池元数据和保底规则模拟一份明日方舟寻访记录，
 * 让还没登录的用户也能先看看各个页面的效果。演示账号与真实账号分开存放，可随时删除。
 */
import { db } from './db'
import type { AkMeta } from './meta'
import { akCodexItems } from './stats/codex'
import { akFamily, akRuleType } from './stats/events'
import { arknightsRate } from './stats/pity'
import type { Account, AkPull } from './types'

export const DEMO_ACCOUNT_ID = 'arknights:demo'

/** 可复现的伪随机数（mulberry32） */
function random(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const UP_SHARE: Record<string, number> = { LIMITED: 0.7, SINGLE: 0.5, LINKAGE: 0.5, NORMAL: 0.5, DOUBLE: 0.5, CLASSIC: 0.5, CLASSIC_DOUBLE: 0.5, FESCLASSIC: 0.5 }

export function generateDemoPulls(meta: AkMeta, now = Date.now(), seed = 20261016): AkPull[] {
  const rand = random(seed)
  const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]!
  // 只从寻访里抽得到的干员中选（排除预备干员、活动赠送等）；元数据里没有获得方式时退回全部干员
  const items = akCodexItems(meta)
  const gacha = items.some((i) => i.approach) ? items.filter((i) => i.gacha) : items
  const byRarity = new Map<number, string[]>()
  for (const item of gacha) {
    if (!byRarity.has(item.star)) byRarity.set(item.star, [])
    byRarity.get(item.star)!.push(item.id)
  }
  const nowSec = now / 1000
  const pools = Object.entries(meta.pools)
    .filter(([, p]) => p.o > nowSec - 540 * 86_400 && p.o < nowSec && p.t !== 'BOOT')
    .toSorted((a, b) => a[1].o - b[1].o)

  // 先确定每次十连的卡池和时间，再按时间顺序模拟：同时开放的卡池共享保底计数
  const batches: { poolId: string; ts: number }[] = []
  for (const [poolId, pool] of pools) {
    const ruleType = akRuleType(poolId, pool.n, meta)
    const big = ['LIMITED', 'LINKAGE', 'SINGLE'].includes(ruleType)
    if (!big && rand() < 0.6) continue
    const count = big ? 3 + Math.floor(rand() * 15) : 1 + Math.floor(rand() * 4)
    const end = Math.min(pool.e, nowSec - 3600)
    for (let b = 0; b < count; b++) batches.push({ poolId, ts: Math.floor((pool.o + rand() * (end - pool.o)) * 1000) })
  }
  batches.sort((x, y) => x.ts - y.ts)

  const counters = new Map<string, number>()
  const seen = new Set<string>()
  const pulls: AkPull[] = []
  for (const { poolId, ts } of batches) {
    const pool = meta.pools[poolId]!
    const ruleType = akRuleType(poolId, pool.n, meta)
    const { family } = akFamily(ruleType, poolId, pool.n)
    for (let pos = 0; pos < 10; pos++) {
      const count = (counters.get(family) ?? 0) + 1
      let star: number
      if (rand() < arknightsRate(count)) star = 6
      else {
        const r = rand()
        star = r < 0.08 ? 5 : r < 0.58 ? 4 : 3
      }
      counters.set(family, star === 6 ? 0 : count)
      const up = pool.up?.[String(star)]
      const charId = up?.length && rand() < (star === 6 ? (UP_SHARE[ruleType] ?? 0.5) : 0.5) ? pick(up) : pick(byRarity.get(star) ?? [''])
      const name = meta.chars[charId]?.n ?? '未知干员'
      pulls.push({
        accountId: DEMO_ACCOUNT_ID,
        key: `${poolId}:${charId}:${ts}:${pos}`,
        poolId,
        poolName: pool.n,
        charId,
        charName: name,
        rarity: star - 1,
        isNew: !seen.has(charId),
        gachaTs: ts,
        tsSec: Math.floor(ts / 1000),
        pos,
        source: 'import',
      })
      seen.add(charId)
    }
  }
  return pulls
}

export async function loadDemo(meta: AkMeta): Promise<Account> {
  const account: Account = {
    id: DEMO_ACCOUNT_ID,
    game: 'arknights',
    uid: 'demo',
    nickName: '演示博士',
    channelName: '演示数据',
    createdAt: Date.now(),
  }
  await db.transaction('rw', db.accounts, db.akPulls, async () => {
    await db.akPulls.where('accountId').equals(DEMO_ACCOUNT_ID).delete()
    await db.accounts.put(account)
    await db.akPulls.bulkPut(generateDemoPulls(meta))
  })
  return account
}
