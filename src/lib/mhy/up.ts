/**
 * 米哈游活动卡池的“歪没歪”和大小保底。
 *
 * 官方规则（游戏内“祈愿详情 / 跃迁详情”）：
 *   原神角色活动（301、400 共用）：出 5★ 时 50% 是本期 UP；不是的话，下一个 5★ 必是 UP（大保底），跨期继承。
 *     5.0 起的「捕获明光」官方没有公布概率，记录里也看不出是不是它，这里不区分。
 *   原神武器活动：75% 是两把 UP 之一；不是的话下一个必是 UP 之一。玩家定轨了哪把记录里没有，只判断是不是 UP。
 *   星铁角色活动 50%、光锥活动 75%，规则同上。
 * 新手、常驻、集录、联动池不判断。
 *
 * 怎么判断是不是 UP：活动池里“歪”出来的只会是常驻的 5★，所以看名称在不在常驻名单里（记录语言是简体中文时）。
 * 例外都按时间写在下面：
 *   - 常驻角色在自己首次 UP 的那一期是 UP（提纳里、迪希雅、梦见月瑞希），刻晴 2021 年有过一期 UP；
 *   - 原神的常驻 5★ 武器经常是当期 UP 之一（例如和璞鸢），那几期是 UP；名单只核对到 GENSHIN_WEAPONS_CHECKED，
 *     之后抽到常驻武器时看不出来；
 *   - 星铁 3.2 起角色活动跃迁“歪”的范围由玩家在常驻保底池里自选，加进了几位前限定角色（3.2：希儿、刃、符玄；
 *     4.2：云璃、银枝、银狼），他们之后也可能再当 UP。加入之后抽到他们时：同一期（gacha_id）里出过别的 UP 就是歪，
 *     处于大保底就是 UP，否则看不出来。
 * 来源：游戏内祈愿详情 / 跃迁详情；往期卡池的时间和 UP 名单按 BWIKI 的“往期祈愿”“跃迁”页面整理（2026-10-20），
 * 时间是服务器时间（和记录的 time 字段一致）。
 */
import type { Analysis } from '../stats/analyze'
import type { PullEvent } from '../stats/events'
import type { Guarantee } from '../stats/guarantees'
import { type GuaranteeState, guaranteeStates } from '../stats/up-tag'
import { OFFICIAL_RATES } from './models'
import type { MhyGame, MhyPull } from './types'

// 大小保底的现状在共用代码里（抽卡规划面板也要用）
export { type GuaranteeState, guaranteeStates } from '../stats/up-tag'

/** 'up' 是本期 UP；'off' 歪了；'unsure' 看不出来 */
export type UpKind = 'up' | 'off' | 'unsure'

interface FallbackItem {
  name: string
  /** 在这之前是 UP（自己首次 UP 的那一期），之后才进常驻 */
  offFrom?: string
  /** 当过当期 UP 的时间段 [开始, 结束] */
  up?: readonly (readonly [string, string])[]
  /** 星铁自选的前限定角色：在这之前只可能是 UP，之后看不出来 */
  unsureFrom?: string
}

interface FallbackRules {
  /** 名称按这个语言写的；记录是别的语言时不判断 */
  lang: string
  /** 角色活动池歪出来的范围 */
  character: readonly FallbackItem[]
  /** 武器 / 光锥活动池歪出来的范围 */
  weapon: readonly FallbackItem[]
  /** 武器的 UP 时间段核对到哪天；之后抽到有 up 时间段的常驻武器时看不出来 */
  weaponCheckedUntil?: string
}

/** 原神常驻武器当过 UP 的往期名单核对到这一期结束（7.1 下半） */
export const GENSHIN_WEAPONS_CHECKED = '2026-11-03 14:59:59'

