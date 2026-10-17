/**
 * Argon2id（docs/rewrite/cloud-sync.md 7.7）。原则：慢可以接受，算不出来不行。
 *
 *   - 两套实现：WebAssembly 版（hash-wasm，快）和纯 JS 版（@noble/hashes）。WebAssembly 被禁用时
 *     （iOS 锁定模式、部分企业管理的浏览器、不认识 CSP 'wasm-unsafe-eval' 的旧浏览器）自动换纯 JS，
 *     只要浏览器能运行这个网站就能算出来，只是快慢不同。
 *   - 两套实现的结果必须逐字节相同：CI 用 RFC 9106 的测试向量和随机输入交叉比对（argon2.test.ts）；
 *     浏览器第一次使用前再用固定测试向量自检，不通过就换另一套，两套都不通过就报错，绝不用错的结果。
 *   - 参数写死在协议版本里（ARGON2_V1）。以后升级参数，旧版本的参数永远保留，已开通的账号永远算得出原来的钥匙。
 */

export interface Argon2Params {
  /** 遍数 */
  t: number
  /** 内存（KiB） */
  m: number
  /** 并行度 */
  p: number
  /** 输出字节数 */
  dkLen: number
}

/** 协议 v1：32 MiB、3 遍、并行度 1、输出 256 位 */
export const ARGON2_V1: Argon2Params = Object.freeze({ t: 3, m: 32 * 1024, p: 1, dkLen: 32 })

export type Argon2Impl = 'wasm' | 'js'

/** 自检用的固定测试向量（由通过了 RFC 9106 测试向量的实现算出，见 argon2.test.ts） */
export const SELF_TEST = Object.freeze({
  password: 'arkrecord-selftest-密码',
  salt: 'arkrecord-salt-0',
  params: Object.freeze({ t: 2, m: 64, p: 1, dkLen: 32 }) as Argon2Params,
  expected: '26a639a3690bd4eb1c12bbbbdc59b7cb0c64627b6ccc848276ff6c6563339b55',
})

type Runner = (password: Uint8Array, salt: Uint8Array, params: Argon2Params, onProgress?: (fraction: number) => void) => Promise<Uint8Array>

const runWasm: Runner = async (password, salt, params) => {
  const hashWasm = await import('hash-wasm')
  return hashWasm.argon2id({
    password,
    salt,
    iterations: params.t,
    memorySize: params.m,
    parallelism: params.p,
    hashLength: params.dkLen,
    outputType: 'binary',
  })
}

const runJs: Runner = async (password, salt, params, onProgress) => {
  const { argon2idAsync } = await import('@noble/hashes/argon2.js')
  return argon2idAsync(password, salt, { t: params.t, m: params.m, p: params.p, dkLen: params.dkLen, asyncTick: 20, onProgress })
}

export const RUNNERS: Record<Argon2Impl, Runner> = { wasm: runWasm, js: runJs }

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** 用固定测试向量检查一套实现：能运行并且结果正确才算通过 */
export async function selfTest(impl: Argon2Impl): Promise<boolean> {
  try {
    const enc = new TextEncoder()
    const out = await RUNNERS[impl](enc.encode(SELF_TEST.password), enc.encode(SELF_TEST.salt), SELF_TEST.params)
    return hex(out) === SELF_TEST.expected
  } catch {
    return false
  }
}

export class Argon2UnavailableError extends Error {
  constructor() {
    super('这个浏览器无法完成密码派生（两套实现的自检都没有通过），请换一个浏览器使用云同步')
    this.name = 'Argon2UnavailableError'
  }
}

let chosen: Promise<Argon2Impl> | null = null

/** 选出第一套自检通过的实现（每个页面只检查一次） */
export function chooseImpl(order: readonly Argon2Impl[] = ['wasm', 'js']): Promise<Argon2Impl> {
  chosen ??= (async () => {
    for (const impl of order) if (await selfTest(impl)) return impl
    throw new Argon2UnavailableError()
  })()
  // 失败时允许下次重试
  chosen.catch(() => (chosen = null))
  return chosen
}

/** 计算 Argon2id。已选定的实现中途出错（例如内存不够）时，换另一套再试一次 */
export async function argon2id(
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2Params = ARGON2_V1,
  onProgress?: (fraction: number) => void,
): Promise<{ hash: Uint8Array; impl: Argon2Impl }> {
  const first = await chooseImpl()
  try {
    return { hash: await RUNNERS[first](password, salt, params, onProgress), impl: first }
  } catch (error) {
    const other: Argon2Impl = first === 'wasm' ? 'js' : 'wasm'
    if (!(await selfTest(other))) throw error
    return { hash: await RUNNERS[other](password, salt, params, onProgress), impl: other }
  }
}
