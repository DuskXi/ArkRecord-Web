/**
 * 发送鹰角 token 之前必须取得同意（consent.ts）：没有确认就换不到发给云同步接口的 OAuth token。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const grant = vi.fn(async (accountToken: string) => `oauth-for-${accountToken}`)
vi.mock('../hg/auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../hg/auth')>()), grantOAuthToken: grant }))

const { cloudOAuthToken, ConsentError, consentCovers, createConsent, revokeConsent } = await import('./consent')

const account = { id: 'arknights:1', game: 'arknights' as const, uid: '1', nickName: 'A', createdAt: 0, accountToken: 'saved' }

afterEach(() => {
  grant.mockClear()
  vi.useRealTimers()
})

describe('鹰角 token 的同意', () => {
  it('没有经过确认弹窗创建的对象不算同意', async () => {
    const forged = { accountIds: new Set([account.id]), expiresAt: Date.now() + 60_000 }
    await expect(cloudOAuthToken(forged, account.id, account)).rejects.toBeInstanceOf(ConsentError)
    expect(grant).not.toHaveBeenCalled()
  })

  it('只涵盖确认时列出的账号；作废、过期之后不能再用', async () => {
    const consent = createConsent([account.id])
    expect(consentCovers(consent, account.id)).toBe(true)
    await expect(cloudOAuthToken(consent, 'endfield:1', account)).rejects.toBeInstanceOf(ConsentError)
    expect(await cloudOAuthToken(consent, account.id, account)).toBe('oauth-for-saved')
    revokeConsent(consent)
    await expect(cloudOAuthToken(consent, account.id, account)).rejects.toBeInstanceOf(ConsentError)

    vi.useFakeTimers()
    const later = createConsent([account.id])
    vi.advanceTimersByTime(5 * 60_000 + 1)
    await expect(cloudOAuthToken(later, account.id, account)).rejects.toBeInstanceOf(ConsentError)
  })

  it('同一次同意里同一个登录只换取一次；粘贴的优先，其次是刚才同步用过的，最后是保存的', async () => {
    const consent = createConsent([account.id, 'endfield:1'])
    await cloudOAuthToken(consent, account.id, account)
    await cloudOAuthToken(consent, 'endfield:1', { ...account, id: 'endfield:1' })
    expect(grant).toHaveBeenCalledTimes(1)
    expect(await cloudOAuthToken(createConsent([account.id], { accountToken: 'recent' }), account.id, account)).toBe('oauth-for-recent')
    expect(await cloudOAuthToken(createConsent([account.id], { pasted: '{"code":0,"data":{"content":"pasted-token"}}', accountToken: 'recent' }), account.id, account)).toBe(
      'oauth-for-pasted-token',
    )
  })

  it('没有可用的登录时报错，不发请求', async () => {
    const consent = createConsent([account.id])
    await expect(cloudOAuthToken(consent, account.id, { ...account, accountToken: undefined })).rejects.toBeInstanceOf(ConsentError)
    expect(grant).not.toHaveBeenCalled()
  })
})

describe('CI 检查：云同步的代码只能通过 consent.ts 换取鹰角 OAuth token', () => {
  it('src/lib/cloud、src/components/cloud、src/stores/cloud.ts 里只有 consent.ts 调用 grantOAuthToken', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const files = [
      ...readdirSync('src/lib/cloud').map((f) => `src/lib/cloud/${f}`),
      ...readdirSync('src/components/cloud').map((f) => `src/components/cloud/${f}`),
      'src/stores/cloud.ts',
    ].filter((f) => /\.(ts|vue)$/.test(f) && !f.endsWith('.test.ts'))
    const offenders = files.filter((f) => f !== 'src/lib/cloud/consent.ts' && readFileSync(f, 'utf8').includes('grantOAuthToken'))
    expect(files.length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
    // createConsent 只在确认按钮里调用
    const creators = files.filter((f) => f !== 'src/lib/cloud/consent.ts' && /\bcreateConsent\(/.test(readFileSync(f, 'utf8')))
    expect(creators.toSorted()).toEqual(['src/components/cloud/CloudDialog.vue', 'src/components/cloud/TokenConsentDialog.vue'])
  })
})
