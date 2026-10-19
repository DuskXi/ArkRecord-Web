import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attestationArgs,
  buildManifest,
  childEnv,
  compareModules,
  ENVIRONMENTS,
  isCodeFile,
  isSafePath,
  parseHeadersFile,
  commonProvenance,
  provenancesOf,
  servedPath,
  sha256Hex,
  validateManifest,
} from './lib.mjs'

const COMMIT = 'c6561a5b663cc036778a8089a5c21f4b9b4520d9'
const OTHER = '9517e9d2fb7fd0527768ad8d13bb25938f48cba6'
const cert = (commit: string, run: number) => ({
  verificationResult: { signature: { certificate: { sourceRepositoryDigest: commit, sourceRepositoryRef: 'refs/heads/master', runInvocationURI: `https://github.com/DuskXi/ArkRecord-Web/actions/runs/${run}/attempts/1` } } },
})
const prov = (commit: string, subjects: string[] = []) => ({ commit, ref: 'refs/heads/master', run: `run-${commit.slice(0, 3)}`, subjects })
let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'audit-test-'))
  dirs.push(root)
  const client = join(root, 'client')
  const worker = join(root, 'arkrecord_next')
  const files: Record<string, string> = {
    'client/index.html': '<!doctype html>',
    'client/assets/app-abc.js': 'console.log(1)',
    'client/legacy/index.html': 'legacy',
    'client/gamedata/ak-meta.json': '{}',
    'client/_headers': '/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src \'self\'\n/legacy/*\n  ! Content-Security-Policy\n',
    'client/.assetsignore': 'wrangler.json\n.dev.vars\n',
    'client/.well-known/security.txt': 'Contact: x',
    'client/.hidden/secret.txt': 'x',
    'client/wrangler.json': '{}',
    'client/build-manifest.json': '{"old":true}',
    'arkrecord_next/index.js': 'export default {}',
    'arkrecord_next/index.js.map': '{"sources":["/home/runner/x"]}',
    'arkrecord_next/wrangler.json': '{"name":"arkrecord-next"}',
    'arkrecord_next/.dev.vars': 'SYNC_PEPPER=secret',
    'arkrecord_next/.vite/manifest.json': '{}',
  }
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true })
    writeFileSync(join(root, p), content)
  }
  return { root, client, worker }
}

const make = (f: ReturnType<typeof fixture>) =>
  buildManifest({ clientDir: f.client, workerDir: f.worker, workerName: 'arkrecord-next', commit: COMMIT, environment: 'preview', workflow: ENVIRONMENTS.preview.workflow, run: null })

