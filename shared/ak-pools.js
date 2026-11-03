/**
 * 明日方舟卡池的 UP 名单：从 PRTS 的服务器侧卡池表（weedy.prts.wiki/gacha_table.json）解析。
 *
 * 构建脚本（scripts/sync-gamedata.mjs）和网页运行时（src/lib/runtime-pools.ts）共用这一份代码，结果一致：
 * 构建时带上当时已有的全部卡池；之后才开放的新卡池，网页在记录里遇到时再取 PRTS 的卡池表、在浏览器里解析
 * （维护者 2026-11-03：“前端要有算法能够解析 PRTS 的新的卡池，不要全部都依赖于构建”）。
 *
 * 只用标准 JS，不依赖 Node 或浏览器的 API。PRTS 的数据是外部输入，这里只取认识的字段并检查格式。
 * 类型声明见 ak-pools.d.ts。
 */

export const PRTS_GACHA_TABLE = 'https://weedy.prts.wiki/gacha_table.json'

const POOL_ID = /^[A-Z][A-Z0-9_]{0,63}$/
const CHAR_ID = /^char_\w{1,60}$/

/** 卡池表里的每个卡池（gachaPoolClient），格式不对的跳过 */
function poolsOf(table) {
  const list = table && typeof table === 'object' ? table.gachaPoolClient : null
  return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object' && typeof p.gachaPoolId === 'string' && POOL_ID.test(p.gachaPoolId)) : []
}

/** 各卡池的 UP 名单：{ poolId: { 6: [charId], 5: [charId] } }（PRTS 的 rarityRank 从 0 起，这里换成星级） */
export function extractUpLists(table) {
  const result = {}
  for (const pool of poolsOf(table)) {
    const list = pool.gachaPoolDetail?.detailInfo?.upCharInfo?.perCharList
    if (!Array.isArray(list)) continue
    const up = {}
    for (const entry of list) {
      if (!Number.isInteger(entry?.rarityRank) || entry.rarityRank < 0 || entry.rarityRank > 5 || !Array.isArray(entry.charIdList)) continue
      const ids = entry.charIdList.filter((id) => typeof id === 'string' && CHAR_ID.test(id))
      if (ids.length) up[entry.rarityRank + 1] = ids
    }
    if (Object.keys(up).length) result[pool.gachaPoolId] = up
  }
  return result
}

/** 各卡池的限定干员：{ poolId: charId }（只有限定寻访有） */
export function limitedChars(table) {
  const result = {}
  for (const pool of poolsOf(table)) {
    const first = pool.gachaPoolDetail?.detailInfo?.limitedChar?.[0]
    if (typeof first === 'string' && CHAR_ID.test(first)) result[pool.gachaPoolId] = first
  }
  return result
}

/** 卡池表里的全部卡池 ID */
export function poolIds(table) {
  return poolsOf(table).map((p) => p.gachaPoolId)
}

/** 游戏数据里还没有的卡池：按 poolId 前缀推断规则类型（与前端 akRuleType 的回退规则一致） */
export function inferRuleType(poolId) {
  if (poolId.startsWith('BOOT')) return 'BOOT'
  if (poolId.startsWith('CLASSIC_ATTAIN')) return 'CLASSIC_ATTAIN'
  if (poolId.startsWith('CLASSIC_DOUBLE')) return 'CLASSIC_DOUBLE'
  const prefix = poolId.split('_')[0] ?? ''
  return prefix === 'NORM' ? 'NORMAL' : prefix
}
