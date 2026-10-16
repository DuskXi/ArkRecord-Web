#!/usr/bin/env node
/**
 * 构建前运行：拉取明日方舟游戏数据，生成精简的元数据和同源头像，输出到 public/gamedata/（不提交到仓库）。
 *
 * 数据来源（详见 docs/rewrite/data-sources.md）：
 *   - 干员表、卡池表：Kengxxiao/ArknightsGameData（GitHub）
 *   - UP 名单：weedy.prts.wiki 的服务器侧卡池详情（拉取失败时降级为“UP 未知”，不阻塞构建）
 *   - 头像：yuanyan3060/ArknightsGameResource（GitHub），失败时改用 torappu.prts.wiki；
 *     统一缩放为 128×128 WebP 后放在本站同源路径下，分享图导出时不会出现跨域问题。
 *
 * 这些请求都发生在构建阶段（本地或 GitHub Actions），线上的 Worker 不访问 PRTS。
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const OUT_DIR = path.resolve('public/gamedata')
const AVATAR_DIR = path.join(OUT_DIR, 'avatars')
const AVATAR_SIZE = 128
const CONCURRENCY = 12

const GAMEDATA = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata'
const WEEDY_GACHA = 'https://weedy.prts.wiki/gacha_table.json'
const AVATAR_SOURCES = [
  (id) => `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${id}.png`,
  (id) => `https://torappu.prts.wiki/assets/char_avatar/${id}.png`,
]

const TIER = { TIER_1: 1, TIER_2: 2, TIER_3: 3, TIER_4: 4, TIER_5: 5, TIER_6: 6 }

async function fetchJson(url, timeoutMs = 60_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return (await res.text()).trim()
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

function rarityOf(value) {
  return typeof value === 'number' ? value + 1 : (TIER[value] ?? 0)
}

/** 从服务器侧卡池详情中提取各卡池的 UP 名单：{ poolId: { 6: [charId], 5: [charId] } } */
function extractUpLists(weedy) {
  const result = {}
  for (const pool of weedy.gachaPoolClient ?? []) {
    const list = pool.gachaPoolDetail?.detailInfo?.upCharInfo?.perCharList ?? []
    if (!list.length) continue
    const up = {}
    for (const entry of list) up[entry.rarityRank + 1] = entry.charIdList
    result[pool.gachaPoolId] = up
  }
  return result
}

function buildPools(gachaTable, upLists) {
  const pools = {}
  for (const p of gachaTable.gachaPoolClient) {
    const pool = { n: p.gachaPoolName, t: p.gachaRuleType, o: p.openTime, e: p.endTime }
    if (p.linkageParam?.loopTarget6Count) pool.loop6 = p.linkageParam.loopTarget6Count
    if (p.linkageParam?.guaranteeTarget6Count) pool.g6 = p.linkageParam.guaranteeTarget6Count
    if (p.linkageParam?.guaranteeTarget6Char) pool.g6c = p.linkageParam.guaranteeTarget6Char
    if (p.limitParam?.hasFreeChar) pool.free = p.limitParam.freeCount
    if (p.limitParam?.limitedCharId) pool.lim = p.limitParam.limitedCharId
    if (p.dynMeta?.attainRare6CharList) pool.attain6 = p.dynMeta.attainRare6CharList
    if (upLists[p.gachaPoolId]) pool.up = upLists[p.gachaPoolId]
    pools[p.gachaPoolId] = pool
  }
  for (const p of gachaTable.newbeeGachaPoolClient ?? []) {
    pools[p.gachaPoolId] = { n: '新手寻访', t: 'BOOT', o: 0, e: 0 }
  }
  return pools
}

function buildChars(characterTable) {
  const chars = {}
  for (const [id, c] of Object.entries(characterTable)) {
    if (!id.startsWith('char_')) continue
    chars[id] = { n: c.name, r: rarityOf(c.rarity), p: c.profession }
  }
  return chars
}

async function downloadAvatar(id) {
  const target = path.join(AVATAR_DIR, `${id}.webp`)
  if (await exists(target)) return 'cached'
  for (const source of AVATAR_SOURCES) {
    try {
      const res = await fetch(source(id), { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) continue
      const input = Buffer.from(await res.arrayBuffer())
      await sharp(input).resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' }).webp({ quality: 82 }).toFile(target)
      return 'downloaded'
    } catch {
      // 换下一个来源
    }
  }
  return 'missing'
}

async function mapLimited(items, limit, fn) {
  const results = Array.from({ length: items.length })
  let next = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index])
      }
    }),
  )
  return results
}

const FRESH_MS = 12 * 3600 * 1000

async function main() {
  await mkdir(AVATAR_DIR, { recursive: true })

  // 本地开发时，12 小时内生成过就跳过；CI 或需要强制更新时加 --force。
  const metaFile = path.join(OUT_DIR, 'ak-meta.json')
  if (!process.argv.includes('--force') && (await exists(metaFile))) {
    const age = Date.now() - (await stat(metaFile)).mtimeMs
    if (age < FRESH_MS) {
      console.log(`游戏数据在 ${Math.round(age / 60000)} 分钟前已生成，跳过（加 --force 强制更新）`)
      return
    }
  }

  const version = await fetchText(`${GAMEDATA}/excel/data_version.txt`)
  console.log(`游戏数据版本：${version.split('\n').join(' ')}`)
  const [characterTable, gachaTable] = await Promise.all([
    fetchJson(`${GAMEDATA}/excel/character_table.json`),
    fetchJson(`${GAMEDATA}/excel/gacha_table.json`),
  ])

  let upLists = {}
  try {
    upLists = extractUpLists(await fetchJson(WEEDY_GACHA))
  } catch (error) {
    console.warn(`UP 名单拉取失败，降级为“UP 未知”：${error.message}`)
  }

  const chars = buildChars(characterTable)
  const pools = buildPools(gachaTable, upLists)

  const ids = Object.keys(chars)
  const outcomes = await mapLimited(ids, CONCURRENCY, downloadAvatar)
  const avatars = ids.filter((_, i) => outcomes[i] !== 'missing')
  const count = (kind) => outcomes.filter((o) => o === kind).length
  console.log(`头像：新增 ${count('downloaded')}，已有 ${count('cached')}，缺失 ${count('missing')}`)

  const meta = {
    version: version.split('\n')[0],
    generatedAt: new Date().toISOString(),
    upAvailable: Object.keys(upLists).length > 0,
    chars,
    pools,
    avatars,
  }
  const content = JSON.stringify(meta)
  await writeFile(metaFile, content)
  console.log(
    `已写入 ${path.relative(process.cwd(), metaFile)}：干员 ${ids.length}，卡池 ${Object.keys(pools).length}，` +
      `UP 名单 ${Object.keys(upLists).length}，大小 ${(content.length / 1024).toFixed(0)} KB`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
