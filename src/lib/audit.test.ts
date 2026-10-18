import { describe, expect, it } from 'vitest'
import { loadLiveDeployment, summarizeManifest } from './audit'

const COMMIT = '9517e9d2fb7fd0527768ad8d13bb25938f48cba6'
const manifest = (extra: Record<string, unknown> = {}) => ({
  schema: 'arkrecord-build-manifest/1',
  repository: 'DuskXi/ArkRecord-Web',
  commit: COMMIT,
  environment: 'preview',
  workflow: '.github/workflows/deploy-preview.yml',
  run: { id: '1', attempt: '1', url: 'https://github.com/DuskXi/ArkRecord-Web/actions/runs/39078185316' },
  worker: { name: 'arkrecord-next', modules: { _headers: {}, 'index.js': {} } },
  headers: {},
  files: { 'index.html': {}, 'assets/a.js': {} },
  ...extra,
})

describe('构建清单摘要', () => {
  it('取出 commit、环境、运行地址、文件数和模块', () => {
    expect(summarizeManifest(manifest(), 'abc')).toEqual({
      commit: COMMIT,
      environment: 'preview',
      runUrl: 'https://github.com/DuskXi/ArkRecord-Web/actions/runs/39078185316',
      files: 2,
      modules: ['_headers', 'index.js'],
      digest: 'abc',
    })
  })

  it('运行地址只接受本仓库的 Actions 运行', () => {
    for (const url of ['https://evil.example/actions/runs/1', 'https://github.com/someone/else/actions/runs/1', 'javascript:alert(1)', 'https://github.com/DuskXi/ArkRecord-Web/actions/runs/1?x=1']) {
      expect(summarizeManifest(manifest({ run: { url } }), 'abc')!.runUrl, url).toBeNull()
    }
  })

  it('格式不对时返回 null', () => {
    expect(summarizeManifest(null, 'x')).toBeNull()
    expect(summarizeManifest(manifest({ commit: 'abc' }), 'x')).toBeNull()
    expect(summarizeManifest(manifest({ schema: 'other' }), 'x')).toBeNull()
    expect(summarizeManifest(manifest({ environment: 'staging' }), 'x')).toBeNull()
    expect(summarizeManifest(manifest({ files: {} }), 'x')).toBeNull()
  })
})

const respond = (body: string, type: string) => new Response(body, { status: 200, headers: { 'content-type': type } })

describe('读取线上部署信息', () => {
  it('读到 commit 和清单，并算出清单的 SHA-256', async () => {
    const body = JSON.stringify(manifest())
    const fetcher = (async (url: string) => (url.includes('/info') ? respond(JSON.stringify({ commit: COMMIT }), 'application/json') : respond(body, 'application/json'))) as typeof fetch
    const live = await loadLiveDeployment(fetcher)
    expect(live.commit).toBe(COMMIT)
    expect(live.manifest?.files).toBe(2)
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(live.manifest?.digest).toBe(expected)
  })

  it('没有清单（单页应用返回了首页）时给出说明', async () => {
    const fetcher = (async (url: string) => (url.includes('/info') ? respond('{}', 'application/json') : respond('<!doctype html>', 'text/html'))) as typeof fetch
    expect(await loadLiveDeployment(fetcher)).toMatchObject({ commit: null, manifest: null, note: expect.stringContaining('没有构建清单') })
  })
})
