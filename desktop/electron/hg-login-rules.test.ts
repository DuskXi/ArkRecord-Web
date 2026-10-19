import { describe, expect, it } from 'vitest'
import { OFFICIAL_LOGIN, fakeLoginTarget, tokenFromInfo } from './hg-login-rules.js'

const url = (value: string) => new URL(value)

describe('OFFICIAL_LOGIN', () => {
  it('顶层页面只允许 https 的 hypergryph.com 及其子域名', () => {
    expect(OFFICIAL_LOGIN.allowTop(url(OFFICIAL_LOGIN.loginUrl))).toBe(true)
    expect(OFFICIAL_LOGIN.allowTop(url('https://user.hypergryph.com/login?redirect=/'))).toBe(true)
    expect(OFFICIAL_LOGIN.allowTop(url('https://hypergryph.com/'))).toBe(true)
    expect(OFFICIAL_LOGIN.allowTop(url('http://user.hypergryph.com/'))).toBe(false)
    expect(OFFICIAL_LOGIN.allowTop(url('https://evilhypergryph.com/'))).toBe(false)
    expect(OFFICIAL_LOGIN.allowTop(url('https://user.hypergryph.com.evil.example/'))).toBe(false)
    expect(OFFICIAL_LOGIN.allowTop(url('https://gcaptcha4.geetest.com/'))).toBe(false)
  })

  it('子框架另外放行极验', () => {
    expect(OFFICIAL_LOGIN.allowFrame(url('https://gcaptcha4.geetest.com/load'))).toBe(true)
    expect(OFFICIAL_LOGIN.allowFrame(url('https://user.hypergryph.com/'))).toBe(true)
    expect(OFFICIAL_LOGIN.allowFrame(url('http://static.geetest.com/'))).toBe(false)
    expect(OFFICIAL_LOGIN.allowFrame(url('https://notgeetest.com/'))).toBe(false)
  })

  it('token 从 web-api.hypergryph.com 取', () => {
    expect(OFFICIAL_LOGIN.infoUrl).toBe('https://web-api.hypergryph.com/account/info/hg')
  })
})

describe('fakeLoginTarget', () => {
  it('只允许同一个本机地址', () => {
    const fake = fakeLoginTarget('http://127.0.0.1:4567')
    expect(fake.loginUrl).toBe('http://127.0.0.1:4567/login')
    expect(fake.infoUrl).toBe('http://127.0.0.1:4567/account/info/hg')
    expect(fake.allowTop(url('http://127.0.0.1:4567/home'))).toBe(true)
    expect(fake.allowTop(url('http://127.0.0.1:9/blocked'))).toBe(false)
    expect(fake.allowTop(url('https://user.hypergryph.com/'))).toBe(false)
  })

  it('不接受本机以外的地址和 https', () => {
    expect(() => fakeLoginTarget('http://example.com')).toThrow()
    expect(() => fakeLoginTarget('https://127.0.0.1:4567')).toThrow()
  })
})

describe('tokenFromInfo', () => {
  it('code 为 0 且 data.content 是非空字符串时取出 token', () => {
    expect(tokenFromInfo({ code: 0, data: { content: 'abc' }, msg: '' })).toBe('abc')
  })

  it('其他情况都不算登录成功', () => {
    for (const json of [
      null,
      'text',
      { code: 3, data: null, msg: '未登录' },
      { code: 0, data: { content: '' } },
      { code: 0, data: { content: 1 } },
      { code: 0, data: null },
      { code: '0', data: { content: 'abc' } },
      { code: 0, data: { content: 'x'.repeat(4097) } },
    ]) {
      expect(tokenFromInfo(json)).toBeUndefined()
    }
  })
})
