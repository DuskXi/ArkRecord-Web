#!/usr/bin/env node
/**
 * 构建前运行：拉取两个游戏的数据，生成精简的元数据和同源头像，输出到 public/gamedata/（不提交到仓库）。
 *
 * 数据来源（详见 docs/rewrite/data-sources.md）：
 *   - 终末地卡池表、物品表：555me/beyondGameData（GitHub），只取卡池类型、UP 名单和角色 / 武器的名称与星级
 *     （2026-10-16 实测比各 wiki 更新更快：已收录当期 UP 祀和新角色噗切娜，BWIKI 还没有）
 *   - 终末地头像、武器图标（双备份，按顺序尝试，下载失败自动换下一个）：
 *       1. scripts/ef-avatar-overrides.json 中手动指定的图片地址（维护者可直接填森空岛的图片地址）；
 *       2. BWIKI（wiki.biligame.com/zmd，匿名 MediaWiki API）的“XX头像.png”“XX图标.png”，按名称与游戏 ID 对应；
 *       3. 森空岛的角色头像（bbs.hycdn.cn）。森空岛 wiki 的接口需要设备签名，脚本不能直接读取，
 *          图片地址取自 cmyyx/cep 每日抓取的索引（只读取其中的地址，不分发该文件）。
 *     灰机 wiki 有人机验证，脚本无法读取。图片同样转成 128×128 WebP 放在本站。
 *   - 干员表、卡池表：Kengxxiao/ArknightsGameData（GitHub）
 *   - UP 名单：weedy.prts.wiki 的服务器侧卡池详情（拉取失败时降级为“UP 未知”，不阻塞构建）
 *   - 头像：yuanyan3060/ArknightsGameResource（GitHub），失败时改用 torappu.prts.wiki；
 *     统一缩放为 128×128 WebP 后放在本站同源路径下，分享图导出时不会出现跨域问题。
 *
 * 这些请求都发生在构建阶段（本地或 GitHub Actions），线上的 Worker 不访问 PRTS。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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

const EF_GAMEDATA = 'https://raw.githubusercontent.com/555me/beyondGameData/main/tableCfg'
/** GachaCharPoolTable 的 type 字段 */
const EF_CHAR_POOL_TYPE = { 0: 'special', 1: 'beginner', 2: 'standard', 3: 'joint', 4: 'rerun' }
/** GachaWeaponPoolTable 的 type 字段 */
const EF_WEAPON_POOL_TYPE = { 0: 'weapon', 1: 'weapon_rerun' }
/** ItemTable 的 type 字段：4 = 角色，5 = 武器 */
const EF_ITEM_TYPES = new Set(['4', '5'])
const EF_AVATAR_DIR = path.join(OUT_DIR, 'ef-avatars')
const BWIKI_API = 'https://wiki.biligame.com/zmd/api.php'
const SCRIPT_UA = 'ArkRecord build script (+https://github.com/DuskXi/ArkRecord-Web)'
const BWIKI_HEADERS = { 'user-agent': SCRIPT_UA, referer: 'https://wiki.biligame.com/zmd/' }
/** 森空岛图片 CDN 有防盗链：带其他站点的 Referer 会被拒绝（403），不带 Referer 可以下载 */
const PLAIN_HEADERS = { 'user-agent': SCRIPT_UA }
/** 优先用“头像”，没有时用“图标”（部分武器只有图标） */
const BWIKI_SUFFIXES = ['头像.png', '图标.png']
const SKLAND_INDEX = 'https://raw.githubusercontent.com/cmyyx/cep/main/public/images/characters/sources.json'
/** 索引里管理员的键与游戏 ID 不同 */
const SKLAND_ALIASES = { chr_0002_endminm: 'chr_9000_endmin-male', chr_0003_endminf: 'chr_9000_endmin-female', chr_9000_endmin: 'chr_9000_endmin-male' }
/** 只从这两个图片域名下载，第三方索引里的其他地址一律忽略 */
const ALLOWED_IMAGE_URL = /^https:\/\/(?:patchwiki\.biligame\.com\/images\/zmd\/|bbs\.hycdn\.cn\/image\/)/
const OVERRIDES_FILE = path.resolve('scripts/ef-avatar-overrides.json')

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

const RULE_LABEL = {
  NORMAL: '标准寻访',
  DOUBLE: '标准寻访',
  SINGLE: '标准寻访',
  SPECIAL: '标准寻访',
  CLASSIC: '中坚寻访',
  CLASSIC_DOUBLE: '中坚寻访',
  FESCLASSIC: '中坚甄选',
}
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })

