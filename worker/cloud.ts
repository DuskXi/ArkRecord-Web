/**
 * 云同步接口 /api/cloud/v1/*（docs/rewrite/cloud-sync.md 4、11）。
 *
 * Worker 永远不相信客户端发来的数据。每个请求依次经过：
 *   1. 路径白名单、只接受 POST、同源检查、限速、请求体大小；
 *   2. 解析二进制分帧，头部 JSON 不超过 1 KiB；
 *   3. 鹰角 token（如果有）交给 hg-verify.ts 核实，token 读出后立即从头部删除；
 *      需要鹰角证明的操作（查询状态、开通 / 覆盖、开关双重验证）没有核实通过就拒绝；
 *   4. locator：核实过鹰角 token 的请求由 Worker 用核实过的 UID 自己计算，忽略客户端传来的值；
 *      其他请求只把它当查找键，授权取决于 Durable Object 里对 authKey 的核对；
 *   5. 按操作的字段白名单逐个校验，重新组装成内部请求交给这个账号的 Durable Object（cloud-vault.ts），
 *      客户端的头部不会原样转过去。
 * 每个请求都自带证明，没有会话或票据。
 */
import {
  CLOUD_OPS,
  CLOUD_PREFIX,
  type CloudOp,
  computeLocator,
  frame,
  fromBase64Url,
  isLocator,
  MAX_ENVELOPE_BYTES,
  MAX_HEADER_BYTES,
  PROTOCOL_VERSION,
  unframe,
  WRAPPED_DEK_BYTES,
} from '../shared/cloud-protocol'
import { HG_VERIFIED_HEADER, LOCATOR_HEADER, RESULT_HEADER } from './cloud-vault'
import { type HgProof, verifyHgProof } from './hg-verify'
import { checkSameOrigin, rateLimitClient } from './security'

export interface CloudEnv {
  CLOUD?: DurableObjectNamespace
  RL_CLOUD?: RateLimit
  SYNC_PEPPER?: string
}

/** 线上部署的 commit（构建时由 GITHUB_SHA 写入，本地开发为 dev），任何人都可以和仓库对照 */
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev'

const MAX_BODY_BYTES = 2 + MAX_HEADER_BYTES + MAX_ENVELOPE_BYTES

function cloudError(status: number, code: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', [RESULT_HEADER]: code, ...extra },
  })
}

const isSeq = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const isKey = (v: unknown, length: number) => fromBase64Url(v, length) !== null

/** 每个操作允许的头部字段（核实鹰角 token 用到的 game、uid 另外处理）；返回整理过的内部头部，或 null */
function internalHeader(op: CloudOp, h: Record<string, unknown>, hasPayload: boolean, hgVerified: boolean): Record<string, unknown> | null {
  const authKey = h.authKey === undefined ? undefined : isKey(h.authKey, 32) ? h.authKey : null
  if (authKey === null) return null
  switch (op) {
    case 'status':
      // 只回答“这个账号开通了没有、是哪种方式”，不需要也不接受其他字段
      return h.authKey === undefined && !hasPayload ? {} : null
    case 'pull':
      return authKey && isSeq(h.afterSeq) && !hasPayload ? { authKey, afterSeq: h.afterSeq } : null
    case 'push':
      if (!authKey || !hasPayload) return null
      if (h.upToSeq !== undefined && !isSeq(h.upToSeq)) return null
      return { authKey, ...(h.upToSeq === undefined ? {} : { upToSeq: h.upToSeq }) }
    case 'claim':
      return authKey &&
        isKey(h.wrappedDek, WRAPPED_DEK_BYTES) &&
        Number.isInteger(h.kid) &&
        (h.kid as number) >= 1 &&
        (h.kid as number) <= 255 &&
        typeof h.requireHg === 'boolean' &&
        hasPayload
        ? { authKey, wrappedDek: h.wrappedDek, kid: h.kid, requireHg: h.requireHg }
        : null
    case 'rekey':
      return authKey && isKey(h.newAuthKey, 32) && isKey(h.wrappedDek, WRAPPED_DEK_BYTES) && !hasPayload
        ? { authKey, newAuthKey: h.newAuthKey, wrappedDek: h.wrappedDek }
        : null
    case 'twofactor':
      return authKey && typeof h.requireHg === 'boolean' && !hasPayload ? { authKey, requireHg: h.requireHg } : null
    case 'delete':
      // 删除需要 authKey；忘记密码时可以只用核实过的鹰角 token
      return (authKey || hgVerified) && !hasPayload ? (authKey ? { authKey } : {}) : null
  }
}

