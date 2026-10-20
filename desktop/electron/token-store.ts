/**
 * 鹰角 token 的保存文件（desktop/README.md 的“鹰角 token 的保存”）：应用数据目录下的 hg-tokens.json，
 * 格式 {version: 1, entries: {accountId: base64 密文}}。加密由调用方传入（主进程里是 Electron 的 safeStorage，
 * 即系统钥匙串）；这里只管文件格式、校验和读写，不依赖 Electron，便于测试。
 * 云同步的密码和钥匙（cloud-secrets.json，keychain.ts）用同样的格式，条目名和内容的规则另传（EntryRules）。
 *
 * - 写入先写临时文件再改名；能设权限的平台设成 0600。
 * - 读写按顺序一个一个来，同时保存几个账号也不会互相覆盖。
 * - 解不开（钥匙串变了）或格式不对的条目直接丢掉，并从文件里删掉；一条都不剩时删掉文件。
 * - token 和密文都不进日志和报错信息。
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises'

export const TOKEN_FILE = 'hg-tokens.json'

const ACCOUNT_ID = /^(arknights|endfield):[A-Za-z0-9_-]{1,64}$/
/** 可见 ASCII（不含空格），最长 4096 */
const TOKEN = /^[\x21-\x7e]{1,4096}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export const isAccountId = (value: unknown): value is string => typeof value === 'string' && ACCOUNT_ID.test(value)
export const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value)

/** 条目名和明文的格式：不对的不保存，读出来时丢掉 */
export interface EntryRules {
  isKey(value: unknown): value is string
  isValue(value: unknown): value is string
}

export const TOKEN_RULES: EntryRules = { isKey: isAccountId, isValue: isToken }

/**
 * 云同步的密码和钥匙（cloud-secrets.json，src/lib/cloud/secrets.ts）。维护者 2026-10-20：“密码不存前端存钥匙串”。
 *   - profile：同步配置（模式、云同步密码、选项），p1.<base64url(JSON)>；
 *   - 账号 ID：这个账号的 authKey 和 DEK（各 32 字节），k1.<base64url>.<base64url>。
 * 内容在页面里生成和解析，主进程只核对格式。
 */
export const CLOUD_SECRETS_FILE = 'cloud-secrets.json'
const PROFILE_ID = 'profile'
const PROFILE_VALUE = /^p1\.[\w-]{1,4000}$/
const KEYS_VALUE = /^k1\.[\w-]{43}\.[\w-]{43}$/
export const CLOUD_SECRET_RULES: EntryRules = {
  isKey: (value): value is string => value === PROFILE_ID || isAccountId(value),
  isValue: (value): value is string => typeof value === 'string' && (PROFILE_VALUE.test(value) || KEYS_VALUE.test(value)),
}
/** 条目名和内容要配对：profile 只能存同步配置，账号只能存钥匙 */
export const cloudSecretPairs = (id: string, value: string): boolean => (id === PROFILE_ID ? PROFILE_VALUE : KEYS_VALUE).test(value)

/** 加密、解密（主进程里是 safeStorage）。解密失败时抛错 */
export interface Cipher {
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

/** 解析文件内容，只留下格式对的条目（accountId → base64 密文）；文件坏了当作空的 */
export function parseTokenFile(text: string, isKey: EntryRules['isKey'] = isAccountId): Map<string, string> {
  const entries = new Map<string, string>()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return entries
  }
  if (typeof json !== 'object' || json === null) return entries
  const { version, entries: raw } = json as { version?: unknown; entries?: unknown }
  if (version !== 1 || typeof raw !== 'object' || raw === null) return entries
  for (const [id, value] of Object.entries(raw)) {
    if (isKey(id) && typeof value === 'string' && BASE64.test(value)) entries.set(id, value)
  }
  return entries
}

export function serializeTokenFile(entries: Map<string, string>): string {
  return `${JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }, null, 2)}\n`
}

export class TokenStore {
  private readonly path: string
  private readonly cipher: Cipher
  private readonly rules: EntryRules
  /** 读写排队，一次只做一个 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(path: string, cipher: Cipher, rules: EntryRules = TOKEN_RULES) {
    this.path = path
    this.cipher = cipher
    this.rules = rules
  }

  /** 解密所有条目，返回 accountId → token。解不开的条目丢掉，并从文件里删掉 */
  load(): Promise<Record<string, string>> {
    return this.serial(async () => {
      const entries = await this.read()
      const tokens: Record<string, string> = {}
      const broken: string[] = []
      for (const [id, data] of entries) {
        let token: string | undefined
        try {
          token = this.cipher.decrypt(Buffer.from(data, 'base64'))
        } catch {
          token = undefined
        }
        if (this.rules.isValue(token)) tokens[id] = token
        else broken.push(id)
      }
      if (broken.length) {
        for (const id of broken) entries.delete(id)
        await this.write(entries)
      }
      return tokens
    })
  }

  save(accountId: string, token: string): Promise<void> {
    if (!this.rules.isKey(accountId) || !this.rules.isValue(token)) return Promise.reject(new Error('条目名或内容格式不对'))
    return this.serial(async () => {
      const entries = await this.read()
      entries.set(accountId, this.cipher.encrypt(token).toString('base64'))
      await this.write(entries)
    })
  }

  delete(accountId: string): Promise<void> {
    if (!this.rules.isKey(accountId)) return Promise.reject(new Error('条目名格式不对'))
    return this.serial(async () => {
      const entries = await this.read()
      if (!entries.delete(accountId)) return
      await this.write(entries)
    })
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async read(): Promise<Map<string, string>> {
    try {
      return parseTokenFile(await readFile(this.path, 'utf8'), this.rules.isKey)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
  }

  private async write(entries: Map<string, string>): Promise<void> {
    if (!entries.size) {
      await rm(this.path, { force: true })
      return
    }
    const temp = `${this.path}.tmp`
    await writeFile(temp, serializeTokenFile(entries), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.path)
  }
}