export const FALLBACK: Record<MhyGame, FallbackRules> = {
  genshin: {
    lang: 'zh-cn',
    character: [
      { name: '琴' },
      { name: '莫娜' },
      { name: '七七' },
      { name: '迪卢克' },
      { name: '刻晴', up: [['2021-02-17 18:00:00', '2021-03-02 15:59:59']] },
      { name: '提纳里', offFrom: '2022-09-09 18:00:00' },
      { name: '迪希雅', offFrom: '2023-03-21 18:00:00' },
      { name: '梦见月瑞希', offFrom: '2025-03-04 18:00:00' },
    ],
    weapon: [
      { name: '天空之翼', up: [['2020-11-11 10:00:00', '2020-12-01 15:59:59'], ['2021-04-06 18:00:00', '2021-04-27 14:59:59'], ['2021-12-14 18:00:00', '2022-01-04 14:59:59']] },
      { name: '天空之卷', up: [['2020-12-23 10:00:00', '2021-01-12 15:59:59'], ['2021-06-29 18:00:00', '2021-07-20 17:59:59']] },
      { name: '天空之脊', up: [['2021-07-21 11:00:00', '2021-08-10 17:59:59']] },
      { name: '天空之傲', up: [['2021-01-12 18:00:00', '2021-02-02 14:59:59'], ['2021-06-09 10:30:00', '2021-06-29 17:59:59']] },
      { name: '天空之刃', up: [['2021-03-17 10:00:00', '2021-04-06 15:59:59'], ['2021-08-10 18:00:00', '2021-08-31 14:59:59']] },
      {
        name: '阿莫斯之弓',
        up: [
          ['2020-09-28 12:00:00', '2020-10-18 17:59:59'],
          ['2021-01-12 18:00:00', '2021-02-02 14:59:59'],
          ['2022-01-25 18:00:00', '2022-02-15 14:59:59'],
          ['2022-09-09 18:00:00', '2022-09-27 14:59:59'],
          ['2023-05-02 18:00:00', '2023-05-23 14:59:59'],
        ],
      },
      {
        name: '四风原典',
        up: [
          ['2020-10-20 18:00:00', '2020-11-10 14:59:59'],
          ['2021-04-06 18:00:00', '2021-04-27 14:59:59'],
          ['2021-06-09 10:30:00', '2021-06-29 17:59:59'],
          ['2022-07-13 11:00:00', '2022-08-02 17:59:59'],
          // 3.8 版本更新后开始
          ['2023-07-05 00:00:00', '2023-07-25 17:59:59'],
        ],
      },
      {
        name: '和璞鸢',
        up: [
          ['2021-02-03 10:00:00', '2021-02-23 15:59:59'],
          ['2022-01-05 11:00:00', '2022-01-25 17:59:59'],
          ['2022-05-31 11:00:00', '2022-06-21 17:59:59'],
          ['2023-01-18 11:00:00', '2023-02-07 17:59:59'],
          ['2024-02-20 18:00:00', '2024-03-12 14:59:59'],
        ],
      },
      { name: '狼的末路', up: [['2020-10-20 18:00:00', '2020-11-10 14:59:59'], ['2021-02-23 18:00:00', '2021-03-16 14:59:59']] },
      { name: '风鹰剑', up: [['2020-09-28 12:00:00', '2020-10-18 17:59:59'], ['2021-05-18 18:00:00', '2021-06-08 14:59:59']] },
    ],
    weaponCheckedUntil: GENSHIN_WEAPONS_CHECKED,
  },
  starrail: {
    lang: 'zh-cn',
    character: [
      { name: '姬子' },
      { name: '瓦尔特' },
      { name: '布洛妮娅' },
      { name: '杰帕德' },
      { name: '克拉拉' },
      { name: '彦卿' },
      { name: '白露' },
      // 3.2、4.2 加进常驻保底池的前限定角色（日期取版本更新前，宁可多标“看不出来”）
      { name: '希儿', unsureFrom: '2025-04-01 00:00:00' },
      { name: '刃', unsureFrom: '2025-04-01 00:00:00' },
      { name: '符玄', unsureFrom: '2025-04-01 00:00:00' },
      { name: '云璃', unsureFrom: '2026-04-15 00:00:00' },
      { name: '银枝', unsureFrom: '2026-04-15 00:00:00' },
      { name: '银狼', unsureFrom: '2026-04-15 00:00:00' },
    ],
    weapon: [
      { name: '银河铁道之夜' },
      { name: '以世界之名' },
      { name: '但战斗还未结束' },
      { name: '无可取代的东西' },
      { name: '制胜的瞬间' },
      { name: '如泥酣眠' },
      { name: '时节不居' },
    ],
  },
}

/** 判断大小保底的卡池组（types.ts 的 MHY_POOLS）；值是 FALLBACK 里用哪份名单 */
const EVENT_GROUPS: Record<string, 'character' | 'weapon'> = { character: 'character', weapon: 'weapon', lightcone: 'weapon' }

/** 小保底时最高星是 UP 的官方概率 */
export const UP_SHARE: Record<string, number> = { character: 0.5, weapon: 0.75, lightcone: 0.75 }

export function isEventGroup(group: string): boolean {
  return group in EVENT_GROUPS
}

/** 活动池开始的时间：版本更新时各服务器的本地时间不同，开始前一天内看不出来 */
const START_MARGIN_MS = 24 * 3600 * 1000

function shift(time: string, ms: number): string {
  return new Date(Date.parse(`${time.replace(' ', 'T')}Z`) + ms).toISOString().slice(0, 19).replace('T', ' ')
}

