/** 类型声明：实现见 ak-pools.js（构建脚本是纯 Node 脚本，所以共用的代码写成 JS） */

export declare const PRTS_GACHA_TABLE: string

/** { poolId: { 星级: [charId] } } */
export type UpLists = Record<string, Record<string, string[]>>

export declare function extractUpLists(table: unknown): UpLists
export declare function limitedChars(table: unknown): Record<string, string>
export declare function poolIds(table: unknown): string[]
export declare function inferRuleType(poolId: string): string
