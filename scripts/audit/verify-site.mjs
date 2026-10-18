#!/usr/bin/env node
/**
 * 核对线上网站：任何人都可以运行，只需要 Node 20+；验证构建证明还需要 GitHub CLI（gh，需登录）。
 *
 *   node scripts/audit/verify-site.mjs                       # 正式环境，核对代码文件
 *   node scripts/audit/verify-site.mjs --all                 # 核对全部文件（含图片、字体、文字识别模型）
 *   node scripts/audit/verify-site.mjs --env preview         # 测试环境（https://ark-next.kaltsit.dev）
 *
 * 做什么：
 *   1. 读取线上的 /api/cloud/v1/info（正在运行的 commit）和 /build-manifest.json（构建清单）；
 *   2. 用 gh 验证构建清单的构建证明：必须由本仓库对应环境的部署流程签发，来自同一个 commit；
 *   3. 逐个下载网站上的文件，和清单里的 SHA-256 对比；
 *   4. 检查首页的安全响应头（CSP 等）和仓库里 _headers 的设置一致。
 * 只发出 GET 请求，只访问被核对的网站和 GitHub。
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { attestationArgs, childEnv, ENVIRONMENTS, isCodeFile, MANIFEST_PATH, provenancesOf, servedPath, sha256Hex, validateManifest } from './lib.mjs'

const run = promisify(execFile)

const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    env: { type: 'string' },
    'expect-commit': { type: 'string' },
    all: { type: 'boolean', default: false },
    'skip-attestation': { type: 'boolean', default: false },
    report: { type: 'string' },
    'manifest-out': { type: 'string' },
  },
})

if (values.env && !Object.hasOwn(ENVIRONMENTS, values.env)) throw new Error('--env 应为 production 或 preview')
const site = new URL(values.site ?? ENVIRONMENTS[values.env ?? 'production'].site)
const local = site.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(site.hostname)
if ((site.protocol !== 'https:' && !local) || site.pathname !== '/' || site.search || site.hash) throw new Error('--site 应为 https://域名（本地预览可以用 http://localhost:端口）')
const environment = Object.entries(ENVIRONMENTS).find(([, e]) => e.site === site.origin)?.[0] ?? null

const report = { site: site.origin, checkedAt: new Date().toISOString(), commit: null, environment, attestation: null, files: null, headers: null, problems: [] }
const problem = (text) => {
  report.problems.push(text)
  console.log(`✗ ${text}`)
}

/** 只请求被核对网站上的地址；跟随重定向后也必须还在这个网站上 */
async function get(path) {
  const url = new URL(path, site)
  if (url.origin !== site.origin) throw new Error(`地址不在被核对的网站上：${path}`)
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60_000) })
  if (new URL(res.url).origin !== site.origin) throw new Error(`${path} 被重定向到了别的网站`)
  return res
}

