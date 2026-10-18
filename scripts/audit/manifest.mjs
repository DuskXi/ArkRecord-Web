#!/usr/bin/env node
/**
 * 构建清单：
 *
 *   部署时生成（GitHub Actions 里，构建之后、部署之前）：
 *     node scripts/audit/manifest.mjs --env production
 *     → dist/client/build-manifest.json（随网站一起公开）
 *     → dist/attestation-subjects.sha256：要签发构建证明的文件（清单本身、Worker 的每个模块），
 *       格式同 sha256sum，交给 actions/attest-build-provenance 的 subject-checksums
 *
 *   自己从源码重新构建，和线上的清单对比（任何人都可以做）：
 *     git checkout <commit> && npm ci && GITHUB_SHA=<commit> npx vite build
 *     node scripts/audit/manifest.mjs --compare https://ark.kaltsit.dev/build-manifest.json
 *
 * 对比时游戏数据（gamedata/）和头像不算：它们是部署时从外部来源拉取的，不在仓库里；网站上的这些文件仍然由清单和构建证明覆盖。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildManifest, ENVIRONMENTS, MANIFEST_PATH, REPOSITORY, sha256Hex, validateManifest } from './lib.mjs'

const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    dist: { type: 'string', default: 'dist' },
    compare: { type: 'string' },
  },
})

/** dist 下的 Worker 构建目录（含 wrangler.json 的那个；测试环境 arkrecord_next，正式环境 arkrecord） */
function findWorkerDir(dist) {
  const dirs = readdirSync(dist).filter((d) => d !== 'client' && existsSync(join(dist, d, 'wrangler.json')))
  if (dirs.length !== 1) throw new Error(`应当正好有一个 Worker 构建目录，找到 ${dirs.length} 个：${dirs.join(', ')}`)
  const dir = join(dist, dirs[0])
  const name = JSON.parse(readFileSync(join(dir, 'wrangler.json'), 'utf8')).name
  return { dir, name }
}

function localManifest(environment, commit) {
  const worker = findWorkerDir(values.dist)
  const githubRun =
    process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL
      ? { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1', url: `${process.env.GITHUB_SERVER_URL}/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }
      : null
  return buildManifest({
    clientDir: join(values.dist, 'client'),
    workerDir: worker.dir,
    workerName: worker.name,
    commit,
    environment,
    workflow: ENVIRONMENTS[environment].workflow,
    run: githubRun,
  })
}

async function loadManifest(source) {
  if (source.startsWith('https://')) {
    const res = await fetch(source, { headers: { 'cache-control': 'no-cache' } })
    if (!res.ok) throw new Error(`下载清单失败：HTTP ${res.status}`)
    return validateManifest(await res.json())
  }
  return validateManifest(JSON.parse(readFileSync(source, 'utf8')))
}

const notReproducible = (p) => p.startsWith('gamedata/')

if (values.compare) {
  const published = await loadManifest(values.compare)
  const local = localManifest(published.environment, published.commit)
  console.log(`线上清单：commit ${published.commit}（${published.environment}）`)
  let same = 0
  const problems = []
  let skipped = 0
  for (const [p, e] of Object.entries(published.files)) {
    if (notReproducible(p)) {
      skipped++
      continue
    }
    const mine = local.files[p]
    if (!mine) problems.push(`本地构建里没有 ${p}`)
    else if (mine.sha256 !== e.sha256) problems.push(`${p} 不同`)
    else same++
  }
  for (const p of Object.keys(local.files)) if (!notReproducible(p) && !(p in published.files)) problems.push(`线上清单里没有 ${p}`)
  for (const [p, e] of Object.entries(published.worker.modules)) {
    if (notReproducible(p)) continue
    const mine = local.worker.modules[p]
    if (!mine) problems.push(`本地构建里没有 Worker 模块 ${p}`)
    else if (mine.sha256 !== e.sha256) problems.push(`Worker 模块 ${p} 不同`)
    else same++
  }
  console.log(`一致 ${same} 个；跳过 ${skipped} 个游戏数据文件（部署时从外部拉取）`)
  if (problems.length) {
    console.log(`不一致 ${problems.length} 个：`)
    for (const p of problems.slice(0, 50)) console.log(`  - ${p}`)
    console.log('请确认：检出的是同一个 commit、执行了 npm ci、构建时设置了 GITHUB_SHA=<commit>，并且没有修改任何文件。')
    process.exit(1)
  }
  console.log('本地从源码构建的结果和线上清单完全一致。')
} else {
  const environment = values.env
  if (!Object.hasOwn(ENVIRONMENTS, environment ?? '')) throw new Error('--env 应为 production 或 preview')
  const commit = process.env.GITHUB_SHA
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('需要 GITHUB_SHA（构建时的 commit）')
  const manifest = validateManifest(localManifest(environment, commit))
  const out = join(values.dist, 'client', MANIFEST_PATH)
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(out, bytes)
  // 构建证明的对象：清单（覆盖网站上的全部文件）和 Cloudflare 保存的每个 Worker 模块（核对线上版本时逐个验证）
  const subjects = [[sha256Hex(bytes), MANIFEST_PATH], ...Object.entries(manifest.worker.modules).map(([name, e]) => [e.sha256, `worker/${name}`])]
  writeFileSync(join(values.dist, 'attestation-subjects.sha256'), subjects.map(([hex, name]) => `${hex}  ${name}\n`).join(''))
  console.log(`已生成 ${out}：${Object.keys(manifest.files).length} 个文件，Worker ${manifest.worker.name} 的 ${Object.keys(manifest.worker.modules).length} 个模块`)
}
