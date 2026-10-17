/**
 * 云同步密码的规则（docs/rewrite/cloud-sync.md 7.6）。全部在浏览器里检查，服务器看不到密码。
 *
 * 强制：至少 12 位，同时有大写字母、小写字母和数字，不能是常见的简单密码，不能包含 UID 或昵称。
 * 建议：16 位以上，或者用“生成”（16 位随机，约 93 位）。
 *
 * “简单密码”的判断：把密码里的常见单词、连续字符（abcd、1234、4321）、重复（aaaa、abab）、
 * 键盘顺序（qwerty、1qaz2wsx）、年份和日期标出来，剩下的字符不到 6 个就算太简单。
 * 比较时不区分大小写，并还原常见的字符替换（@→a、0→o、1→l/i、3→e、$→s 等）。
 */

export const MIN_LENGTH = 12
export const SUGGESTED_LENGTH = 16
const MAX_LENGTH = 256
/** 去掉常见单词、规律之后，至少还要剩这么多个字符 */
const MIN_REMAINING = 6

export type PasswordIssue =
  | 'too_short'
  | 'too_long'
  | 'missing_upper'
  | 'missing_lower'
  | 'missing_digit'
  | 'edge_space'
  | 'common'
  | 'pattern'
  | 'contains_uid'
  | 'contains_name'

export const ISSUE_TEXT: Record<PasswordIssue, string> = {
  too_short: `至少 ${MIN_LENGTH} 位`,
  too_long: `不能超过 ${MAX_LENGTH} 位`,
  missing_upper: '需要大写字母',
  missing_lower: '需要小写字母',
  missing_digit: '需要数字',
  edge_space: '开头和结尾不能是空格',
  common: '这是常见密码',
  pattern: '太简单：主要由常见单词、连续或重复的字符、键盘顺序、年份组成',
  contains_uid: '不能包含 UID',
  contains_name: '不能包含昵称',
}

/** 泄露密码库里满足长度和字符种类要求的常见密码（小写、已还原字符替换后比较） */
const COMMON = new Set([
  'password1234',
  'password12345',
  'password123456',
  'password1234567',
  'password12345678',
  'passwordpassword',
  'qwerty123456',
  'qwertyuiop12',
  'qwertyuiop123',
  'abcd12345678',
  'abc123456789',
  'aa1234567890',
  'aa123456789a',
  'iloveyou1234',
  'iloveyou12345',
  'welcome12345',
  'welcome123456',
  'admin1234567',
  'admin12345678',
  'administrator1',
  'administrator123',
  'iqaz2wsx3edc',
  'lqaz2wsx3edc',
  'qazwsx123456',
  'zaq12wsxcde3',
  'letmein12345',
  'football1234',
  'baseball1234',
  'sunshine1234',
  'princess1234',
  'superman1234',
  'michael12345',
  'charlie12345',
  'monkey123456',
  'dragon123456',
  'master123456',
  'shadow123456',
  'trustnoi1234',
  'starwars1234',
  'computer1234',
  'whatever1234',
  'changeme1234',
  'woaini123456',
  'woaini1314520',
  'a123456789012',
  'q1w2e3r4t5y6',
  'iq2w3e4r5t6y',
])

/** 常见单词（4 个字母以上）：英文常见词、拼音，以及和游戏、本站有关的词 */
const WORDS = [
  'password',
  'passwd',
  'pass',
  'word',
  'qwerty',
  'admin',
  'administrator',
  'welcome',
  'iloveyou',
  'love',
  'letmein',
  'monkey',
  'dragon',
  'master',
  'shadow',
  'superman',
  'batman',
  'football',
  'baseball',
  'soccer',
  'sunshine',
  'princess',
  'michael',
  'charlie',
  'jordan',
  'hello',
  'secret',
  'login',
  'user',
  'test',
  'guest',
  'root',
  'default',
  'changeme',
  'whatever',
  'trustno',
  'starwars',
  'computer',
  'internet',
  'freedom',
  'summer',
  'winter',
  'spring',
  'autumn',
  'china',
  'woaini',
  'aini',
  'nihao',
  'baidu',
  'taobao',
  'arknights',
  'arknight',
  'mingrifangzhou',
  'mrfz',
  'fangzhou',
  'endfield',
  'zhongmodi',
  'kaltsit',
  'doctor',
  'amiya',
  'rhodes',
  'island',
  'hypergryph',
  'yingjiao',
  'skland',
  'senkongdao',
  'arkrecord',
  'record',
  'gacha',
]

const KEYBOARD = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p', 'qazwsxedcrfvtgbyhnujmikolp']

/** 常见的字符替换。数字 1 既可能代替 l 也可能代替 i，两种都试 */
const LEET_BASE: Record<string, string> = { '@': 'a', '4': 'a', '0': 'o', '3': 'e', $: 's', '5': 's', '7': 't', '!': 'i', '8': 'b', '9': 'g' }
const LEET_VARIANTS: Record<string, string>[] = [
  { ...LEET_BASE, '1': 'l' },
  { ...LEET_BASE, '1': 'i' },
]

