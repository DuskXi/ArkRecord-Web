// 仅供测试（worker/token-fields.test.ts）：Worker 的类型配置不含 Node 类型，这里只声明用到的 node:fs、node:path 接口
declare module 'node:fs' {
  export function readdirSync(path: string): string[]
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function statSync(path: string): { isDirectory(): boolean }
}
declare module 'node:path' {
  export function join(...parts: string[]): string
  export function relative(from: string, to: string): string
}
