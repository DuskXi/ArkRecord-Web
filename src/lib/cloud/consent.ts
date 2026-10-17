/**
 * 云同步用到鹰角 token 之前，必须先取得用户的同意（docs/rewrite/cloud-sync.md 4.4）。
 *
 * 规则：不是用户主动点击、并在确认弹窗里点了“确认发送”，鹰角 token 绝不发给云同步接口。
 *   - Consent 只由确认弹窗的“确认”按钮创建（TokenConsentDialog.vue、CloudDialog.vue 的确认步骤），
 *     列出了这次同意涵盖哪些账号，几分钟后失效；
 *   - 云同步要用的鹰角 OAuth token 只能通过 cloudOAuthToken(consent, ...) 换取，没有有效的同意就拿不到；
 *   - 换到的 OAuth token 只缓存在这次同意里（内存），流程结束就丢弃。
 *
 * 发出去之后：Worker 只在 worker/hg-verify.ts 里用它查询鹰角的角色绑定列表，核实 UID 归属，然后丢弃。
 * 从鹰角同步记录（拉取寻访记录）走的是另一条路径：那是用户点击“同步”时把 token 交给转发，不经过这里。
 */
import { grantOAuthToken, parseAccountToken } from '../hg/auth'
import type { Account } from '../types'

/** 一次同意的有效期 */
const CONSENT_TTL_MS = 5 * 60_000

export interface Consent {
  /** 这次同意涵盖的账号（`${game}:${uid}`） */
  readonly accountIds: ReadonlySet<string>
  readonly expiresAt: number
  /** 用户在弹窗里粘贴的账号 token（没有保存登录的账号） */
  readonly pasted?: string
  /** 刚才从鹰角同步记录时用过的账号 token（只在内存里） */
  readonly accountToken?: string
}

const granted = new WeakSet<Consent>()
const cache = new WeakMap<Consent, Map<string, Promise<string>>>()

export class ConsentError extends Error {
  constructor(message = '发送鹰角 token 之前需要你的确认。') {
    super(message)
    this.name = 'ConsentError'
  }
}

/** 只在确认弹窗的“确认发送”按钮里调用 */
export function createConsent(accountIds: Iterable<string>, extra: { pasted?: string; accountToken?: string } = {}): Consent {
  const consent: Consent = Object.freeze({ accountIds: new Set(accountIds), expiresAt: Date.now() + CONSENT_TTL_MS, ...extra })
  granted.add(consent)
  return consent
}

/** 流程结束：作废这次同意，丢弃缓存的 OAuth token */
export function revokeConsent(consent: Consent | null | undefined): void {
  if (!consent) return
  granted.delete(consent)
  cache.delete(consent)
}

/** 这次同意是否还有效、是否涵盖这个账号 */
export function consentCovers(consent: Consent | null | undefined, accountId: string): boolean {
  return Boolean(consent && granted.has(consent) && Date.now() <= consent.expiresAt && consent.accountIds.has(accountId))
}

/** 账号 token 的来源：弹窗里粘贴的 → 刚才同步用过的 → 账号保存的登录 */
export function accountTokenFor(consent: Consent, account?: Account): string | null {
  return (consent.pasted ? parseAccountToken(consent.pasted) : null) ?? consent.accountToken ?? account?.accountToken ?? null
}

/**
 * 换取发给云同步接口的鹰角 OAuth token。没有有效的同意时抛出 ConsentError。
 * 同一次同意里，同一个账号 token 只换取一次。
 */
export async function cloudOAuthToken(consent: Consent, accountId: string, account?: Account): Promise<string> {
  if (!consentCovers(consent, accountId)) throw new ConsentError()
  const source = accountTokenFor(consent, account)
  if (!source) throw new ConsentError('没有可用的鹰角登录：请粘贴账号 token。')
  let byToken = cache.get(consent)
  if (!byToken) cache.set(consent, (byToken = new Map()))
  let pending = byToken.get(source)
  if (!pending) {
    pending = grantOAuthToken(source)
    byToken.set(source, pending)
    // 失败的不缓存，下次重新换取
    pending.catch(() => byToken.delete(source))
  }
  return pending
}
