#!/usr/bin/env node
/**
 * 核对 Cloudflare 上实际运行的 Worker 代码（由仓库里公开的定时 Action 运行：外人拿不到 Worker 代码，只有账号持有者能取回）。
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/audit/verify-worker.mjs --env production --manifest build-manifest.json
 *
 * 规则：
 *   1. 最近 72 小时内上传的每一个 Worker 版本（不论谁上传、是否部署过），每个模块都必须有本仓库对应环境的部署流程签发的构建证明，
 *      并且来自同一次构建（同一份构建证明里列出了这个版本的全部模块，见 lib.mjs 的 commonProvenance）。
 *      按时间而不是按个数取版本，连续上传再多版本也挤不出核对范围；定时任务每天运行（部署后也会运行），每个版本至少被核对两次。
 *      在网页后台改密钥也会产生新版本，但代码不变，所以同样有构建证明。
 *      开始签发构建证明之前的版本（版本号小于 lib.mjs 里固定的起点）记为“核对开始之前”。
 *   2. 正在运行的版本，模块必须和网站上公开的构建清单完全一致（清单本身已由 verify-site.mjs 验证过构建证明）。
 *
 * 安全：
 *   - 只发出 GET 请求，地址限定为下面几种 Worker 接口，Cloudflare 令牌只放在请求头里；
 *     按版本取代码用的是 Cloudflare 的 Workers 接口（/workers/workers/…/versions/…?include=modules，测试版），
 *     旧的 /content/v2 不认 version 参数，总是返回当前部署的代码，不能用来核对历史版本；
 *   - 报告只包含版本号、时间、来源、模块哈希和构建来源，不包含账号 ID、邮箱、IP、绑定的值；
 *   - 调用 gh 时只传必要的环境变量，Cloudflare 令牌不会传给子进程。
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { attestationArgs, childEnv, commonProvenance, compareModules, coverBySubjects, ENVIRONMENTS, provenancesOf, sha256Hex, validateManifest } from './lib.mjs'

const run = promisify(execFile)
const API = 'https://api.cloudflare.com/client/v4'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PER_PAGE = 50
/** 时间窗口内的版本多于这个数就当作异常（正常每天只有几次部署） */
const MAX_VERSIONS = 200

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    manifest: { type: 'string' },
    hours: { type: 'string', default: '72' },
    report: { type: 'string' },
  },
})

const config = ENVIRONMENTS[values.env ?? '']
if (!config) throw new Error('--env 应为 production 或 preview')
const token = process.env.CLOUDFLARE_API_TOKEN ?? ''
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
if (!token || !/^[0-9a-f]{32}$/.test(account)) throw new Error('需要环境变量 CLOUDFLARE_API_TOKEN 和 CLOUDFLARE_ACCOUNT_ID')
const hours = Math.min(24 * 30, Math.max(1, Number(values.hours) || 72))
const since = Date.now() - hours * 3600_000

const report = {
  environment: values.env,
  script: config.script,
  workflow: config.workflow,
  auditFromVersion: config.auditFromVersion,
  windowHours: hours,
  checkedAt: new Date().toISOString(),
  active: null,
  versions: [],
  problems: [],
  notes: [],
}
const problem = (text) => {
  report.problems.push(text)
  console.log(`✗ ${text}`)
}

/** Cloudflare 接口：只允许 GET 这几种地址 */
async function cf(kind, arg) {
  if (kind === 'version' && !UUID.test(arg ?? '')) throw new Error('版本号格式不对')
  if (kind === 'versions' && !(Number.isInteger(arg) && arg >= 1 && arg <= 100)) throw new Error('页码不对')
  const workers = `${API}/accounts/${account}/workers/workers/${config.script}`
  const url = {
    deployments: `${API}/accounts/${account}/workers/scripts/${config.script}/deployments`,
    versions: `${workers}/versions?per_page=${PER_PAGE}&page=${arg}`,
    version: `${workers}/versions/${arg}?include=modules`,
  }[kind]
  if (!url) throw new Error('不允许的接口')
  const res = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) {
    // 只报告状态码和 Cloudflare 的错误码，不输出返回内容
    let codes = ''
    try {
      codes = ((await res.json())?.errors ?? []).map((e) => Number(e.code)).filter(Number.isFinite).join(',')
    } catch {
      // 忽略
    }
    throw new Error(`Cloudflare 接口返回 HTTP ${res.status}${codes ? `（错误码 ${codes}）` : ''}`)
  }
  return (await res.json()).result
}

