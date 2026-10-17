import { describe, expect, it } from 'vitest'
import { checkPassword, GENERATOR_ALPHABET, generatePassword, remainingStrength } from './password'

describe('云同步密码规则', () => {
  it('强制：至少 12 位，同时有大写、小写、数字', () => {
    expect(checkPassword('Kx7mP2qL9v').issues).toContain('too_short')
    expect(checkPassword('kx7mp2ql9vrt').issues).toContain('missing_upper')
    expect(checkPassword('KX7MP2QL9VRT').issues).toContain('missing_lower')
    expect(checkPassword('KxumPzqLsvRt').issues).toContain('missing_digit')
    expect(checkPassword(' Kx7mP2qL9vRt').issues).toContain('edge_space')
    expect(checkPassword('Kx7mP2qL9vRt')).toEqual({ ok: true, issues: [], suggested: false })
  })

  it.each([
    'Password1234',
    'Password2024',
    'P@ssw0rd2024',
    'Abcd12345678',
    'Qwerty123456',
    'Aaaa11111111',
    'Amiya1234567',
    '1qaz2wsx3EDC',
    'Doctor2024!!',
    'Kaltsit19990101',
    'Abab12121212',
    'Iloveyou1234',
    'Arknights2025',
    'Zxcvbnm98765',
  ])('屏蔽常见的简单密码：%s', (password) => {
    const result = checkPassword(password)
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i === 'common' || i === 'pattern')).toBe(true)
  })

  it.each(['Kx7mP2qL9vRt', 'MyDogIsCute7', 'Correct-Horse-Battery-9', '春眠不觉晓Ab3处处闻啼鸟', 'Tz4kWq8nRb2m'])('正常的密码可以通过：%s', (password) => {
    expect(checkPassword(password).ok).toBe(true)
  })

  it('不能包含 UID 或昵称', () => {
    expect(checkPassword('Ab12345678Xy', { uid: '12345678' }).issues).toContain('contains_uid')
    expect(checkPassword('KxBoshi7mP2q', { nickName: 'boshi' }).issues).toContain('contains_name')
  })

  it('去掉规律之后剩余的字符数', () => {
    expect(remainingStrength('Password2024')).toBe(0)
    expect(remainingStrength('Kx7mP2qL9vRt')).toBe(12)
  })

  it('“生成”：16 位、只用约定的字符、同时有三类字符、每次不同、都能通过检查', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const p = generatePassword()
      expect(p).toHaveLength(16)
      expect([...p].every((c) => GENERATOR_ALPHABET.includes(c))).toBe(true)
      expect(/[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p)).toBe(true)
      expect(checkPassword(p).ok).toBe(true)
      seen.add(p)
    }
    expect(seen.size).toBe(200)
    expect(GENERATOR_ALPHABET).toHaveLength(57)
    expect(GENERATOR_ALPHABET).not.toMatch(/[0O1lI]/)
  })
})
