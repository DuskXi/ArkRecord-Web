/**
 * CI 检查（docs/rewrite/cloud-sync.md 4.3）：worker 和 shared 目录里，除了 worker/hg-verify.ts（及其测试），
 * 任何文件都不允许出现鹰角 token 的字段名。这样以后改代码时，不会在别处悄悄读取或转存 token。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// 用拼接构造，避免这个文件自己命中
// 透明转发的路由路径（例如 u8_token_by_uid）不算：那里只原样转发，不读取 token
const FORBIDDEN = new RegExp(['hg', 'oauth', 'account', 'grant'].map((p) => `${p}_?${'token'}`).join('|'), 'i')
const ALLOWED = new Set(['worker/hg-verify.ts', 'worker/hg-verify.test.ts'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('鹰角 token 只在 worker/hg-verify.ts 里出现', () => {
  it('worker、shared 目录的其他文件里没有 token 字段名', () => {
    const offenders: string[] = []
    for (const file of [...walk('worker'), ...walk('shared')]) {
      const rel = relative('.', file).replaceAll('\\', '/')
      if (ALLOWED.has(rel) || rel === 'worker/worker-configuration.d.ts') continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (FORBIDDEN.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('检查本身有效：hg-verify.ts 里确实能匹配到字段名', () => {
    expect(FORBIDDEN.test(readFileSync('worker/hg-verify.ts', 'utf8'))).toBe(true)
  })
})
