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
 *   - 明日方舟干员：PRTS 的 Cargo 表 chara 为主（公告后就会收录），Kengxxiao/ArknightsGameData 的干员表为备，两者合并
 *   - 明日方舟卡池：类型、开放时间、联动 / 限定参数只有游戏数据的卡池表里有（Kengxxiao/ArknightsGameData）；
 *     UP 名单取自 PRTS（weedy.prts.wiki 的服务器侧卡池详情），GitHub 还没收录的新卡池先按 PRTS 建一条
 *   - 明日方舟头像：PRTS（torappu.prts.wiki）为主，yuanyan3060/ArknightsGameResource（GitHub）为备；
 *     统一缩放为 128×128 WebP 后放在本站同源路径下，分享图导出时不会出现跨域问题。
 *   任一来源拉取失败都不阻塞构建，只有全部来源都失败时才报错。
 *
 * 这些请求都发生在构建阶段（本地或 GitHub Actions），按需串行或低并发，只下载新增的图片。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const OUT_DIR = path.resolve('public/gamedata')
const AVATAR_DIR = path.join(OUT_DIR, 'avatars')
const AVATAR_SIZE = 128
/** 头像下载并发数（只下载新增的头像，对来源站压力很小） */
const CONCURRENCY = 4

const GAMEDATA = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata'
const WEEDY_GACHA = 'https://weedy.prts.wiki/gacha_table.json'
const PRTS_API = 'https://prts.wiki/api.php'
const PRTS_PROFESSION = { 先锋: 'PIONEER', 近卫: 'WARRIOR', 重装: 'TANK', 狙击: 'SNIPER', 术师: 'CASTER', 医疗: 'MEDIC', 辅助: 'SUPPORT', 特种: 'SPECIAL' }
/** 按顺序尝试：PRTS 为主，GitHub 资源仓库为备 */
const AVATAR_SOURCES = [
  (id) => `https://torappu.prts.wiki/assets/char_avatar/${id}.png`,
  (id) => `https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar/${id}.png`,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** PRTS 偶尔会直接断开连接，失败时退避重试两次 */
async function fetchJson(url, timeoutMs = 60_000) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': SCRIPT_UA }, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
      return await res.json()
    } catch (error) {
      if (attempt >= 3) throw error
      await sleep(2000 * attempt)
    }
  }
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
    // 泛称卡池：名称可由 PRTS 卡池一览中的具体名称替换（见 applyPrtsPoolPages），写出前删除这个标记
    if (generic) pool.generic = true
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
    // 获得方式（招募寻访 / 活动获得 / 凭证交易所 / 集成战略获得 …），用于图鉴区分能不能从寻访中抽到
    if (c.itemObtainApproach) chars[id].o = c.itemObtainApproach
    // 特殊玩法里的干员（预备干员、集成战略的临时干员等），不出现在图鉴里
    if (c.isNotObtainable) chars[id].x = 1
  }
  return chars
}

/** PRTS 的 Cargo 表 chara：charId、中文名、星级（0 起）、职业（中文） */
async function fetchPrtsChars() {
  const chars = {}
  for (let offset = 0; offset < 5000; offset += 500) {
    const params = new URLSearchParams({
      action: 'cargoquery',
      tables: 'chara',
      fields: 'chara.charId=id,chara.cn=cn,chara.rarity=rarity,chara.profession=prof',
      limit: '500',
      offset: String(offset),
      format: 'json',
    })
    const data = await fetchJson(`${PRTS_API}?${params}`)
    const rows = data.cargoquery ?? []
    for (const { title: row } of rows) {
      if (!row.id?.startsWith('char_') || !row.cn) continue
      chars[row.id] = { n: row.cn, r: Number(row.rarity) + 1, p: PRTS_PROFESSION[row.prof] ?? row.prof }
    }
    if (rows.length < 500) break
    await sleep(1000)
  }
  return chars
}

// ───────────── PRTS 卡池一览（卡池具体名称 + 与现有数据的比对） ─────────────

