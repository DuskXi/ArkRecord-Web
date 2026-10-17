/**
 * ════════════════════════════════════════════════════════════════════════════
 *  云同步中唯一读取鹰角 token 的代码。审计入口：仓库根目录的 SECURITY.md。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 用途：核实“发请求的人此刻控制着这个游戏账号”（docs/rewrite/cloud-sync.md 4、7.10、7.11、8.2）。
 * 只在这些场景用到：
 *   - 开通云同步，或忘记密码时覆盖云端；
 *   - 忘记密码时删除云端数据；
 *   - 开启了“鹰角 token 双重验证”的账号的每一个请求；
 *   - 开启、关闭双重验证；
 *   - 无密码模式（不推荐）的每一个请求。
 * 密码模式下，鹰角 token 只能证明所有权，不能解开数据：数据只有用户的密码能解开。
 * 无密码模式下，核实通过后服务器会给出解开数据用的钥匙（KEK_hg，见 cloud-vault.ts）：
 * 所以拿到你有效鹰角 token 的人能读取你的云端记录，本站运营者技术上也能解密（docs/rewrite/cloud-sync.md 8.1）。
 *
 * 做法：
 *   1. 从请求头部取出 token 后，立即把它从头部对象里删除，之后的代码接触不到它；
 *   2. 用它请求一个写死的地址（鹰角的角色绑定列表），客户端不能指定地址；
 *   3. 必须同时满足：HTTP 200、status 为 0、列表中有对应游戏、绑定列表里有这个 UID（字符串完全相等）；
 *      请求失败、超时、格式不对，一律当作核实失败（fail closed）；
 *   4. 返回核实过的游戏和 UID，之后用的是这里返回的值，而不是客户端声称的值。
 *
 * token 不写入存储，不写日志（Worker 的 observability 已关闭），不放进返回值，也不放进错误信息。
 * 仓库的 CI 检查（worker/token-fields.test.ts）保证 worker 目录里除了这个文件，任何地方都不出现 token 字段名。
 */
import { type CloudGame, isGame, isUid } from '../shared/cloud-protocol'

/** 请求头部里放鹰角 OAuth token 的字段名（只在这个文件里使用） */
const TOKEN_FIELD = 'hgToken'

/** 鹰角的角色绑定列表接口：与浏览器“添加账号”时查询角色用的是同一个接口 */
const BINDING_LIST_URL = 'https://binding-api-account-prod.hypergryph.com/account/binding/v1/binding_list'

const TIMEOUT_MS = 10_000
const TOKEN_PATTERN = /^[\w+/=.-]{8,1024}$/

export type HgProof =
  /** 请求里没有鹰角 token */
  | { status: 'absent' }
  /** 有 token，但核实没有通过 */
  | { status: 'invalid' }
  /** 核实通过：game、uid 来自核实结果 */
  | { status: 'verified'; game: CloudGame; uid: string }

interface BindingListResponse {
  status?: unknown
  data?: { list?: { appCode?: unknown; bindingList?: { uid?: unknown }[] }[] }
}

/**
 * 核实请求头部里的鹰角 token（header 中的 token 字段会被删除）。
 * userAgent 原样转给鹰角，与“添加账号”时浏览器经转发发出的请求一致。
 */
export async function verifyHgProof(
  header: Record<string, unknown>,
  options: { userAgent?: string | null; fetcher?: typeof fetch } = {},
): Promise<HgProof> {
  const token = header[TOKEN_FIELD]
  delete header[TOKEN_FIELD]
  if (token === undefined) return { status: 'absent' }

  const { game, uid } = header
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token) || !isGame(game) || !isUid(uid)) return { status: 'invalid' }

  let body: BindingListResponse
  try {
    const query = new URLSearchParams({ token, appCode: game })
    const response = await (options.fetcher ?? fetch)(`${BINDING_LIST_URL}?${query}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...(options.userAgent ? { 'user-agent': options.userAgent } : {}) },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status !== 200) return { status: 'invalid' }
    body = (await response.json()) as BindingListResponse
  } catch {
    return { status: 'invalid' }
  }

  if (body?.status !== 0 || !Array.isArray(body.data?.list)) return { status: 'invalid' }
  const entry = body.data.list.find((item) => item?.appCode === game)
  if (!entry || !Array.isArray(entry.bindingList)) return { status: 'invalid' }
  const owned = entry.bindingList.some((binding) => {
    const value = binding?.uid
    return (typeof value === 'string' || typeof value === 'number') && String(value) === uid
  })
  return owned ? { status: 'verified', game, uid } : { status: 'invalid' }
}