function markAll(weak: boolean[], text: string, needle: string): void {
  if (needle.length < 3) return
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    for (let i = at; i < at + needle.length; i++) weak[i] = true
  }
}

/** 连续（升序或降序，步长 1）的字符，长度 4 以上 */
function markSequences(weak: boolean[], chars: readonly string[]): void {
  for (const step of [1, -1]) {
    let start = 0
    for (let i = 1; i <= chars.length; i++) {
      const ok = i < chars.length && chars[i]!.length === 1 && chars[i - 1]!.length === 1 && chars[i]!.charCodeAt(0) - chars[i - 1]!.charCodeAt(0) === step
      if (!ok) {
        if (i - start >= 4) for (let k = start; k < i; k++) weak[k] = true
        start = i
      }
    }
  }
}

/** 重复：同一个字符连续 3 次以上；或者长度 1–6 的片段连续重复，总长 4 以上 */
function markRepeats(weak: boolean[], chars: readonly string[]): void {
  const n = chars.length
  for (let unit = 1; unit <= 6; unit++) {
    for (let start = 0; start + unit < n; start++) {
      let end = start + unit
      while (end < n && chars[end] === chars[end - unit]) end++
      const length = end - start
      if (length >= unit * 2 && length >= (unit === 1 ? 3 : 4)) for (let k = start; k < end; k++) weak[k] = true
    }
  }
}

function markKeyboard(weak: boolean[], text: string): void {
  for (const row of KEYBOARD) {
    for (const line of [row, [...row].toReversed().join('')]) {
      for (let len = line.length; len >= 4; len--) {
        for (let s = 0; s + len <= line.length; s++) markAll(weak, text, line.slice(s, s + len))
      }
    }
  }
}

/** 年份（1900–2099）和 8 位日期 */
function markDates(weak: boolean[], text: string): void {
  for (const re of [/(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/g, /(19|20)\d{2}/g]) {
    for (const m of text.matchAll(re)) for (let i = m.index; i < m.index + m[0].length; i++) weak[i] = true
  }
}

/** 去掉常见单词和各种规律之后，还剩多少个字符 */
/** 按码点拆开后再拼回字符串，保证位置一一对应（每个码点算一个位置） */
const toText = (list: readonly string[]) => list.map((c) => (c.length === 1 ? c : '\u0000')).join('')

export function remainingStrength(password: string): number {
  const chars = Array.from(password.toLowerCase())
  const weak = chars.map(() => false)
  const forms = [chars, ...LEET_VARIANTS.map((map) => chars.map((c) => map[c] ?? c))]
  for (const form of forms) {
    const text = toText(form)
    for (const word of WORDS) markAll(weak, text, word)
    markSequences(weak, form)
    markRepeats(weak, form)
    markKeyboard(weak, text)
  }
  markDates(weak, toText(chars))
  return weak.filter((w) => !w).length
}

export interface PasswordCheck {
  ok: boolean
  issues: PasswordIssue[]
  /** 达到建议：16 位以上 */
  suggested: boolean
}

export function checkPassword(password: string, context: { uid?: string; nickName?: string } = {}): PasswordCheck {
  const issues: PasswordIssue[] = []
  const length = Array.from(password).length
  if (length < MIN_LENGTH) issues.push('too_short')
  if (length > MAX_LENGTH) issues.push('too_long')
  if (!/\p{Lu}/u.test(password)) issues.push('missing_upper')
  if (!/\p{Ll}/u.test(password)) issues.push('missing_lower')
  if (!/\d/.test(password)) issues.push('missing_digit')
  if (password !== password.trim()) issues.push('edge_space')
  const lower = password.toLowerCase()
  const normalized = LEET_VARIANTS.map((map) => Array.from(lower, (c) => map[c] ?? c).join(''))
  if (COMMON.has(lower) || normalized.some((n) => COMMON.has(n))) issues.push('common')
  else if (length >= MIN_LENGTH && remainingStrength(password) < MIN_REMAINING) issues.push('pattern')
  if (context.uid && context.uid.length >= 4 && password.includes(context.uid)) issues.push('contains_uid')
  const name = context.nickName?.trim().toLowerCase()
  if (name && Array.from(name).length >= 3 && lower.includes(name)) issues.push('contains_name')
  return { ok: issues.length === 0, issues, suggested: length >= SUGGESTED_LENGTH }
}

/** “生成”用的字符：大小写字母和数字，去掉容易看混的 0 O 1 l I（57 个） */
export const GENERATOR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** 生成随机密码（拒绝采样保证每个字符等概率），保证同时有大写、小写、数字，并且通过上面的检查 */
export function generatePassword(length = SUGGESTED_LENGTH): string {
  const n = GENERATOR_ALPHABET.length
  const limit = 256 - (256 % n)
  for (;;) {
    let out = ''
    while (out.length < length) {
      for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
        if (b < limit && out.length < length) out += GENERATOR_ALPHABET[b % n]
      }
    }
    if (checkPassword(out).ok) return out
  }
}