/** 只看名称和时间的判断（不看大小保底和同一期的其他记录）；不适用时为 null */
export function classifyUp(game: MhyGame, group: string, pull: Pick<MhyPull, 'name' | 'time' | 'lang'>): UpKind | null {
  const list = EVENT_GROUPS[group]
  const rules = FALLBACK[game]
  if (!list || pull.lang !== rules.lang || !pull.time) return null
  const item = rules[list].find((i) => i.name === pull.name)
  if (!item) return 'up'
  const t = pull.time
  if (item.offFrom && t < item.offFrom) return 'up'
  if (item.unsureFrom) return t < item.unsureFrom ? 'up' : 'unsure'
  for (const [from, to] of item.up ?? []) {
    if (t >= from && t <= to) return 'up'
    if (t >= shift(from, -START_MARGIN_MS) && t < from) return 'unsure'
  }
  if (item.up && list === 'weapon' && rules.weaponCheckedUntil && t > rules.weaponCheckedUntil) return 'unsure'
  return 'off'
}

/**
 * 给活动池的最高星填上 isUp、guarantee、upShare（events 和 pulls 一一对应，已按时间排好）。
 * 每个保底分组从“不知道大小保底”开始：第一次看到歪就知道之前是小保底；看到 UP 之后下一个是小保底。
 */
export function assignUp(game: MhyGame, items: readonly { event: PullEvent; pull: MhyPull; group: string }[], topStar = 5): void {
  const tops = items.filter((x) => x.event.star === topStar && isEventGroup(x.group))
  const kinds = new Map(tops.map((x) => [x, classifyUp(game, x.group, x.pull)]))

  // 星铁：同一期（gacha_id）里出过确定是 UP 的另一位，就说明看不出来的这位是歪的
  const upNames = new Map<string, Set<string>>()
  for (const x of tops) {
    if (kinds.get(x) !== 'up' || !x.pull.gachaId) continue
    let names = upNames.get(x.pull.gachaId)
    if (!names) upNames.set(x.pull.gachaId, (names = new Set()))
    names.add(x.pull.name)
  }
  for (const x of tops) {
    if (kinds.get(x) !== 'unsure' || !x.pull.gachaId) continue
    const names = upNames.get(x.pull.gachaId)
    if (names && [...names].some((n) => n !== x.pull.name)) kinds.set(x, 'off')
  }

  const state = new Map<string, 'small' | 'big'>()
  const isTop = new Set(tops)
  for (const x of items) {
    const e = x.event
    if (!isTop.has(x)) {
      // 空档（gaps.ts）之后看不出大小保底，从头算
      if (e.gapAfter !== undefined) state.delete(e.family)
      continue
    }
    const before = state.get(e.family)
    const kind = kinds.get(x) ?? null
    e.upShare = UP_SHARE[x.group]
    if (before === 'big' && kind !== 'off') {
      e.isUp = true
      e.guarantee = 'big'
      state.set(e.family, 'small')
    } else if (before === 'big') {
      // 大保底却是常驻的：名单或时间对不上，只标歪，仍是大保底
      e.isUp = false
    } else if (kind === 'off') {
      e.isUp = false
      e.guarantee = 'small'
      state.set(e.family, 'big')
    } else if (kind === 'up') {
      e.isUp = true
      if (before === 'small') e.guarantee = 'small'
      state.set(e.family, 'small')
    } else {
      e.isUp = null
      if (before === 'small') e.guarantee = 'small'
      state.delete(e.family)
    }
    if (e.gapAfter !== undefined) state.delete(e.family)
  }
}

const STATE_TEXT: Record<GuaranteeState, (group: string, game: MhyGame) => string> = {
  big: (group, game) => `大保底：下一个 5★ 必是${game === 'genshin' && group === 'weapon' ? ' UP 武器之一' : ' UP'}`,
  small: (group, game) =>
    `小保底：下一个 5★ 有 ${Math.round((UP_SHARE[group] ?? 0) * 100)}% 是${game === 'genshin' && group === 'weapon' ? ' UP 武器之一' : ' UP'}`,
  unknown: () => '大小保底看不出来（记录里还没有能判断的 5★）',
}

/**
 * 总览页“保底”卡片：每个活动池保底分组现在的大小保底和已垫抽数（进度条是垫抽 / 最多多少抽必出 5★）。
 * 原神武器的定轨（命定值）记录里看不到，不显示。
 */
export function mhyGuarantees(game: MhyGame, analysis: Analysis, events: readonly PullEvent[]): Guarantee[] {
  const states = guaranteeStates(events, analysis.topStar)
  const out: Guarantee[] = []
  for (const p of analysis.pity) {
    const group = p.family.slice(p.family.indexOf(':') + 1)
    const rates = OFFICIAL_RATES[game][group]
    if (!isEventGroup(group) || !rates) continue
    const state = states.get(p.family) ?? 'unknown'
    // 记录的空档（gaps.ts）之后：垫抽只算了空档之后的
    const label = p.afterGap ? `大小保底看不出来（中间有一段没有记录的空档，已垫至少 ${p.current} 抽）` : STATE_TEXT[state](group, game)
    out.push({ poolName: p.label, label, current: p.current, target: rates.hardPity, done: false })
  }
  return out
}
