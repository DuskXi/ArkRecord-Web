#!/usr/bin/env node
/**
 * 把 verify-site.mjs 和 verify-worker.mjs 的报告合并成一份（之后签发构建证明，留下公开、删不掉的记录），
 * 并输出 Actions 页面上显示的摘要（Markdown）。
 *
 *   node scripts/audit/summary.mjs --site site.json --worker worker.json --out audit-report.json >> "$GITHUB_STEP_SUMMARY"
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { site: { type: 'string' }, worker: { type: 'string' }, out: { type: 'string' }, environment: { type: 'string' } } })

const read = (path) => (path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const site = read(values.site)
const worker = read(values.worker)
const problems = [...(site?.problems ?? []), ...(worker?.problems ?? [])]
if (!site) problems.push('没有网站核对的报告')
if (!worker) problems.push('没有 Worker 核对的报告')

const combined = {
  schema: 'arkrecord-audit-report/1',
  environment: values.environment ?? site?.environment ?? worker?.environment ?? null,
  checkedAt: new Date().toISOString(),
  ok: problems.length === 0,
  problems,
  site,
  worker,
}
if (values.out) writeFileSync(values.out, `${JSON.stringify(combined, null, 2)}\n`)

/** 摘要里的文字：去掉可能被当作 Markdown / HTML 的字符 */
const esc = (v) => String(v ?? '—').replace(/[<>|`*_[\]\\]/g, (c) => `\\${c}`).replace(/\n/g, ' ')

const lines = [`## 线上部署核对：${esc(combined.environment)} ${combined.ok ? '✅ 全部一致' : '❌ 发现问题'}`, '']
if (site) {
  lines.push(`- 网站：${esc(site.site)}，线上 commit \`${esc(site.commit)}\``)
  const a = site.attestation
  lines.push(`- 构建清单的构建证明：${a?.verified ? `有效（${esc(a.ref)}，${esc(a.run)}）` : a?.skipped ? '跳过' : '无效'}`)
  if (site.files) lines.push(`- 网站文件：核对 ${site.files.checked} 个（${site.files.scope === 'all' ? '全部' : '代码文件'}，共 ${site.files.total} 个），一致 ${site.files.same} 个${site.files.rechecked ? `（其中 ${site.files.rechecked} 个刚部署完时不一致，复查后一致）` : ''}`)
  if (site.headers) lines.push(`- 首页安全响应头：${site.headers.same}/${site.headers.checked} 一致`)
}
if (worker) {
  const v = worker.active?.versions?.[0]
  lines.push(`- 正在运行的 Worker：版本 \`${esc(v?.id)}\`，${v?.attested ? `构建证明有效，commit \`${esc(v.commit)}\`` : '没有构建证明'}`)
  const counts = (worker.versions ?? []).reduce((c, x) => ((c[x.status] = (c[x.status] ?? 0) + 1), c), {})
  lines.push(`- 最近 ${worker.windowHours} 小时上传的 Worker 版本：${worker.versions?.length ?? 0} 个；有构建证明 ${counts.attested ?? 0}，核对开始之前 ${counts['before-audit'] ?? 0}，没有证明 ${counts.unattested ?? 0}`)
}
for (const note of worker?.notes ?? []) lines.push(`- ${esc(note)}`)
if (problems.length) {
  lines.push('', '### 问题', ...problems.map((p) => `- ${esc(p)}`))
}
lines.push('', '核对方法见 SECURITY.md 的“对照线上代码”。完整报告在这次运行的附件里，并签发了构建证明（公开透明日志）。', '')
console.log(lines.join('\n'))
process.exit(0)
