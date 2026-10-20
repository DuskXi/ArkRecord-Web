/**
 * 桌面版总览（四款游戏）用的摘要：每款游戏、每个账号的总抽数、最高星个数、当前垫抽、运气、上次读取。
 * 只在桌面版里（网页版的构建引用到这个目录会报错，见 vite.config.ts 的 DESKTOP_ONLY）。
 *
 * - 鹰角两款读 ArkRecordDB（src/lib/db.ts），米哈游两款读 MhyDB（src/lib/mhy/db.ts），统计用同一个引擎。
 * - 总抽数、最高星个数算全部记录（终末地、原神、星铁含武器 / 光锥）；当前垫抽、运气只看角色范围，
 *   取“适用主模型、最近抽过”的那个保底分组。
 * - 米哈游的模型是按官方数字推算的（derived），页面上要标“推算，非官方”。
 * - 最近的最高星（recentTop）算全部记录，带 weapon 标记；isUp、guarantee 交给 upTag 显示。
 * - 每月抽数按北京时间（UTC+8）分月，最近 12 个月，全部账号合计。
 * - 不含演示账号（DEMO_ACCOUNT_ID）。
 */
import { type ArkRecordDB, db as hgDb } from '../db'
import { DEMO_ACCOUNT_ID } from '../demo-account'
import type { AkMeta, EfMeta } from '../meta'
import { MHY_GAME_LABEL, type MhyGame } from '../mhy/types'
import { type MhyDB, mhyDb } from '../mhy/db'
import { normalizeMhy } from '../mhy/events'
import { mhyModel } from '../mhy/models'
import { type Analysis, analyze, type PityModel } from '../stats/analyze'
import type { PullEvent } from '../stats/events'
import { normalizeArknights, normalizeEndfield } from '../stats/events'
import { guaranteeStates } from '../stats/up-tag'
import { GAME_LABEL } from '../types'
import { MODELS } from '@/stores/records'

export type DashboardGame = 'arknights' | 'endfield' | 'genshin' | 'starrail'

/** 一个最高星（总览上的“最近出金”） */
export interface TopHit {
  accountId: string
  /** 物品名 */
  name: string
  itemId: string | null
  ts: number
  /** 这个保底分组里第几抽出的；终末地免费十连出的不计保底，为 null */
  pity: number | null
  isUp: boolean | null
  guarantee?: 'small' | 'big'
  /** 武器 / 光锥 */
  weapon: boolean
}

export interface AccountSummary {
  accountId: string
  uid: string
  /** 鹰角是游戏昵称（没有时是 UID），米哈游是 UID */
  name: string
  pulls: number
  /** 最高星的个数 */
  top: number
  /** 最高星出货率（top / pulls）；没有记录时为 null */
  topRate: number | null
  /** 角色范围平均多少抽出一个最高星（只算适用主模型的保底分组）；还没出过时为 null */
  avgPerTop: number | null
  /** 这个账号最近的 5 个最高星，新的在前 */
  recentTop: TopHit[]
  lastSyncAt?: number
  /** 角色池当前的垫抽 */
  pity?: { label: string; current: number; hardPity: number }
  /** 角色范围的运气百分位（0–1，越大越欧）；没有概率模型或还没出过最高星时为 null */
  luck: number | null
  /** 运气、期望是按官方数字推算的（米哈游），页面要标“推算，非官方” */
  derived: boolean
  /** 米哈游：角色活动池现在是大保底、小保底，还是看不出来 */
  guarantee?: 'small' | 'big' | 'unknown'
}

export interface GameSummary {
  game: DashboardGame
  vendor: 'hypergryph' | 'mihoyo'
  label: string
  topStar: number
  accounts: AccountSummary[]
  pulls: number
  top: number
  lastSyncAt?: number
  /** 全部账号最近的 12 个最高星，新的在前 */
  recentTop: TopHit[]
  /** 最近 12 个月每月抽数（北京时间），旧的在前，全部账号合计 */
  monthly: { month: string; pulls: number }[]
}

const RECENT_PER_ACCOUNT = 5
const RECENT_PER_GAME = 12
const MONTHS = 12
const BEIJING_MS = 8 * 3600_000

/** “YYYY-MM”（北京时间） */
function monthOf(ts: number): string {
  return new Date(ts + BEIJING_MS).toISOString().slice(0, 7)
}

/** 截至 now 所在的月份，最近 n 个月（旧的在前） */
function lastMonths(now: number, n: number): string[] {
  const d = new Date(now + BEIJING_MS)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - (n - 1 - i), 1)).toISOString().slice(0, 7))
}

const EMPTY_AK_META: AkMeta = { version: '', generatedAt: '', upAvailable: false, chars: {}, pools: {}, avatars: [] }

/** 角色范围里“适用主模型、最近抽过”的保底分组 */
function mainPity(analysis: Analysis): AccountSummary['pity'] {
  const state = analysis.pity.filter((p) => p.mainModel).toSorted((a, b) => b.lastTs - a.lastTs)[0]
  return state ? { label: state.label, current: state.current, hardPity: state.hardPity } : undefined
}

interface AccountResult {
  summary: AccountSummary
  character: PullEvent[]
  /** 全部最高星（新的在前） */
  hits: TopHit[]
  /** 每条记录的时间（统计每月抽数） */
  times: number[]
}