const attestationCache = new Map()
/** 一个模块的构建证明：同样内容只验证一次 */
async function attest(name, data, dir) {
  const digest = sha256Hex(data)
  if (!attestationCache.has(digest)) {
    const file = join(dir, `${digest}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`)
    writeFileSync(file, data)
    let result
    try {
      const { stdout } = await run('gh', attestationArgs(file, config.workflow), { env: childEnv(), maxBuffer: 16 * 1024 * 1024 })
      result = { attested: true, provenances: provenancesOf(JSON.parse(stdout)) }
    } catch (error) {
      const text = String(error?.stderr || error?.message || error)
      result = { attested: false, reason: /no attestations|not found|404/i.test(text) ? '没有构建证明' : `验证失败：${text.trim().split('\n').at(-1)?.slice(0, 160)}` }
    }
    attestationCache.set(digest, result)
  }
  return { sha256: digest, size: data.length, ...attestationCache.get(digest) }
}

/** 下载一个版本的模块（代码和 _headers），逐个验证构建证明，并找出它们共同的构建来源 */
async function inspect(id, dir, preferred) {
  const version = await cf('version', id)
  const modules = {}
  for (const m of version?.modules ?? []) {
    if (typeof m?.name !== 'string' || typeof m.content_base64 !== 'string') throw new Error('Cloudflare 返回的模块格式不对')
    modules[m.name.slice(0, 200)] = await attest(m.name, Buffer.from(m.content_base64, 'base64'), dir)
  }
  // 自己没查到证明、但列在另一个模块的有效证明里的，也算有证明（lib.mjs 的 coverBySubjects）
  const names = Object.keys(modules)
  coverBySubjects(Object.values(modules)).forEach((m, i) => {
    modules[names[i]] = m
  })
  const list = Object.values(modules)
  const each = list.length > 0 && list.every((m) => m.attested)
  const common = each ? commonProvenance(list, preferred) : null
  return {
    number: Number.isInteger(version?.number) ? version.number : null,
    attested: each && common !== null,
    commit: common?.commit ?? null,
    // 每个模块都有证明，但没有一次构建同时产生了全部模块：模块被拼凑过
    mixedCommits: each && common === null,
    ref: common?.ref ?? null,
    run: common?.run ?? null,
    modules: Object.fromEntries(
      Object.entries(modules).map(([n, m]) => [n, { sha256: m.sha256, size: m.size, attested: m.attested, ...(m.covered ? { covered: true } : {}), ...(m.reason ? { reason: m.reason } : {}) }]),
    ),
  }
}

const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : null)