describe('构建清单', () => {
  it('只列出网站实际提供的文件；Worker 模块是代码和 _headers，不含 .map、配置和本地开发的密钥文件', () => {
    const m = make(fixture())
    expect(Object.keys(m.files)).toEqual(['.well-known/security.txt', 'assets/app-abc.js', 'gamedata/ak-meta.json', 'index.html', 'legacy/index.html'])
    expect(Object.keys(m.worker.modules)).toEqual(['_headers', 'index.js'])
    expect(m.worker.modules['index.js'].sha256).toBe(sha256Hex('export default {}'))
    expect(JSON.stringify(m)).not.toContain('secret')
    expect(m.headers['/*']).toEqual({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'" })
    expect(validateManifest(m)).toBe(m)
  })

  it('同样的构建产物得到同样的清单', () => {
    const f = fixture()
    expect(JSON.stringify(make(f))).toBe(JSON.stringify(make(f)))
  })

  it('_headers：设置的响应头，忽略注释和 ! 去掉的', () => {
    expect(parseHeadersFile('# 注释\n/*\n  A: 1\n  B: x: y\n/x/*\n  ! A\n  C: 2\n')).toEqual({ '/*': { A: '1', B: 'x: y' }, '/x/*': { C: '2' } })
  })
})

const good = () => make(fixture())
const e = (s: string) => ({ sha256: sha256Hex(s), size: s.length })
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('读取别人给的清单：格式检查', () => {

  it('文件路径只能是普通的相对路径', () => {
    for (const ok of ['index.html', 'assets/a-1.js', 'gamedata/avatars/char_002_amiya.webp', 'ocr/6.0.1-6.1.2/core/x.wasm.js', '.well-known/security.txt']) expect(isSafePath(ok)).toBe(true)
    for (const bad of ['../etc/passwd', 'a/../b', '/abs', 'a//b', '.dev.vars', 'a/.git/config', 'a?b=1', 'a#b', 'http://evil', '//evil.example/x', 'a\\b', '', '.well-known', '.well-known/.x', '.well-known/../x', 'a/.well-known/x']) {
      expect(isSafePath(bad), bad).toBe(false)
    }
  })

  it('不合格的清单直接拒绝', () => {
    const cases: [string, (m: ReturnType<typeof good>) => void][] = [
      ['commit', (m) => (m.commit = 'abc')],
      ['environment', (m) => (m.environment = 'staging')],
      ['workflow', (m) => (m.workflow = '.github/workflows/evil.yml')],
      ['repository', (m) => (m.repository = 'someone/else')],
      ['路径', (m) => (m.files['../x'] = { sha256: 'a'.repeat(64), size: 1 })],
      ['哈希', (m) => (m.files['index.html'] = { sha256: 'xyz', size: 1 })],
      ['模块', (m) => (m.worker.modules = {})],
    ]
    for (const [name, mutate] of cases) {
      const m = good()
      mutate(m)
      expect(() => validateManifest(m), name).toThrow()
    }
  })
})

describe('网站上的地址', () => {
  it('index.html 是所在目录，其他 .html 去掉扩展名', () => {
    expect(servedPath('index.html')).toBe('/')
    expect(servedPath('legacy/index.html')).toBe('/legacy/')
    expect(servedPath('about.html')).toBe('/about')
    expect(servedPath('assets/a.js')).toBe('/assets/a.js')
  })

  it('默认核对能执行或影响页面的文件', () => {
    for (const p of ['index.html', 'assets/a.js', 'assets/a.css', 'ocr/core/x.wasm.js', 'gamedata/ak-meta.json', 'icon.svg']) expect(isCodeFile(p), p).toBe(true)
    for (const p of ['gamedata/avatars/a.webp', 'fonts/a.woff2', 'ocr/lang/chi_sim.traineddata.gz', 'record.ico']) expect(isCodeFile(p), p).toBe(false)
  })
})

describe('Worker 模块对比', () => {
  it('名字集合和内容都要一致', () => {
    expect(compareModules({ 'index.js': e('a'), _headers: e('h') }, { 'index.js': e('a'), _headers: e('h') })).toEqual([])
    expect(compareModules({ 'index.js': e('b'), _headers: e('h') }, { 'index.js': e('a'), _headers: e('h') })).toEqual(['模块 index.js 的内容不同'])
    expect(compareModules({ 'index.js': e('a'), 'evil.js': e('x'), _headers: e('h') }, { 'index.js': e('a'), _headers: e('h') })).toEqual(['多出模块 evil.js'])
    expect(compareModules({ 'index.js': e('a') }, { 'index.js': e('a'), _headers: e('h') })).toEqual(['缺少模块 _headers'])
  })
})

describe('构建证明', () => {
  it('必须是本仓库、指定部署流程签发的', () => {
    expect(attestationArgs('/tmp/x', ENVIRONMENTS.production.workflow)).toEqual([
      'attestation',
      'verify',
      '/tmp/x',
      '--repo',
      'DuskXi/ArkRecord-Web',
      '--signer-workflow',
      'DuskXi/ArkRecord-Web/.github/workflows/deploy-production.yml',
      '--format',
      'json',
    ])
  })

  it('从 gh 的输出里取出每份证明的 commit、分支和运行地址', () => {
    expect(provenancesOf([cert(COMMIT, 1), cert(OTHER, 2)])).toEqual([
      { commit: COMMIT, ref: 'refs/heads/master', run: 'https://github.com/DuskXi/ArkRecord-Web/actions/runs/1/attempts/1', subjects: [] },
      { commit: OTHER, ref: 'refs/heads/master', run: 'https://github.com/DuskXi/ArkRecord-Web/actions/runs/2/attempts/1', subjects: [] },
    ])
    expect(provenancesOf(null)).toEqual([])
    // 证明签名的文件列表（in-toto statement 的 subject），只留格式正确的 SHA-256
    const signed = { ...cert(COMMIT, 1), verificationResult: { ...cert(COMMIT, 1).verificationResult, statement: { subject: [{ name: 'a', digest: { sha256: 'a'.repeat(64) } }, { name: 'b', digest: { sha256: 'bad' } }, null] } } }
    expect(provenancesOf([signed])[0]!.subjects).toEqual(['a'.repeat(64)])
  })

  it('同一份构建证明列出了全部模块：即使 _headers 的证明列表里没有这次构建（gh 只取最近的若干份）也算同一次构建', () => {
    const INDEX = '1'.repeat(64)
    const HEADERS = '2'.repeat(64)
    const both = [INDEX, HEADERS]
    // index.js 只有 COMMIT 那次构建的证明，证明里列出了两个模块；_headers 的证明列表里只有更新的 OTHER
    const index = { sha256: INDEX, provenances: [prov(COMMIT, both)] }
    const headers = { sha256: HEADERS, provenances: [prov(OTHER, both)] }
    expect(commonProvenance([index, headers])).toEqual({ commit: COMMIT, ref: 'refs/heads/master', run: `run-${COMMIT.slice(0, 3)}` })
    // 没有一份证明同时列出两个模块，也没有共同的 commit：拼凑的
    expect(commonProvenance([{ sha256: INDEX, provenances: [prov(COMMIT, [INDEX])] }, { sha256: HEADERS, provenances: [prov(OTHER, [HEADERS])] }])).toBeNull()
    // 别的构建的证明里也列出了同样内容的 index.js：那次构建同样产生了全部模块，也算
    expect(commonProvenance([{ sha256: INDEX, provenances: [prov(COMMIT, [INDEX])] }, headers])?.commit).toBe(OTHER)
    // 证明里的文件列表对不上时，退回到“每个模块都有同一个 commit 的证明”
    expect(commonProvenance([{ sha256: INDEX, provenances: [prov(COMMIT, [INDEX])] }, { sha256: HEADERS, provenances: [prov(COMMIT, [HEADERS])] }])?.commit).toBe(COMMIT)
  })

  it('一个版本的模块必须有共同的构建来源：很少改动的 _headers 被多次签发也不算拼凑', () => {
    // index.js 只来自 COMMIT；_headers 内容没变，被 COMMIT 和 OTHER 两次构建都签发过
    expect(commonProvenance([{ provenances: [prov(COMMIT)] }, { provenances: [prov(OTHER), prov(COMMIT)] }])).toEqual({ commit: COMMIT, ref: 'refs/heads/master', run: `run-${COMMIT.slice(0, 3)}` })
    // 两个模块都被两次构建签发过（代码没变）：优先取网站上构建清单的 commit
    expect(commonProvenance([{ provenances: [prov(COMMIT), prov(OTHER)] }, { provenances: [prov(OTHER), prov(COMMIT)] }], OTHER)?.commit).toBe(OTHER)
    // 没有共同的 commit：模块被拼凑过
    expect(commonProvenance([{ provenances: [prov(COMMIT)] }, { provenances: [prov(OTHER)] }])).toBeNull()
    // 有模块没有证明
    expect(commonProvenance([{ provenances: [prov(COMMIT)] }, { provenances: [] }])).toBeNull()
  })

  it('调用 gh 时不传 Cloudflare 令牌等无关的环境变量', () => {
    const env = childEnv({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'g', CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acc', OTHER: 'x' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'g' })
  })
})

describe('部署流程和核对脚本', () => {

  it('两个部署流程都生成构建清单、签发构建证明，并在部署后核对', () => {
    for (const [env, config] of Object.entries(ENVIRONMENTS)) {
      const wf = read(`../../${config.workflow}`)
      expect(wf).toContain(`node scripts/audit/manifest.mjs --env ${env}`)
      expect(wf).toContain('actions/attest-build-provenance')
      expect(wf).toContain('subject-checksums: dist/attestation-subjects.sha256')
      expect(wf).toContain('--tag ${{ github.sha }}')
      expect(wf).toContain('uses: ./.github/workflows/audit-deployment.yml')
      expect(wf).toContain(`environment: ${env}`)
      // 签发构建证明在部署之前
      expect(wf.indexOf('attest-build-provenance')).toBeLessThan(wf.indexOf('wrangler-action'))
      // 有签发权限的任务不检出代码、不安装依赖（被投毒的依赖拿不到签发权限）；其余任务没有签发权限
      const attestJob = wf.slice(wf.indexOf('\n  attest:\n'), wf.indexOf('\n  deploy:\n'))
      expect(attestJob).toContain('id-token: write')
      expect(attestJob).not.toMatch(/npm|npx|actions\/checkout|run:/)
      expect(wf.match(/id-token: write/g)).toHaveLength(2)
      expect(wf.slice(wf.indexOf('\n  audit:\n'))).toContain('uses: ./.github/workflows/audit-deployment.yml')
    }
  })

  it('Worker 核对脚本只发 GET 请求，不输出账号信息', () => {
    const src = read('./verify-worker.mjs')
    expect(src.match(/fetch\(/g)).toHaveLength(1)
    expect(src).toContain("method: 'GET'")
    expect(src).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/)
    expect(src).not.toMatch(/author_email|author_id|bindings/)
    // 令牌只出现在请求头里
    expect(src.match(/\btoken\b/g)?.length).toBeLessThanOrEqual(3)
  })

  it('核对流程不安装依赖，Cloudflare 令牌只交给 Worker 核对那一步', () => {
    const wf = read('../../.github/workflows/audit-deployment.yml')
    expect(wf).not.toMatch(/npm (ci|install)/)
    expect(wf.match(/secrets\.CLOUDFLARE_API_TOKEN/g)).toHaveLength(1)
    expect(wf).toContain('persist-credentials: false')
  })
})