function summarizeAccount(
  base: Pick<AccountSummary, 'accountId' | 'uid' | 'name' | 'lastSyncAt'>,
  all: readonly PullEvent[],
  model: PityModel,
  topStar: number,
): AccountResult {
  const character = all.filter((e) => !e.weapon)
  const analysis = analyze(character, model)
  // 每个最高星是第几抽出的：保底按分组计，武器、角色各自分组，所以用全部记录再算一次
  const pityOf = new Map(analyze([...all], { ...model, topStar }).hits.map((h) => [h.event.key, h.pity]))
  const hits = all
    .filter((e) => e.star === topStar)
    .map(
      (e): TopHit => ({
        accountId: base.accountId,
        name: e.name,
        itemId: e.itemId,
        ts: e.ts,
        pity: pityOf.get(e.key) ?? null,
        isUp: e.isUp,
        ...(e.guarantee ? { guarantee: e.guarantee } : {}),
        weapon: e.weapon,
      }),
    )
    .toSorted((a, b) => b.ts - a.ts)
  return {
    character,
    hits,
    times: all.map((e) => e.ts),
    summary: {
      ...base,
      pulls: all.length,
      top: hits.length,
      topRate: all.length ? hits.length / all.length : null,
      avgPerTop: analysis.avgPerSix,
      recentTop: hits.slice(0, RECENT_PER_ACCOUNT),
      pity: mainPity(analysis),
      luck: analysis.luck,
      derived: !!model.derived,
    },
  }
}

function gameSummary(
  game: DashboardGame,
  vendor: GameSummary['vendor'],
  label: string,
  topStar: number,
  results: AccountResult[],
  now: number,
): GameSummary {
  const accounts = results.map((r) => r.summary)
  const syncs = accounts.map((a) => a.lastSyncAt).filter((t): t is number => typeof t === 'number')
  const months = lastMonths(now, MONTHS)
  const counts = new Map(months.map((m) => [m, 0]))
  for (const r of results) {
    for (const ts of r.times) {
      const m = monthOf(ts)
      if (counts.has(m)) counts.set(m, counts.get(m)! + 1)
    }
  }
  return {
    game,
    vendor,
    label,
    topStar,
    accounts,
    pulls: accounts.reduce((n, a) => n + a.pulls, 0),
    top: accounts.reduce((n, a) => n + a.top, 0),
    ...(syncs.length ? { lastSyncAt: Math.max(...syncs) } : {}),
    recentTop: results
      .flatMap((r) => r.hits)
      .toSorted((a, b) => b.ts - a.ts)
      .slice(0, RECENT_PER_GAME),
    monthly: months.map((month) => ({ month, pulls: counts.get(month)! })),
  }
}

async function hypergryph(
  hg: ArkRecordDB,
  akMeta: AkMeta | null | undefined,
  efMeta: EfMeta | null | undefined,
  now: number,
): Promise<GameSummary[]> {
  const accounts = (await hg.accounts.toArray()).filter((a) => a.id !== DEMO_ACCOUNT_ID).toSorted((a, b) => a.createdAt - b.createdAt)
  const efPools = new Map((await hg.efPools.toArray()).map((p) => [p.poolId, p]))
  const out: Record<'arknights' | 'endfield', AccountResult[]> = { arknights: [], endfield: [] }
  for (const account of accounts) {
    const base = { accountId: account.id, uid: account.uid, name: account.nickName || account.uid, lastSyncAt: account.lastSyncAt }
    if (account.game === 'arknights') {
      const pulls = await hg.akPulls.where('accountId').equals(account.id).toArray()
      out.arknights.push(summarizeAccount(base, normalizeArknights(pulls, akMeta ?? EMPTY_AK_META), MODELS.arknights, 6))
    } else {
      const pulls = await hg.efPulls.where('accountId').equals(account.id).toArray()
      out.endfield.push(summarizeAccount(base, normalizeEndfield(pulls, efPools, efMeta ?? undefined), MODELS.endfield, 6))
    }
  }
  return [
    gameSummary('arknights', 'hypergryph', GAME_LABEL.arknights, 6, out.arknights, now),
    gameSummary('endfield', 'hypergryph', GAME_LABEL.endfield, 6, out.endfield, now),
  ]
}

async function mihoyo(mhy: MhyDB, game: MhyGame, now: number): Promise<GameSummary> {
  const accounts = (await mhy.accounts.where('game').equals(game).toArray()).toSorted((a, b) => a.createdAt - b.createdAt)
  const results: AccountResult[] = []
  for (const account of accounts) {
    const pulls = await mhy.pulls.where('accountId').equals(account.id).toArray()
    const base = { accountId: account.id, uid: account.uid, name: account.uid, lastSyncAt: account.lastSyncAt }
    const result = summarizeAccount(base, normalizeMhy(game, pulls), mhyModel(game, 'char'), 5)
    result.summary.guarantee = guaranteeStates(result.character).get(`${game}:character`) ?? 'unknown'
    results.push(result)
  }
  return gameSummary(game, 'mihoyo', MHY_GAME_LABEL[game], 5, results, now)
}

/** 四款游戏的摘要，顺序是明日方舟、终末地、原神、星铁；没有账号的游戏也返回（accounts 为空） */
export async function summarizeGames(
  input: { akMeta?: AkMeta | null; efMeta?: EfMeta | null; now?: number } = {},
  dbs: { hg?: ArkRecordDB; mhy?: MhyDB } = {},
): Promise<GameSummary[]> {
  const now = input.now ?? Date.now()
  const [arknights, endfield] = await hypergryph(dbs.hg ?? hgDb, input.akMeta, input.efMeta, now)
  const mhy = dbs.mhy ?? mhyDb
  return [arknights!, endfield!, await mihoyo(mhy, 'genshin', now), await mihoyo(mhy, 'starrail', now)]
}
