// 仅供测试：Worker 的类型配置不含 Node 类型（会与 Workers 的全局类型冲突），这里只声明测试用到的 node:sqlite 接口
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string)
    prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): Record<string, unknown>[] }
  }
}