/** 需要核实过鹰角 token 才能执行的操作 */
// 查询状态也必须核实：否则任何人都能用别人的 UID 查到对方有没有开通云同步
const HG_REQUIRED: ReadonlySet<CloudOp> = new Set(['status', 'claim', 'twofactor'])

export interface CloudDeps {
  verify?: typeof verifyHgProof
}

export async function handleCloud(request: Request, env: CloudEnv, url: URL, deps: CloudDeps = {}): Promise<Response> {
  const op = url.pathname.slice(CLOUD_PREFIX.length)
  if (op === 'info') {
    if (request.method !== 'GET') return cloudError(405, 'method_not_allowed')
    return Response.json(
      { protocol: PROTOCOL_VERSION, commit: BUILD_COMMIT, available: Boolean(env.CLOUD && env.SYNC_PEPPER) },
      { headers: { 'cache-control': 'no-store' } },
    )
  }
  if (!(CLOUD_OPS as readonly string[]).includes(op)) return cloudError(404, 'not_found')
  if (request.method !== 'POST') return cloudError(405, 'method_not_allowed')
  const rejection = checkSameOrigin(request)
  if (rejection) return cloudError(403, rejection)
  if (!(request.headers.get('content-type') ?? '').startsWith('application/octet-stream')) return cloudError(415, 'binary_required')
  if (env.RL_CLOUD) {
    const { success } = await env.RL_CLOUD.limit({ key: `cloud:${rateLimitClient(request.headers.get('cf-connecting-ip'))}` })
    if (!success) return cloudError(429, 'rate_limited', { 'retry-after': '60' })
  }
  if (!env.CLOUD || !env.SYNC_PEPPER) return cloudError(503, 'cloud_unavailable')

  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) return cloudError(413, 'body_too_large')
  const body = new Uint8Array(await request.arrayBuffer())
  if (body.length > MAX_BODY_BYTES) return cloudError(413, 'body_too_large')
  const framed = unframe(body)
  if (!framed) return cloudError(400, 'bad_request')
  const { header, payload } = framed

  // 鹰角 token 只在 hg-verify.ts 里读取，读出后从 header 中删除
  const proof: HgProof = await (deps.verify ?? verifyHgProof)(header, { userAgent: request.headers.get('user-agent') })
  if (proof.status === 'invalid') return cloudError(403, 'hg_verify_failed')
  const hgVerified = proof.status === 'verified'
  if (HG_REQUIRED.has(op as CloudOp) && !hgVerified) return cloudError(403, 'hg_required')

  let locator: string
  if (proof.status === 'verified') {
    locator = await computeLocator(proof.game, proof.uid)
    if (header.locator !== undefined && header.locator !== locator) return cloudError(400, 'locator_mismatch')
  } else {
    if (!isLocator(header.locator)) return cloudError(400, 'bad_request')
    locator = header.locator
  }

  const internal = internalHeader(op as CloudOp, header, payload.length > 0, hgVerified)
  if (!internal) return cloudError(400, 'bad_request')

  const stub = env.CLOUD.get(env.CLOUD.idFromName(locator))
  const res = await stub.fetch(`https://vault/${op}`, {
    method: 'POST',
    headers: { [LOCATOR_HEADER]: locator, [HG_VERIFIED_HEADER]: hgVerified ? '1' : '0' },
    body: frame(internal, payload),
  })
  const headers: Record<string, string> = {
    'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
    'cache-control': 'no-store',
  }
  for (const name of [RESULT_HEADER, 'retry-after']) {
    const value = res.headers.get(name)
    if (value) headers[name] = value
  }
  return new Response(res.body, { status: res.status, headers })
}
