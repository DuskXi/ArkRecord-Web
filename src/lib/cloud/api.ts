/**
 * 云同步接口的调用（服务器端见 worker/cloud.ts）。请求体是二进制分帧：[头部 JSON][数据]，见 shared/cloud-protocol.ts。
 */
import { type CloudMode, CLOUD_PREFIX, type CloudOp, frame, splitEnvelopes, unframe } from '../../../shared/cloud-protocol'

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'CloudApiError'
  }
}

function messageOf(status: number, code: string, retryAfter?: number): string {
  switch (code) {
    case 'auth_failed':
      return '密码不对，或者云端已经被覆盖、密码已在别处修改。'
    case 'locked':
      return `尝试次数太多，请 ${Math.max(1, Math.ceil((retryAfter ?? 60) / 60))} 分钟后再试。`
    case 'rate_limited':
      return '请求太频繁，请过一分钟再试。'
    case 'hg_verify_failed':
      return '鹰角账号核实失败：token 可能已经失效，请重新登录鹰角通行证后再试。'
    case 'hg_required':
      return '这个操作需要用鹰角 token 证明账号是你的。'
    case 'stale_key':
      return '云端已经被覆盖、换了钥匙，请重新输入密码。'
    case 'quota_exceeded':
      return '云端数据超过了每个账号的上限。'
    case 'cloud_unavailable':
      return '云同步暂时不可用。'
    case 'hg_mode_unavailable':
      return '服务器还没有配置无密码模式，请使用密码模式。'
    case 'wrong_mode':
      return '这个账号用的是无密码模式，没有密码可改，也不能关闭鹰角 token 验证。'
    case 'network':
      return '网络连接失败，请检查网络后重试。'
    default:
      if (status === 429) return '云同步今天的额度已用完或请求太频繁，请稍后再试（每天北京时间 8 点重置）。'
      return `云同步失败（HTTP ${status}${code ? `，${code}` : ''}）。`
  }
}

async function call(op: CloudOp, header: object, payload?: Uint8Array): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${CLOUD_PREFIX}${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-arkrecord-client': '1' },
      body: frame(header, payload),
    })
  } catch {
    throw new CloudApiError(0, 'network', messageOf(0, 'network'))
  }
  if (!res.ok) {
    const code = res.headers.get('x-arkrecord-cloud') ?? ''
    const retry = Number(res.headers.get('retry-after') ?? '') || undefined
    throw new CloudApiError(res.status, code, messageOf(res.status, code, retry), retry)
  }
  return res
}

/** 证明：密码模式的 authKey；需要鹰角核实时附上游戏、UID 和 OAuth token */
export interface Proof {
  locator?: string
  authKey?: string
  hg?: { game: string; uid: string; token: string }
}

function proofHeader(proof: Proof): Record<string, unknown> {
  return {
    ...(proof.locator ? { locator: proof.locator } : {}),
    ...(proof.authKey ? { authKey: proof.authKey } : {}),
    ...(proof.hg ? { game: proof.hg.game, uid: proof.hg.uid, hgToken: proof.hg.token } : {}),
  }
}

export type CloudStatus = ({ exists: false } | { exists: true; mode: CloudMode; requireHg: boolean }) & {
  /** 无密码模式的 KEK_hg（只在请求了 kek 时返回） */
  hgKek?: string
}

/**
 * 查询这个账号在云端有没有开通、用的是哪种方式：必须带鹰角 token（服务器核实账号是你的才回答）。
 * kek：准备开通无密码模式时，顺便取回用来包裹新 DEK 的 KEK_hg。
 */
export async function apiStatus(hg: NonNullable<Proof['hg']>, options: { kek?: boolean } = {}): Promise<CloudStatus> {
  const res = await call('status', { ...proofHeader({ hg }), ...(options.kek ? { kek: true } : {}) })
  const body = (await res.json()) as CloudStatus
  if (typeof body?.exists !== 'boolean') throw new CloudApiError(200, 'bad_response', '云端返回的数据格式不对。')
  return body
}

export interface PullMeta {
  mode?: CloudMode
  /** 无密码模式：解开 wrappedDek 用的 KEK_hg */
  hgKek?: string
  kid: number
  requireHg: boolean
  wrappedDek: string
  headSeq: number
  count: number
  batches: { seq: number; kind: 'delta' | 'snapshot' }[]
}

export async function apiPull(proof: Proof, afterSeq: number): Promise<{ meta: PullMeta; envelopes: Uint8Array[] }> {
  const res = await call('pull', { ...proofHeader(proof), afterSeq })
  const framed = unframe(new Uint8Array(await res.arrayBuffer()), 1 << 20)
  const envelopes = framed ? splitEnvelopes(framed.payload) : null
  const meta = framed?.header as PullMeta | undefined
  if (!meta || !envelopes || envelopes.length !== meta.batches?.length) throw new CloudApiError(200, 'bad_response', '云端返回的数据格式不对。')
  return { meta, envelopes }
}

export async function apiPush(proof: Proof, envelope: Uint8Array, upToSeq?: number): Promise<{ seq: number; headSeq: number }> {
  const res = await call('push', { ...proofHeader(proof), ...(upToSeq === undefined ? {} : { upToSeq }) }, envelope)
  return (await res.json()) as { seq: number; headSeq: number }
}

export async function apiClaim(
  proof: Proof,
  body: { authKey: string; wrappedDek: string; kid: number; requireHg: boolean } | { mode: 'hg'; wrappedDek: string; kid: number },
  envelope: Uint8Array,
): Promise<{ seq: number }> {
  const res = await call('claim', { ...proofHeader(proof), ...body }, envelope)
  return (await res.json()) as { seq: number }
}

export async function apiRekey(proof: Proof, body: { newAuthKey: string; wrappedDek: string }): Promise<void> {
  await call('rekey', { ...proofHeader(proof), ...body })
}

export async function apiTwoFactor(proof: Proof, requireHg: boolean): Promise<void> {
  await call('twofactor', { ...proofHeader(proof), requireHg })
}

export async function apiDelete(proof: Proof): Promise<void> {
  await call('delete', proofHeader(proof))
}

export interface CloudInfo {
  protocol: number
  commit: string
  available: boolean
  /** 服务器是否配置了无密码模式 */
  hgAvailable?: boolean
}

export async function apiInfo(): Promise<CloudInfo | null> {
  try {
    const res = await fetch(`${CLOUD_PREFIX}info`)
    return res.ok ? ((await res.json()) as CloudInfo) : null
  } catch {
    return null
  }
}
