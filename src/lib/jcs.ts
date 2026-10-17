/**
 * JSON 规范化（RFC 8785，JCS）与相关的比较工具，供云同步编码（src/lib/cloud/codec.ts）和合并规则（merge.ts）使用。
 *
 * 数据模型（docs/rewrite/cloud-sync.md 9.3）：值只能是字符串、有限数字、布尔、null、数组和普通对象。
 *   - 对象的键按 UTF-16 码元排序，数组保持原顺序，没有空白；
 *   - 字符串、数字的写法与 ECMAScript 的 JSON.stringify 相同（RFC 8785 正是这样规定的）；
 *   - 对象里值为 undefined 的键等同于没有这个键，这是唯一的一条归一化规则。
 *
 * strict 模式下（云同步编码使用），无法无损表示的值直接报错：不成对的代理项（UTF-8 表示不了）、-0、
 * NaN / Infinity、数组里的 undefined、非普通对象。宽松模式只用于合并时比较两个版本的先后，永远不报错。
 */

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalError'
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function isWellFormed(text: string): boolean {
  return !LONE_SURROGATE.test(text)
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

/** RFC 8785 规范化。strict 为 true 时，遇到无法无损表示的值就抛出 CanonicalError */
export function jcs(value: unknown, strict = true): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      if (strict && !isWellFormed(value)) throw new CanonicalError('字符串包含无法用 UTF-8 表示的字符')
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) {
        if (strict) throw new CanonicalError('数字必须是有限值')
        return 'null'
      }
      if (strict && Object.is(value, -0)) throw new CanonicalError('不支持 -0')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item: unknown) => {
            if (item === undefined) {
              if (strict) throw new CanonicalError('数组里不能有 undefined')
              return 'null'
            }
            return jcs(item, strict)
          })
          .join(',')}]`
      }
      if (strict && !isPlainObject(value)) throw new CanonicalError('只支持普通对象')
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
      // 默认的字符串排序就是按 UTF-16 码元比较，与 RFC 8785 一致
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries
        .map(([k, v]) => {
          if (strict && !isWellFormed(k)) throw new CanonicalError('键名包含无法用 UTF-8 表示的字符')
          return `${JSON.stringify(k)}:${jcs(v, strict)}`
        })
        .join(',')}}`
    }
    default:
      if (strict) throw new CanonicalError(`不支持的值类型：${typeof value}`)
      return 'null'
  }
}

/** 按 UTF-8 字节序比较两个字符串（等价于按 Unicode 码点比较） */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0
  const ia = a[Symbol.iterator]()
  const ib = b[Symbol.iterator]()
  for (;;) {
    const x = ia.next()
    const y = ib.next()
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1
    const cx = x.value.codePointAt(0)!
    const cy = y.value.codePointAt(0)!
    if (cx !== cy) return cx < cy ? -1 : 1
  }
}