async function main() {
  // 1. 线上的 commit 和构建清单（刚部署完时可以指定要等的 commit，最多等 3 分钟生效）
  const expect = values['expect-commit']
  if (expect !== undefined && !/^[0-9a-f]{40}$/.test(expect)) throw new Error('--expect-commit 应为 40 位 commit')
  for (let i = 0; ; i++) {
    const info = await (await get('/api/cloud/v1/info')).json()
    report.commit = typeof info?.commit === 'string' ? info.commit : null
    if (!expect || report.commit === expect || i >= 18) break
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  if (expect && report.commit !== expect) problem(`线上运行的 commit（${report.commit}）不是刚部署的 ${expect}`)
  console.log(`线上运行的 commit：${report.commit ?? '（未知）'}`)
  const manifestRes = await get(`/${MANIFEST_PATH}`)
  // 单页应用对不存在的路径也返回首页（HTML），所以要看内容类型
  if (!manifestRes.ok || !/json/i.test(manifestRes.headers.get('content-type') ?? '')) throw new Error(`网站上没有构建清单 /${MANIFEST_PATH}（HTTP ${manifestRes.status}）`)
  const manifestBytes = Buffer.from(await manifestRes.arrayBuffer())
  if (manifestBytes.length > 2 * 1024 * 1024) throw new Error('构建清单太大')
  const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')))
  if (values['manifest-out']) writeFileSync(values['manifest-out'], manifestBytes)
  console.log(`构建清单：commit ${manifest.commit}，${manifest.environment}，sha256 ${sha256Hex(manifestBytes)}`)
  if (manifest.commit !== report.commit) problem(`构建清单的 commit（${manifest.commit}）和线上运行的（${report.commit}）不同`)
  if (environment && manifest.environment !== environment) problem(`构建清单写的是 ${manifest.environment}，但这是 ${environment} 的网站`)

  // 2. 构建证明：由本仓库对应环境的部署流程、从同一个 commit 签发
  if (values['skip-attestation']) {
    report.attestation = { skipped: true }
    console.log('- 跳过了构建证明的验证（--skip-attestation）')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'arkrecord-audit-'))
    try {
      const file = join(dir, MANIFEST_PATH)
      writeFileSync(file, manifestBytes)
      const { stdout } = await run('gh', attestationArgs(file, manifest.workflow), { env: childEnv(), maxBuffer: 16 * 1024 * 1024 })
      const provenances = provenancesOf(JSON.parse(stdout))
      const provenance = provenances.find((p) => p.commit === manifest.commit)
      report.attestation = { verified: Boolean(provenance), workflow: manifest.workflow, ...(provenance ?? provenances[0]) }
      if (provenance) console.log(`✓ 构建证明有效：${manifest.workflow}，${provenance.ref ?? ''} ${provenance.run ?? ''}`)
      else problem(`构建清单的构建证明里没有 commit ${manifest.commit}（有：${provenances.map((p) => p.commit).join('，')}）`)
    } catch (error) {
      report.attestation = { verified: false }
      problem(`构建清单的构建证明验证失败：${String(error?.stderr || error?.message || error).trim().split('\n').slice(-3).join(' ')}`)
      if (error?.code === 'ENOENT') console.log('  需要安装 GitHub CLI（https://cli.github.com/）并登录（gh auth login）；也可以加 --skip-attestation 只核对文件。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 3. 逐个核对文件
  const entries = Object.entries(manifest.files).filter(([p]) => values.all || isCodeFile(p))
  let same = 0
  const queue = [...entries]
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [p, e] = item
      try {
        const res = await get(servedPath(p))
        const body = Buffer.from(await res.arrayBuffer())
        if (!res.ok) problem(`${p}：HTTP ${res.status}`)
        else if (sha256Hex(body) !== e.sha256) problem(`${p}：线上的内容和构建清单不同`)
        else same++
      } catch (error) {
        problem(`${p}：${error?.message ?? error}`)
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  report.files = { checked: entries.length, same, total: Object.keys(manifest.files).length, scope: values.all ? 'all' : 'code' }
  console.log(`${same === entries.length ? '✓' : '✗'} 文件：核对 ${entries.length} 个（${values.all ? '全部' : '代码文件；加 --all 核对全部'}），一致 ${same} 个`)

  // 4. 首页的安全响应头
  const expected = manifest.headers?.['/*'] ?? {}
  const page = await get('/')
  const wrong = Object.entries(expected).filter(([name, value]) => page.headers.get(name) !== value)
  report.headers = { checked: Object.keys(expected).length, same: Object.keys(expected).length - wrong.length }
  for (const [name] of wrong) problem(`首页的响应头 ${name} 和仓库里 _headers 的设置不同`)
  if (!wrong.length) console.log(`✓ 首页的 ${Object.keys(expected).length} 个安全响应头和 _headers 一致`)
}

try {
  await main()
} catch (error) {
  problem(`核对没有完成：${error?.message ?? error}`)
}
if (values.report) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`)
console.log(report.problems.length ? `\n发现 ${report.problems.length} 个问题。` : '\n全部一致：线上网站提供的文件就是这个 commit 由部署流程构建的结果。')
process.exit(report.problems.length ? 1 : 0)