function buildPools(gachaTable, upLists) {
  const pools = {}
  // 常驻卡池在游戏数据里都叫同一个泛称（如“适合多种场合的强力干员”），改成“类型 · 开放日期”便于区分
  const nameCount = new Map()
  for (const p of gachaTable.gachaPoolClient) nameCount.set(p.gachaPoolName, (nameCount.get(p.gachaPoolName) ?? 0) + 1)
  for (const p of gachaTable.gachaPoolClient) {
    const generic = nameCount.get(p.gachaPoolName) > 5
    const name = generic ? `${RULE_LABEL[p.gachaRuleType] ?? p.gachaPoolName} · ${DAY.format(p.openTime * 1000)}` : p.gachaPoolName
    const pool = { n: name, t: p.gachaRuleType, o: p.openTime, e: p.endTime }
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
const FORCE = process.argv.includes('--force')

/** 本地开发时，12 小时内生成过就跳过；CI 或需要强制更新时加 --force */
async function isFresh(file) {
  if (FORCE || !(await exists(file))) return false
  const age = Date.now() - (await stat(file)).mtimeMs
  if (age >= FRESH_MS) return false
  console.log(`${path.basename(file)} 在 ${Math.round(age / 60000)} 分钟前已生成，跳过（加 --force 强制更新）`)
  return true
}

async function syncArknights() {
  await mkdir(AVATAR_DIR, { recursive: true })
  const metaFile = path.join(OUT_DIR, 'ak-meta.json')
  if (await isFresh(metaFile)) return

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

/**
 * 终末地：官方 api/content 只能查到当期卡池（旧卡池返回 40402），
 * 所以卡池类型和 UP 名单取自游戏数据表，记录里的 6★ 才能判断是否为 UP。
 */
async function syncEndfield() {
  await mkdir(OUT_DIR, { recursive: true })
  const metaFile = path.join(OUT_DIR, 'ef-meta.json')
  if (await isFresh(metaFile)) return

  let charPools, weaponPools, itemTable
  try {
    ;[charPools, weaponPools, itemTable] = await Promise.all([
      fetchJson(`${EF_GAMEDATA}/GachaCharPoolTable.json`),
      fetchJson(`${EF_GAMEDATA}/GachaWeaponPoolTable.json`),
      fetchJson(`${EF_GAMEDATA}/ItemTable.json`),
    ])
  } catch (error) {
    // 不阻塞构建：没有元数据时，前端退回到官方接口的当期卡池信息
    console.warn(`终末地数据拉取失败：${error.message}`)
    if (!(await exists(metaFile))) await writeFile(metaFile, JSON.stringify({ generatedAt: '', pools: {}, items: {}, avatars: [] }))
    return
  }

  const pools = {}
  for (const [id, p] of Object.entries(charPools)) {
    pools[id] = { n: p.name?.cn || id, t: EF_CHAR_POOL_TYPE[p.type] ?? `char:${p.type}`, up: p.upCharIds ?? [] }
  }
  for (const [id, p] of Object.entries(weaponPools)) {
    pools[id] = { n: p.name?.cn || id, t: EF_WEAPON_POOL_TYPE[p.type] ?? `weapon:${p.type}`, up: p.upWeaponIds ?? [] }
  }
  const items = {}
  for (const [id, item] of Object.entries(itemTable)) {
    if (!/^(chr|wpn)_/.test(id) || !EF_ITEM_TYPES.has(String(item.type))) continue
    items[id] = { n: item.name?.cn || id, r: Number(item.rarity) || 0 }
  }

  let avatars = []
  try {
    avatars = await syncEndfieldAvatars(items)
  } catch (error) {
    console.warn(`终末地头像同步失败（页面会显示文字占位）：${error.message}`)
  }

  const content = JSON.stringify({ generatedAt: new Date().toISOString(), pools, items, avatars })
  await writeFile(metaFile, content)
  console.log(
    `已写入 ${path.relative(process.cwd(), metaFile)}：卡池 ${Object.keys(pools).length}，` +
      `角色与武器 ${Object.keys(items).length}，头像 ${avatars.length}，大小 ${(content.length / 1024).toFixed(0)} KB`,
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const normalizeName = (name) => name.replaceAll('_', '').replaceAll(' ', '')

/** 列出 BWIKI 上全部“XX头像.png”“XX图标.png”文件：名称 → { url, sha1 } */
async function listBwikiImages() {
  const found = new Map(BWIKI_SUFFIXES.map((suffix) => [suffix, new Map()]))
  let cont = {}
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ action: 'query', list: 'allimages', ailimit: '500', aiprop: 'url|sha1', format: 'json', ...cont })
    const res = await fetch(`${BWIKI_API}?${params}`, { headers: BWIKI_HEADERS, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`BWIKI 文件列表 HTTP ${res.status}`)
    const data = await res.json()
    for (const image of data.query?.allimages ?? []) {
      for (const suffix of BWIKI_SUFFIXES) {
        if (image.name.endsWith(suffix)) found.get(suffix).set(normalizeName(image.name.slice(0, -suffix.length)), image)
      }
    }
    if (!data.continue) break
    cont = data.continue
    await sleep(500)
  }
  return found
}

/** 森空岛头像地址索引：游戏 ID → 地址（拉取失败时返回空表，不影响其他来源） */
async function loadSklandIndex() {
  try {
    const index = await fetchJson(SKLAND_INDEX)
    const out = new Map()
    for (const [key, value] of Object.entries(index)) {
      if (key.startsWith('avatar/') && typeof value?.url === 'string') out.set(key.slice('avatar/'.length), value.url)
    }
    return out
  } catch (error) {
    console.warn(`森空岛头像索引拉取失败：${error.message}`)
    return new Map()
  }
}

/** 图片缩放成 128×128：接近正方形的完整缩放（四周透明），竖长的半身像从顶部裁成正方形 */
async function toAvatarWebp(input, target) {
  const image = sharp(input)
  const { width = 1, height = 1 } = await image.metadata()
  const square = Math.abs(width / height - 1) < 0.12
  await image
    .resize(AVATAR_SIZE, AVATAR_SIZE, square ? { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } } : { fit: 'cover', position: 'top' })
    .webp({ quality: 82 })
    .toFile(target)
}

/**
 * 为每个角色 / 武器按顺序尝试各个来源，只下载新增或变化的图片（按来源地址 + sha1 判断），串行并间隔请求。
 * 返回已有头像的 ID 列表。
 */
async function syncEndfieldAvatars(items) {
  await mkdir(EF_AVATAR_DIR, { recursive: true })
  const manifestFile = path.join(EF_AVATAR_DIR, 'manifest.json')
  const manifest = (await exists(manifestFile)) ? JSON.parse(await readFile(manifestFile, 'utf8')) : {}
  const overrides = (await exists(OVERRIDES_FILE)) ? (JSON.parse(await readFile(OVERRIDES_FILE, 'utf8')).items ?? {}) : {}
  let bwiki = new Map(BWIKI_SUFFIXES.map((suffix) => [suffix, new Map()]))
  try {
    bwiki = await listBwikiImages()
  } catch (error) {
    console.warn(`BWIKI 文件列表获取失败，改用其他来源：${error.message}`)
  }
  const skland = await loadSklandIndex()

  const stats = { downloaded: { override: 0, bwiki: 0, skland: 0 }, cached: 0, missing: [], failed: 0 }
  const avatars = []
  for (const [id, item] of Object.entries(items)) {
    const key = normalizeName(item.n)
    const bwikiImage = BWIKI_SUFFIXES.map((suffix) => bwiki.get(suffix).get(key)).find(Boolean)
    const candidates = [
      overrides[id] && { source: 'override', url: overrides[id], version: overrides[id] },
      bwikiImage && { source: 'bwiki', url: bwikiImage.url, version: `${bwikiImage.url}#${bwikiImage.sha1}` },
      skland.get(SKLAND_ALIASES[id] ?? id) && { source: 'skland', url: skland.get(SKLAND_ALIASES[id] ?? id), version: skland.get(SKLAND_ALIASES[id] ?? id) },
    ].filter((c) => c && ALLOWED_IMAGE_URL.test(c.url))

    const target = path.join(EF_AVATAR_DIR, `${id}.webp`)
    const hasFile = await exists(target)
    // 已经从排在最前的可用来源下载过同一版本，跳过
    if (hasFile && candidates[0] && manifest[id] === candidates[0].version) {
      stats.cached++
      avatars.push(id)
      continue
    }
    let done = false
    for (const candidate of candidates) {
      if (hasFile && manifest[id] === candidate.version) {
        // 更靠前的来源下载失败，但当前文件来自这个来源的同一版本，保留
        done = true
        stats.cached++
        break
      }
      try {
        const headers = candidate.source === 'bwiki' ? BWIKI_HEADERS : PLAIN_HEADERS
        const res = await fetch(candidate.url, { headers, signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await toAvatarWebp(Buffer.from(await res.arrayBuffer()), target)
        manifest[id] = candidate.version
        stats.downloaded[candidate.source]++
        done = true
        await sleep(250)
        break
      } catch (error) {
        console.warn(`${item.n}：从 ${candidate.source} 下载失败（${error.message}），尝试下一个来源`)
      }
    }
    if (done || hasFile) avatars.push(id)
    else if (candidates.length) stats.failed++
    else stats.missing.push(item.n)
  }
  await writeFile(manifestFile, JSON.stringify(manifest))
  const d = stats.downloaded
  console.log(
    `终末地头像：新增 ${d.override + d.bwiki + d.skland}（手动 ${d.override}、BWIKI ${d.bwiki}、森空岛 ${d.skland}），` +
      `已有 ${stats.cached}，失败 ${stats.failed}，暂无来源 ${stats.missing.length}` +
      `${stats.missing.length ? `（${stats.missing.join('、')}）` : ''}`,
  )
  return avatars
}

async function main() {
  await syncEndfield()
  await syncArknights()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
