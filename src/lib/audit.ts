/**
 * “线上代码审计”弹窗用的数据：正在运行的 commit（/api/cloud/v1/info）和构建清单（/build-manifest.json）。
 * 只用来展示和给出链接；真正的核对必须在网页之外完成（scripts/audit/，见 SECURITY.md 的“对照线上代码”）。
 */
import { REPO_URL } from '@/lib/cloud/links'

export const AUDIT_WORKFLOW_URL = `${REPO_URL}/actions/workflows/audit-deployment.yml`
export const ATTESTATIONS_URL = `${REPO_URL}/attestations`
export const MANIFEST_PATH = '/build-manifest.json'

export interface ManifestSummary {
  commit: string
  environment: 'production' | 'preview'
  /** 构建并部署这个版本的那次 GitHub Actions 运行 */
  runUrl: string | null
  files: number
  modules: string[]
  /** 清单本身的 SHA-256（构建证明就是为它签发的） */
  digest: string
}

export interface LiveDeployment {
  commit: string | null
  manifest: ManifestSummary | null
  /** 没有构建清单（例如本地开发）时的说明 */
  note: string | null
}

const COMMIT = /^[0-9a-f]{40}$/
const RUN_URL = new RegExp(`^${REPO_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/actions/runs/\\d+(/attempts/\\d+)?$`)

/** 构建清单的摘要；格式不对时返回 null。链接只接受本仓库 Actions 运行的地址 */
export function summarizeManifest(json: unknown, digest: string): ManifestSummary | null {
  if (!json || typeof json !== 'object') return null
  const m = json as Record<string, unknown>
  if (m.schema !== 'arkrecord-build-manifest/1' || typeof m.commit !== 'string' || !COMMIT.test(m.commit)) return null
  if (m.environment !== 'production' && m.environment !== 'preview') return null
  const files = m.files && typeof m.files === 'object' ? Object.keys(m.files).length : 0
  const worker = m.worker as { modules?: Record<string, unknown> } | undefined
  const modules = worker?.modules && typeof worker.modules === 'object' ? Object.keys(worker.modules).filter((n) => /^[\w.-]{1,100}$/.test(n)) : []
  if (!files || !modules.length) return null
  const run = (m.run as { url?: unknown } | null)?.url
  return {
    commit: m.commit,
    environment: m.environment,
    runUrl: typeof run === 'string' && RUN_URL.test(run) ? run : null,
    files,
    modules,
    digest,
  }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 读取线上的部署信息（同源请求，不带任何凭据） */
export async function loadLiveDeployment(fetcher: typeof fetch = fetch): Promise<LiveDeployment> {
  const [info, manifest] = await Promise.all([
    fetcher('/api/cloud/v1/info', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetcher(MANIFEST_PATH, { cache: 'no-store' }).catch(() => null),
  ])
  const commit = typeof info?.commit === 'string' && COMMIT.test(info.commit) ? (info.commit as string) : null
  // 单页应用对不存在的路径会返回首页（HTML），所以要看内容类型
  if (!manifest?.ok || !/json/i.test(manifest.headers.get('content-type') ?? '')) {
    return { commit, manifest: null, note: '这个环境没有构建清单（例如本地开发）。' }
  }
  const bytes = await manifest.arrayBuffer()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // 格式不对
  }
  const summary = summarizeManifest(parsed, await sha256Hex(bytes))
  return { commit, manifest: summary, note: summary ? null : '构建清单的格式不对。' }
}

export function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 7) : '—'
}
