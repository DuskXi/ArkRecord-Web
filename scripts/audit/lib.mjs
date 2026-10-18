/**
 * 部署审计的共用函数（只用 Node 自带模块，方便审阅）。说明见 SECURITY.md 的“对照线上代码”。
 *
 * 构建清单（build-manifest.json）：部署时生成，列出网站上每个文件和 Worker 每个模块的 SHA-256，
 * 由 GitHub Actions 签发构建证明（Sigstore 透明日志），并作为静态文件公开在 /build-manifest.json。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

export const REPOSITORY = 'DuskXi/ArkRecord-Web'
export const MANIFEST_SCHEMA = 'arkrecord-build-manifest/1'
export const MANIFEST_PATH = 'build-manifest.json'

/**
 * 两个环境：站点、Worker 名称、签发构建证明的部署流程，以及从哪个 Worker 版本号起开始签发构建证明
 * （之前的版本记为“核对开始之前”）。起点固定写在这里，不从最近的版本推断，避免被大量上传的版本绕过。
 */
export const ENVIRONMENTS = {
  production: { site: 'https://ark.kaltsit.dev', script: 'arkrecord', workflow: '.github/workflows/deploy-production.yml', auditFromVersion: 14 },
  preview: { site: 'https://ark-next.kaltsit.dev', script: 'arkrecord-next', workflow: '.github/workflows/deploy-preview.yml', auditFromVersion: 55 },
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** 目录下的全部文件（相对路径，用 / 分隔，排序） */
export function walkFiles(dir) {
  const out = []
  const visit = (current) => {
    for (const name of readdirSync(current).toSorted()) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) visit(full)
      else out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  visit(dir)
  return out
}

/** 以 . 开头、但网站会提供的目录：/.well-known/（security.txt、llms.txt） */
const SERVED_DOT_DIRS = new Set(['.well-known'])

/** 路径里有没有以 . 开头的部分（.well-known 目录本身除外） */
function hasDotPart(p) {
  return p.split('/').some((part, i, parts) => part.startsWith('.') && !(i === 0 && parts.length > 1 && SERVED_DOT_DIRS.has(part)))
}

/**
 * 网站实际提供的文件：去掉以 . 开头的文件和目录（.assetsignore、本地开发用的 .dev.vars 等；/.well-known/ 除外）、
 * Cloudflare 的配置文件（_headers、_redirects）、清单本身，以及 .assetsignore 里列出的文件。
 */
export function servedFiles(clientDir) {
  let ignored = new Set()
  try {
    ignored = new Set(
      readFileSync(join(clientDir, '.assetsignore'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    )
  } catch {
    // 没有 .assetsignore
  }
  return walkFiles(clientDir).filter((p) => {
    if (hasDotPart(p)) return false
    if (p === '_headers' || p === '_redirects' || p === MANIFEST_PATH) return false
    return !ignored.has(p) && !ignored.has(posix.basename(p))
  })
}

/**
 * Cloudflare 为每个 Worker 版本保存的模块：Worker 构建目录里的代码（不含 wrangler.json、.map 和以 . 开头的文件，
 * 例如本地开发用的 .dev.vars），加上静态资源的配置文件 _headers、_redirects（存在时）。
 * 核对时要求和线上版本的模块一一对应，多一个少一个都算不一致。返回 [模块名, 文件路径]。
 */
export function workerModules(workerDir, clientDir) {
  const code = walkFiles(workerDir)
    .filter((p) => p !== 'wrangler.json' && !p.endsWith('.map') && !p.split('/').some((part) => part.startsWith('.')))
    .map((p) => [p, join(workerDir, p)])
  const config = ['_headers', '_redirects'].filter((name) => existsSync(join(clientDir, name))).map((name) => [name, join(clientDir, name)])
  return [...code, ...config]
}

/** _headers 里每个路径规则设置的响应头（只取设置的，不含 “! 名称” 去掉的） */
export function parseHeadersFile(text) {
  const rules = {}
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      current = line.trim()
      rules[current] ??= {}
      continue
    }
    const trimmed = line.trim()
    if (!current || trimmed.startsWith('!')) continue
    const colon = trimmed.indexOf(':')
    if (colon > 0) rules[current][trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim()
  }
  return rules
}

function entry(data) {
  return { sha256: sha256Hex(data), size: data.length }
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** 生成构建清单。键按字母排序，同样的构建产物得到同样的清单 */
export function buildManifest({ clientDir, workerDir, workerName, commit, environment, workflow, run }) {
  const files = sortedObject(servedFiles(clientDir).map((p) => [p, entry(readFileSync(join(clientDir, p)))]))
  const modules = sortedObject(workerModules(workerDir, clientDir).map(([name, path]) => [name, entry(readFileSync(path))]))
  let headers = {}
  try {
    headers = parseHeadersFile(readFileSync(join(clientDir, '_headers'), 'utf8'))
  } catch {
    // 没有 _headers
  }
  return {
    schema: MANIFEST_SCHEMA,
    repository: REPOSITORY,
    commit,
    environment,
    workflow,
    run: run ?? null,
    worker: { name: workerName, modules },
    headers: { '/*': headers['/*'] ?? {} },
    files,
  }
}

// ───────────────────────── 读取别人给的清单：先检查格式，再用 ─────────────────────────

const SAFE_PATH = /^[\w@+-][\w@+.-]*(\/[\w@+-][\w@+.-]*)*$/
const HEX64 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/

/** 文件路径只能是普通的相对路径：不能有 ..、//、反斜杠、查询参数，也不能以 . 开头（/.well-known/ 下的文件除外） */
export function isSafePath(p) {
  if (typeof p !== 'string' || p.length > 300 || p.split('/').includes('..')) return false
  const [first, ...rest] = p.split('/')
  if (SERVED_DOT_DIRS.has(first) && rest.length) return SAFE_PATH.test(rest.join('/'))
  return SAFE_PATH.test(p)
}

function isEntry(e) {
  return e && typeof e === 'object' && HEX64.test(e.sha256) && Number.isInteger(e.size) && e.size >= 0
}

function fail(why) {
  throw new Error(`构建清单格式不对：${why}`)
}

/** 检查清单格式；不合格时抛出错误。限制条目数，避免被一个巨大的清单拖垮 */
export function validateManifest(m) {
  if (!m || typeof m !== 'object') fail('不是对象')
  if (m.schema !== MANIFEST_SCHEMA) fail(`schema 应为 ${MANIFEST_SCHEMA}`)
  if (m.repository !== REPOSITORY) fail('repository 不对')
  if (!COMMIT.test(m.commit)) fail('commit 不是 40 位十六进制')
  if (!Object.hasOwn(ENVIRONMENTS, m.environment)) fail('environment 不对')
  if (m.workflow !== ENVIRONMENTS[m.environment].workflow) fail('workflow 和环境不对应')
  const files = Object.entries(m.files ?? {})
  if (!files.length || files.length > 5000) fail('files 数量不对')
  for (const [p, e] of files) if (!isSafePath(p) || !isEntry(e)) fail(`文件条目不合格：${String(p).slice(0, 80)}`)
  const modules = Object.entries(m.worker?.modules ?? {})
  if (!modules.length || modules.length > 50) fail('worker.modules 数量不对')
  for (const [p, e] of modules) if (!isSafePath(p) || !isEntry(e)) fail(`模块条目不合格：${String(p).slice(0, 80)}`)
  return m
}

// ───────────────────────── 网站上的地址 ─────────────────────────

/**
 * 文件在网站上的地址（Cloudflare Workers 静态资源的默认 HTML 处理）：
 * index.html → 所在目录（/、/legacy/），其他 .html 去掉扩展名，其余原样。
 */
export function servedPath(file) {
  if (file === 'index.html') return '/'
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`
  if (file.endsWith('.html')) return `/${file.slice(0, -'.html'.length)}`
  return `/${file}`
}

const CODE_EXT = /\.(html|js|mjs|cjs|css|wasm|json|svg|webmanifest|map|txt|xml)$/i

/** 默认只核对能执行或影响页面行为的文件（代码、样式、数据）；图片、字体、文字识别模型用 --all 时才核对 */
export function isCodeFile(p) {
  return CODE_EXT.test(p)
}

// ───────────────────────── 对比 ─────────────────────────

/** 两组模块是否完全一致：名字集合相同，每个的哈希相同 */
export function compareModules(actual, expected) {
  const problems = []
  for (const [name, e] of Object.entries(expected)) {
    if (!(name in actual)) problems.push(`缺少模块 ${name}`)
    else if (actual[name].sha256 !== e.sha256) problems.push(`模块 ${name} 的内容不同`)
  }
  for (const name of Object.keys(actual)) if (!(name in expected)) problems.push(`多出模块 ${name}`)
  return problems
}

// ───────────────────────── 运行 gh 验证构建证明 ─────────────────────────

/**
 * 给子进程的环境变量：只保留 gh 需要的，避免把 Cloudflare 令牌等传给别的程序。
 */
export function childEnv(env = process.env) {
  const keep = ['PATH', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']
  return Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]))
}

/** gh attestation verify 的参数：必须是本仓库、指定部署流程签发的 */
export function attestationArgs(file, workflow) {
  return ['attestation', 'verify', file, '--repo', REPOSITORY, '--signer-workflow', `${REPOSITORY}/${workflow}`, '--format', 'json']
}

/**
 * 从 gh 的 JSON 输出里取出每一份构建证明的来源（commit、分支、运行地址）。
 * 同样内容的文件可能被多次构建签发过（例如 _headers 很少改动），所以是一个列表。
 */
export function provenancesOf(ghJson) {
  if (!Array.isArray(ghJson)) return []
  return ghJson.map((item) => {
    const cert = item?.verificationResult?.signature?.certificate ?? {}
    return {
      commit: typeof cert.sourceRepositoryDigest === 'string' ? cert.sourceRepositoryDigest : null,
      ref: typeof cert.sourceRepositoryRef === 'string' ? cert.sourceRepositoryRef : null,
      run: typeof cert.runInvocationURI === 'string' ? cert.runInvocationURI : null,
    }
  })
}

/**
 * 一个 Worker 版本的各个模块是否来自同一次构建：找出每个模块都有证明的 commit。
 * 有多个时优先取 preferred（网站上构建清单的 commit）。没有共同的 commit 说明模块被拼凑过。
 */
export function commonProvenance(modules, preferred = null) {
  const lists = modules.map((m) => m.provenances ?? [])
  if (!lists.length || lists.some((l) => !l.length)) return null
  const common = [...new Set(lists[0].map((p) => p.commit).filter(Boolean))].filter((c) => lists.every((l) => l.some((p) => p.commit === c)))
  if (!common.length) return null
  const commit = preferred && common.includes(preferred) ? preferred : common[0]
  const p = lists[0].find((x) => x.commit === commit)
  return { commit, ref: p?.ref ?? null, run: p?.run ?? null }
}