const PRTS_POOL_PAGES = (year) => [
  { group: 'limited', page: '卡池一览/限时寻访' },
  ...Array.from({ length: year - 2018 }, (_, i) => ({ group: 'standard', page: `卡池一览/常驻标准寻访/${2019 + i}` })),
  ...Array.from({ length: year - 2022 }, (_, i) => ({ group: 'kernel', page: `卡池一览/常驻中坚寻访&中坚甄选/${2023 + i}` })),
]
/** 常规轮换池保持“标准寻访 · 日期”，比 PRTS 的编号名称好认 */
const ROTATION_NAME = /^(?:中坚)?干员轮换卡池\d+$/
const POOL_TIME = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})~<br\/>(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/g

const cnTime = (text) => Date.parse(`${text.replace(' ', 'T')}:00+08:00`) / 1000
const looseName = (name) => name.replace(/[\s·【】・]|复刻/g, '')

/** 单元格里 {{干员头像|名称}} 模板中的干员名 */
const avatarNames = (cell = '') => [...cell.matchAll(/\{\{干员头像\|([^|}]+)/g)].map((x) => x[1].trim())

/** 解析卡池一览的表格：每行有卡池名、开放与结束时间、6★ 与 5★ 特定干员 */
function parsePrtsPoolPage(wikitext, group) {
  const rows = []
  for (const m of wikitext.matchAll(POOL_TIME)) {
    const head = wikitext.slice(wikitext.lastIndexOf('\n|-', m.index), m.index)
    const rest = wikitext.slice(m.index + m[0].length)
    // 甄选卡池的单元格里嵌套了表格，嵌套表格的行以“{{干员头像”开头，不当作下一行
    const next = rest.search(/\n\|-\s*\n\|(?!\s*\{\{干员头像)/)
    const body = next === -1 ? rest : rest.slice(0, next)
    const label = [...head.matchAll(/\[\[(?!文件:)([^|\]]+)(?:\|([^\]]+))?\]\]/g)].at(-1)
    const linkTarget = head.match(/link=([^|\]]+)/)?.[1]
    const name = (label ? label[2] || label[1] : linkTarget ?? '').replace(/^寻访模拟\//, '').trim()
    const cells = body.split('\n|')
    rows.push({
      group,
      name,
      o: cnTime(m[1]),
      e: cnTime(m[2]),
      up6: avatarNames(cells[1]),
      // 甄选（玩家自选）和“寻访池内只有以上干员”的卡池，列出的不是概率提升对象
      notUp: /可甄选|寻访池内只有以上/.test(body),
    })
  }
  return rows
}

async function fetchPrtsPoolRows() {
  const rows = []
  for (const { group, page } of PRTS_POOL_PAGES(new Date().getFullYear())) {
    const params = new URLSearchParams({ action: 'parse', page, prop: 'wikitext', format: 'json' })
    const data = await fetchJson(`${PRTS_API}?${params}`)
    if (data.parse?.wikitext?.['*']) rows.push(...parsePrtsPoolPage(data.parse.wikitext['*'], group))
    await sleep(1000)
  }
  return rows
}

function poolGroup(ruleType) {
  if (ruleType === 'NORMAL' || ruleType === 'DOUBLE') return 'standard'
  if (ruleType.startsWith('CLASSIC') || ruleType === 'FESCLASSIC') return 'kernel'
  return 'limited'
}

/**
 * 按开放时间（12 小时内）和名称把 PRTS 的行对应到游戏数据的卡池；
 * 给泛称卡池换上具体名称，并在日志中列出 UP 名单不一致、以及 PRTS 有而游戏数据还没有的近期卡池。
 */
function applyPrtsPoolPages(pools, rows, chars) {
  const nameToId = new Map()
  for (const [id, c] of Object.entries(chars)) if (!nameToId.has(c.n)) nameToId.set(c.n, id)
  const stats = { matched: 0, renamed: 0, mismatched: [], recentMissing: [] }
  const now = Date.now() / 1000
  for (const row of rows) {
    const sameGroup = Object.entries(pools).filter(([, p]) => p.o && Math.abs(p.o - row.o) <= 12 * 3600 && poolGroup(p.t) === row.group)
    // 联合行动在游戏数据里是普通标准池，但 PRTS 列在限时寻访里：同组找不到时按开放时间完全一致跨组匹配
    const near = sameGroup.length ? sameGroup : Object.entries(pools).filter(([, p]) => p.o && Math.abs(p.o - row.o) <= 60)
    const named = near.filter(([, p]) => row.name && (looseName(row.name).includes(looseName(p.n)) || looseName(p.n).includes(looseName(row.name))))
    const exact = near.filter(([, p]) => Math.abs(p.o - row.o) <= 60)
    const match = named.length === 1 ? named[0] : exact.length === 1 ? exact[0] : near.length === 1 ? near[0] : null
    if (!match) {
      if (row.o > now - 30 * 86400) stats.recentMissing.push(`${row.name}（${DAY.format(row.o * 1000)}）`)
      continue
    }
    stats.matched++
    const [id, pool] = match
    if (pool.generic && row.name && !ROTATION_NAME.test(row.name)) {
      // 不带编号的名称（如早期的“联合行动”“定向甄选”）加上开放日期以便区分
      pool.n = /\d/.test(row.name) ? row.name : `${row.name} · ${DAY.format(pool.o * 1000)}`
      stats.renamed++
    }
    const have = pool.up?.['6']
    if (row.notUp || !have || !row.up6.length) continue
    const fromPage = row.up6.map((n) => nameToId.get(n))
    if (fromPage.includes(undefined)) continue
    if (fromPage.toSorted().join() !== have.toSorted().join()) {
      stats.mismatched.push(`${id} ${pool.n}：PRTS 卡池一览 ${row.up6.join('、')}，现有 ${have.map((c) => chars[c]?.n ?? c).join('、')}`)
    }
  }
  console.log(`PRTS 卡池一览：${rows.length} 行，对应上 ${stats.matched} 个卡池，换上具体名称 ${stats.renamed} 个`)
  for (const line of stats.mismatched) console.warn(`  UP 名单不一致：${line}`)
  if (stats.recentMissing.length) console.warn(`  PRTS 有、游戏数据还没有的近期卡池：${stats.recentMissing.join('、')}`)
}

/** 与前端 akRuleType 的回退规则一致：按 poolId 前缀推断规则类型 */
function inferRuleType(poolId) {
  if (poolId.startsWith('BOOT')) return 'BOOT'
  if (poolId.startsWith('CLASSIC_ATTAIN')) return 'CLASSIC_ATTAIN'
  if (poolId.startsWith('CLASSIC_DOUBLE')) return 'CLASSIC_DOUBLE'
  const prefix = poolId.split('_')[0] ?? ''
  return prefix === 'NORM' ? 'NORMAL' : prefix
}

async function downloadAvatar(id) {
  const target = path.join(AVATAR_DIR, `${id}.webp`)
  if (await exists(target)) return 'cached'
  for (const source of AVATAR_SOURCES) {
    try {
      const res = await fetch(source(id), { headers: { 'user-agent': SCRIPT_UA }, signal: AbortSignal.timeout(30_000) })
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

  const [prtsChars, characterTable, gachaTable, weedy, version] = await Promise.allSettled([
    fetchPrtsChars(),
    fetchJson(`${GAMEDATA}/excel/character_table.json`),
    fetchJson(`${GAMEDATA}/excel/gacha_table.json`),
    fetchJson(WEEDY_GACHA),
    fetchText(`${GAMEDATA}/excel/data_version.txt`),
  ])
  for (const [label, result] of [
    ['PRTS 干员表', prtsChars],
    ['GitHub 干员表', characterTable],
    ['GitHub 卡池表', gachaTable],
    ['PRTS 卡池详情（UP 名单）', weedy],
  ]) {
    if (result.status === 'rejected') console.warn(`${label}拉取失败：${result.reason?.message ?? result.reason}`)
  }
  if (prtsChars.status === 'rejected' && characterTable.status === 'rejected') throw new Error('干员表的两个来源都拉取失败')
  if (gachaTable.status === 'rejected' && weedy.status === 'rejected') throw new Error('卡池的两个来源都拉取失败')

  // 干员：以 PRTS 的名单为准（公告后就会收录新干员）。两边都有的干员用游戏内名称——
  // PRTS 为区分页面会加后缀，如“预备干员-术师(卫戍协议)”
  const repoChars = characterTable.status === 'fulfilled' ? buildChars(characterTable.value) : {}
  const wikiChars = prtsChars.status === 'fulfilled' ? prtsChars.value : {}
  const chars = { ...wikiChars, ...repoChars }
  const onlyWiki = Object.keys(wikiChars).filter((id) => !repoChars[id])
  console.log(
    `干员：PRTS ${Object.keys(wikiChars).length}，GitHub ${Object.keys(repoChars).length}，合并后 ${Object.keys(chars).length}` +
      `${onlyWiki.length ? `（仅 PRTS 有：${onlyWiki.map((id) => wikiChars[id].n).join('、')}）` : ''}`,
  )

  // 卡池：类型与时间来自游戏数据；UP 名单来自 PRTS；GitHub 还没收录的新卡池先按 PRTS 建一条
  const upLists = weedy.status === 'fulfilled' ? extractUpLists(weedy.value) : {}
  const pools = gachaTable.status === 'fulfilled' ? buildPools(gachaTable.value, upLists) : {}
  const wikiOnlyPools = []
  for (const entry of weedy.status === 'fulfilled' ? (weedy.value.gachaPoolClient ?? []) : []) {
    const id = entry.gachaPoolId
    if (!id || pools[id]) continue
    pools[id] = { n: '', t: inferRuleType(id), o: 0, e: 0, ...(upLists[id] ? { up: upLists[id] } : {}) }
    wikiOnlyPools.push(id)
  }
  console.log(`卡池：${Object.keys(pools).length}，UP 名单 ${Object.keys(upLists).length}${wikiOnlyPools.length ? `，仅 PRTS 有：${wikiOnlyPools.join('、')}` : ''}`)
  try {
    applyPrtsPoolPages(pools, await fetchPrtsPoolRows(), chars)
  } catch (error) {
    console.warn(`PRTS 卡池一览拉取失败，卡池名保持“类型 · 日期”：${error.message}`)
  }
  for (const pool of Object.values(pools)) delete pool.generic

  const ids = Object.keys(chars)
  const outcomes = await mapLimited(ids, CONCURRENCY, downloadAvatar)
  const avatars = ids.filter((_, i) => outcomes[i] !== 'missing')
  const count = (kind) => outcomes.filter((o) => o === kind).length
  console.log(`头像：新增 ${count('downloaded')}，已有 ${count('cached')}，缺失 ${count('missing')}`)

  const meta = {
    version: version.status === 'fulfilled' ? version.value.split('\n')[0] : `prts-${new Date().toISOString().slice(0, 10)}`,
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

  try {
    await checkBwikiRoster(items)
  } catch (error) {
    console.warn(`BWIKI 名单比对失败：${error.message}`)
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

const normalizeName = (name) => name.replaceAll('_', '').replaceAll(' ', '')

/** BWIKI 某个分类下的全部页面名 */
async function listBwikiCategory(category) {
  const names = []
  let cont = {}
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`, cmlimit: '500', cmtype: 'page', format: 'json', ...cont })
    const res = await fetch(`${BWIKI_API}?${params}`, { headers: BWIKI_HEADERS, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`BWIKI 分类 ${category} HTTP ${res.status}`)
    const data = await res.json()
    names.push(...(data.query?.categorymembers ?? []).map((m) => m.title))
    if (!data.continue) break
    cont = data.continue
    await sleep(500)
  }
  return names
}

/**
 * 比对 BWIKI 的“干员”“武器”分类与游戏数据的名单，只在构建日志里提示差异，不影响生成的数据。
 * 名单以游戏数据为准；BWIKI 更新后，这里可以发现改名、漏收录等问题。
 */
async function checkBwikiRoster(items) {
  for (const [category, prefix] of [['干员', 'chr_'], ['武器', 'wpn_']]) {
    const wiki = new Set((await listBwikiCategory(category)).map(normalizeName))
    const game = new Set(Object.entries(items).filter(([id]) => id.startsWith(prefix)).map(([, item]) => normalizeName(item.n)))
    const missingInWiki = [...game].filter((n) => !wiki.has(n))
    const missingInGame = [...wiki].filter((n) => !game.has(n))
    console.log(
      `BWIKI 名单比对（${category}）：游戏数据 ${game.size}，BWIKI ${wiki.size}` +
        `${missingInWiki.length ? `；BWIKI 还没有：${missingInWiki.join('、')}` : ''}` +
        `${missingInGame.length ? `；游戏数据里没有（可能改名或未实装）：${missingInGame.join('、')}` : ''}`,
    )
  }
}

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