async function main() {
  const manifest = values.manifest ? validateManifest(JSON.parse(readFileSync(values.manifest, 'utf8'))) : null
  if (manifest && manifest.environment !== values.env) throw new Error('构建清单的环境和 --env 不同')
  const dir = mkdtempSync(join(tmpdir(), 'arkrecord-worker-'))
  try {
    // 1. 时间窗口内上传的全部版本（新的在前，翻页直到早于窗口）
    const recent = []
    for (let page = 1; page <= Math.ceil(MAX_VERSIONS / PER_PAGE) + 1; page++) {
      const result = await cf('versions', page)
      const items = (Array.isArray(result) ? result : []).filter((v) => UUID.test(v?.id ?? ''))
      const inWindow = items.filter((v) => Date.parse(v.created_on ?? '') >= since)
      recent.push(...inWindow)
      if (items.length < PER_PAGE || inWindow.length < items.length) break
    }
    if (recent.length > MAX_VERSIONS) problem(`最近 ${hours} 小时上传了 ${recent.length} 个版本，数量异常`)
    for (const v of recent.slice(0, MAX_VERSIONS)) {
      const inspected = await inspect(v.id, dir, manifest?.commit ?? null)
      const number = Number.isInteger(v.number) ? v.number : inspected.number
      const audited = number === null || number >= config.auditFromVersion
      const entry = {
        ...inspected,
        id: v.id,
        number,
        createdOn: str(v.created_on, 40),
        source: str(v.source, 40),
        triggeredBy: str(v.annotations?.['workers/triggered_by'], 40),
        tag: str(v.annotations?.['workers/tag']),
        status: inspected.attested ? 'attested' : audited ? 'unattested' : 'before-audit',
      }
      report.versions.push(entry)
      if (entry.status === 'unattested' && !entry.mixedCommits) problem(`版本 ${number ?? v.id}（${entry.createdOn}，来源 ${entry.source}）的代码没有本仓库部署流程签发的构建证明`)
      if (entry.mixedCommits) problem(`版本 ${number ?? v.id} 的各个模块都有构建证明，但不是同一次构建产生的（没有一份构建证明同时列出全部模块）`)
    }
    if (!recent.length) report.notes.push(`最近 ${hours} 小时没有上传新版本。`)

    // 2. 正在运行的版本
    const deployments = (await cf('deployments'))?.deployments ?? []
    const latest = deployments.toSorted((a, b) => String(b.created_on).localeCompare(String(a.created_on)))[0]
    if (!latest) throw new Error('没有找到部署记录')
    const active = (latest.versions ?? []).map((x) => ({ id: str(x.version_id, 40), percentage: x.percentage }))
    report.active = { deployedOn: str(latest.created_on, 40), source: str(latest.source, 40), versions: active }
    if (active.length !== 1 || active[0].percentage !== 100) problem(`正在运行的不是单一版本：${active.map((a) => `${a.id} ${a.percentage}%`).join('，')}`)
    for (const a of active) {
      if (!UUID.test(a.id ?? '')) {
        problem('正在运行的版本号格式不对')
        continue
      }
      const v = report.versions.find((x) => x.id === a.id) ?? { id: a.id, ...(await inspect(a.id, dir, manifest?.commit ?? null)) }
      const beforeAudit = v.number !== null && v.number < config.auditFromVersion
      if (!v.attested && beforeAudit) report.notes.push(`正在运行的版本 ${v.number} 早于开始签发构建证明（第 ${config.auditFromVersion} 版起）。`)
      else if (!v.attested) problem(`正在运行的版本 ${v.number ?? a.id} 没有本仓库部署流程签发的构建证明`)
      if (manifest) {
        for (const p of compareModules(v.modules, manifest.worker.modules)) problem(`正在运行的 Worker 和网站上的构建清单不一致：${p}`)
        if (v.commit && v.commit !== manifest.commit) problem(`正在运行的 Worker 来自 commit ${v.commit}，网站上的构建清单是 ${manifest.commit}`)
      }
      Object.assign(a, { attested: v.attested, commit: v.commit, ref: v.ref, run: v.run })
      console.log(`正在运行：版本 ${a.id}（${a.percentage}%），${v.attested ? `构建证明有效，commit ${v.commit}，${v.run}` : '没有构建证明'}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  problem(`核对没有完成：${error?.message ?? error}`)
}
const counts = report.versions.reduce((c, v) => ((c[v.status] = (c[v.status] ?? 0) + 1), c), {})
console.log(`最近 ${hours} 小时上传的 ${report.versions.length} 个版本：有构建证明 ${counts.attested ?? 0}，核对开始之前 ${counts['before-audit'] ?? 0}，没有证明 ${counts.unattested ?? 0}`)
if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`)
const audited = report.versions.some((v) => v.status !== 'before-audit') || report.active?.versions?.some((a) => a.attested)
for (const note of report.notes) console.log(`- ${note}`)
console.log(
  report.problems.length
    ? `\n发现 ${report.problems.length} 个问题。`
    : audited
      ? '\n全部一致：Cloudflare 上运行的 Worker 代码由本仓库的部署流程构建。'
      : '\n还没有开始签发构建证明之后的版本，暂时没有可以核对的内容。',
)
process.exit(report.problems.length ? 1 : 0)
