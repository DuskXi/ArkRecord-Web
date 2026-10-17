/**
 * 云同步的流程（docs/rewrite/cloud-sync.md 7、10）。
 *
 *   - cloudStatus：查询云端有没有开通、是哪种方式（需要鹰角 OAuth token 证明账号是你的）。
 *   - enableCloud：开通 / 覆盖。需要鹰角 OAuth token 证明账号是你的；用新密码、新 DEK 上传本地的完整快照，
 *     云端原有的数据整体换掉（忘记密码时就用它，从数据最全的浏览器覆盖）。开通（不是覆盖）前先查询状态，
 *     云端已经开通时拒绝，不会误覆盖别的设备上传的数据。
 *
 * 鹰角 OAuth token 只由调用方传入：界面只有在用户点击并确认之后才会换取它（见 consent.ts）。
 *   - unlockCloud：在新设备上（或者密码在别处改过、云端被覆盖之后）输入密码，下载并合并云端数据，再上传本地多出来的。
 *   - syncCloud：一次云同步，最多两个请求：下载新批次并合并 → 上传本地多出来的记录（批次多了就改为上传快照）。
 *   - changePassword：知道旧密码时改密码，只换包裹，不用重新上传数据。
 *   - setTwoFactor：开关鹰角 token 双重验证（两样证明都要有）。
 *   - deleteCloud：删除云端数据（忘记密码时可以只用鹰角 token）。
 *   - forgetCloud：只删除这台设备上的状态和钥匙。
 *
 * 合并走与从鹰角同步、导入文件相同的规则（merge.ts），所以重复下载、批次乱序、失败重试都不影响结果。
 */
import {
  type CloudGame,
  COMPACT_AT,
  computeLocator,
  fromBase64Url,
  MAX_ENVELOPE_BYTES,
  toBase64Url,
} from '../../../shared/cloud-protocol'
import { makeAccountId } from '../archive'
import { db } from '../db'
import type { Account } from '../types'
import {
  apiClaim,
  apiDelete,
  apiPull,
  apiPush,
  apiRekey,
  apiStatus,
  apiTwoFactor,
  CloudApiError,
  type CloudStatus,
  type Proof,
  type PullMeta,
} from './api'
import { type CloudDataset, CodecError, decodeDatasetBytes, encodeDatasetBytes, fingerprint, UnsupportedVersionError } from './codec'
import { generateDek, newBatchId, openEnvelope, passwordKeys, randomKid, sealEnvelope, unwrapDek, wrapDek } from './crypto'
import { applyDataset, readLocalDataset, recordCount, recordHashes, subset } from './dataset'
import { checkPassword } from './password'
import { type CloudState, dropKeys, keysOf, loadState, removeState, saveState } from './state'

export type CloudSyncErrorCode =
  /** 这台设备上没有保存钥匙，需要输入密码 */
  | 'need_password'
  /** 开启了双重验证，需要鹰角 token */
  | 'need_hg'
  /** 密码在别处改过，或者云端被覆盖了 */
  | 'auth_changed'
  /** 输入的密码不对（或者需要双重验证、或者还没开通） */
  | 'wrong_password'
  /** 云端数据的格式版本比这个网页新 */
  | 'version'
  /** 云端数据不合规范（不应该发生） */
  | 'corrupt'
  /** 数据太多，一个请求放不下 */
  | 'too_large'
  /** 密码不符合规则 */
  | 'weak_password'
  /** 这个账号还没有开通云同步 */
  | 'not_enabled'
  /** 开通时发现云端已经开通了（应该输入密码，忘记密码才覆盖） */
  | 'already_enabled'

export class CloudSyncError extends Error {
  constructor(
    readonly code: CloudSyncErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CloudSyncError'
  }
}

export interface SyncSummary {
  /** 从云端合并进本地的新记录数 */
  downloaded: number
  /** 上传的记录数 */
  uploaded: number
  /** 这次是否把云端合并成了一个快照 */
  compacted: boolean
  fingerprint: string
}

const b64 = toBase64Url

function hgOf(game: CloudGame, uid: string, oauthToken?: string): Proof['hg'] {
  return oauthToken ? { game, uid, token: oauthToken } : undefined
}

async function sealDataset(dek: CryptoKey, locator: string, kid: number, kind: 'delta' | 'snapshot', ds: CloudDataset): Promise<Uint8Array> {
  const envelope = await sealEnvelope(dek, locator, kid, kind, encodeDatasetBytes(ds), newBatchId())
  if (envelope.length > MAX_ENVELOPE_BYTES) throw new CloudSyncError('too_large', '这个账号的数据太多，一次上传不完（超过 1 MiB）。请反馈给作者。')
  return envelope
}

/** delta 太大时对半拆开，每份都放得进一个请求 */
async function sealDeltas(dek: CryptoKey, locator: string, kid: number, ds: CloudDataset, ids: string[]): Promise<Uint8Array[]> {
  const envelope = await sealEnvelope(dek, locator, kid, 'delta', encodeDatasetBytes(subset(ds, new Set(ids))), newBatchId())
  if (envelope.length <= MAX_ENVELOPE_BYTES) return [envelope]
  if (ids.length <= 1) throw new CloudSyncError('too_large', '有一条记录太大，无法上传。请反馈给作者。')
  const half = Math.ceil(ids.length / 2)
  return [...(await sealDeltas(dek, locator, kid, ds, ids.slice(0, half))), ...(await sealDeltas(dek, locator, kid, ds, ids.slice(half)))]
}

/** 查询云端有没有开通这个账号、是哪种方式：服务器核实鹰角 token、确认账号是你的才回答 */
export async function cloudStatus(target: { game: CloudGame; uid: string }, oauthToken: string): Promise<CloudStatus> {
  return apiStatus({ game: target.game, uid: target.uid, token: oauthToken })
}

/**
 * 开通 / 覆盖：用新密码、新 DEK 上传本地的完整快照，云端原有的数据整体换掉。
 * overwrite 为 false（开通）时先查询状态，云端已经开通就拒绝。
 */
export async function enableCloud(
  account: Account,
  options: {
    password: string
    oauthToken: string
    requireHg: boolean
    remember: boolean
    overwrite: boolean
    onProgress?: (fraction: number) => void
  },
): Promise<CloudState> {
  const check = checkPassword(options.password, { uid: account.uid, nickName: account.nickName })
  if (!check.ok) throw new CloudSyncError('weak_password', '密码不符合规则。')
  const game = account.game
  if (!options.overwrite && (await cloudStatus(account, options.oauthToken)).exists) {
    throw new CloudSyncError('already_enabled', '这个账号已经在别处开通了云同步：请输入云同步密码。只有忘记密码时才需要覆盖云端。')
  }
  const keys = await passwordKeys(game, account.uid, options.password, { onProgress: options.onProgress })
  const locator = await computeLocator(game, account.uid)
  const dek = await generateDek()
  const kid = randomKid()
  const wrapped = await wrapDek(dek, keys.kek, locator, kid)
  const ds = await readLocalDataset(account)
  const envelope = await sealDataset(dek, locator, kid, 'snapshot', ds)
  const { seq } = await apiClaim(
    { hg: hgOf(game, account.uid, options.oauthToken) },
    { authKey: b64(keys.authKey), wrappedDek: b64(wrapped), kid, requireHg: options.requireHg },
    envelope,
  )
  // 存下来的是不可导出的副本
  const stored = await unwrapDek(wrapped, keys.kek, locator, kid)
  const state: CloudState = {
    accountId: account.id,
    game,
    uid: account.uid,
    locator,
    mode: 'password',
    remember: options.remember,
    kid,
    requireHg: options.requireHg,
    lastSeq: seq,
    remote: Object.fromEntries(recordHashes(ds)),
    lastSyncAt: Date.now(),
    fingerprint: await fingerprint(ds),
  }
  await saveState(state, { authKey: keys.authKey, dek: stored })
  return state
}

/** 输入密码，下载并合并云端数据（新设备上会按云端的账号信息新建账号），再上传本地多出来的 */
export async function unlockCloud(
  target: { game: CloudGame; uid: string },
  options: { password: string; remember: boolean; oauthToken?: string; onProgress?: (fraction: number) => void },
): Promise<SyncSummary> {
  const { game, uid } = target
  const keys = await passwordKeys(game, uid, options.password, { onProgress: options.onProgress })
  const locator = await computeLocator(game, uid)
  const hg = hgOf(game, uid, options.oauthToken)
  let pulled: { meta: PullMeta; envelopes: Uint8Array[] }
  try {
    pulled = await apiPull({ locator, authKey: b64(keys.authKey), hg }, 0)
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401) {
      throw new CloudSyncError(
        'wrong_password',
        hg
          ? '密码不对，或者这个账号还没有开通云同步。'
          : '密码不对，或者这个账号还没有开通云同步；如果开启了双重验证，还需要提供鹰角 token。',
      )
    }
    throw error
  }
  const wrapped = fromBase64Url(pulled.meta.wrappedDek)
  if (!wrapped) throw new CloudSyncError('corrupt', '云端的钥匙格式不对。')
  const dek = await unwrapDek(wrapped, keys.kek, locator, pulled.meta.kid)
  const previous = await loadState(makeAccountId(game, uid))
  const state: CloudState = {
    accountId: makeAccountId(game, uid),
    game,
    uid,
    locator,
    mode: 'password',
    remember: options.remember,
    kid: pulled.meta.kid,
    requireHg: pulled.meta.requireHg,
    lastSeq: 0,
    // 换了钥匙（云端被覆盖）就从头来过；只是重新输入同一个密码时保留进度
    remote: previous?.kid === pulled.meta.kid ? previous.remote : {},
  }
  const keyPair = { authKey: keys.authKey, dek }
  await saveState(state, keyPair)
  return runSync(state, keyPair, hg, pulled)
}

/** 一次云同步 */
export async function syncCloud(accountId: string, options: { oauthToken?: string } = {}): Promise<SyncSummary> {
  const state = await loadState(accountId)
  if (!state) throw new CloudSyncError('not_enabled', '这个账号还没有开通云同步。')
  const keys = keysOf(state)
  if (!keys) throw new CloudSyncError('need_password', '请输入云同步密码。')
  if (state.requireHg && !options.oauthToken) throw new CloudSyncError('need_hg', '这个账号开启了双重验证，需要鹰角 token。')
  return runSync(state, keys, state.requireHg ? hgOf(state.game, state.uid, options.oauthToken) : undefined)
}

async function runSync(
  state: CloudState,
  keys: { authKey: Uint8Array; dek: CryptoKey },
  hg: Proof['hg'],
  prefetched?: { meta: PullMeta; envelopes: Uint8Array[] },
): Promise<SyncSummary> {
  const proof: Proof = { locator: state.locator, authKey: b64(keys.authKey), hg }
  const authChanged = async () => {
    await dropKeys(state.accountId)
    return new CloudSyncError('auth_changed', '云同步密码已在别处修改，或者云端已被覆盖，请重新输入密码。')
  }

  // ── 1. 下载并合并 ──
  let pulled = prefetched
  if (!pulled) {
    try {
      pulled = await apiPull(proof, state.lastSeq)
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 401) throw await authChanged()
      throw error
    }
  }
  if (pulled.meta.kid !== state.kid) throw await authChanged()

  let downloaded = 0
  const seen = new Map<string, Set<string>>()
  for (const envelope of pulled.envelopes) {
    const { header, plaintext } = await openEnvelope(keys.dek, state.locator, envelope)
    if (header.kid !== state.kid) throw new CloudSyncError('corrupt', '云端有一批数据的钥匙编号不对。')
    let ds: CloudDataset
    try {
      ds = decodeDatasetBytes(plaintext)
    } catch (error) {
      if (error instanceof UnsupportedVersionError) throw new CloudSyncError('version', error.message)
      throw new CloudSyncError('corrupt', error instanceof CodecError ? `云端数据不合规范：${error.message}` : String(error))
    }
    if (ds.game !== state.game || ds.uid !== state.uid) throw new CloudSyncError('corrupt', '云端数据属于另一个账号。')
    downloaded += await applyDataset(ds)
    for (const [id, hash] of recordHashes(ds)) {
      let set = seen.get(id)
      if (!set) seen.set(id, (set = new Set()))
      set.add(hash)
    }
  }

  // ── 2. 本地现状：云端已经有了哪些版本 ──
  const account = await db.accounts.get(state.accountId)
  if (!account) throw new CloudSyncError('corrupt', '本地找不到这个账号。')
  const local = await readLocalDataset(account)
  const localHashes = recordHashes(local)
  const remote = { ...state.remote }
  for (const [id, hashes] of seen) {
    const mine = localHashes.get(id)
    // 云端已有本地的这个版本；否则记下云端的版本（本地保留了更好的版本，下面会上传）
    remote[id] = mine !== undefined && (hashes.has(mine) || remote[id] === mine) ? mine : [...hashes].at(-1)!
  }

  // ── 3. 上传本地多出来的 ──
  let lastSeq = pulled.meta.headSeq
  const advance = (seq: number) => {
    // 只有中间没有别的设备上传时才能跳过自己刚上传的批次，否则下次要连别人的一起下载
    if (seq === lastSeq + 1) lastSeq = seq
  }
  const changed = [...localHashes].filter(([id, hash]) => remote[id] !== hash).map(([id]) => id)
  let uploaded = 0
  let compacted = false
  const snapshot = async () => {
    const envelope = await sealDataset(keys.dek, state.locator, state.kid, 'snapshot', local)
    const result = await apiPush(proof, envelope, pulled.meta.headSeq)
    advance(result.seq)
    for (const key of Object.keys(remote)) delete remote[key]
    Object.assign(remote, Object.fromEntries(localHashes))
    uploaded = recordCount(local)
    compacted = true
  }
  try {
    if (pulled.meta.count >= COMPACT_AT) {
      await snapshot()
    } else if (changed.length) {
      try {
        for (const envelope of await sealDeltas(keys.dek, state.locator, state.kid, local, changed)) advance((await apiPush(proof, envelope)).seq)
        for (const id of changed) remote[id] = localHashes.get(id)!
        uploaded = changed.filter((id) => id !== 'a').length
      } catch (error) {
        if (!(error instanceof CloudApiError && error.code === 'compact_required')) throw error
        await snapshot()
      }
    }
  } catch (error) {
    if (error instanceof CloudApiError && (error.status === 401 || error.code === 'stale_key')) throw await authChanged()
    throw error
  }

  const print = await fingerprint(local)
  // 带上钥匙一起保存：state 可能是刚解锁时新建的，里面没有钥匙
  await saveState({ ...state, lastSeq, remote, lastSyncAt: Date.now(), fingerprint: print }, keys)
  return { downloaded, uploaded, compacted, fingerprint: print }
}

/** 知道旧密码时改密码：只换包裹，不用重新上传数据 */
export async function changePassword(
  accountId: string,
  options: { oldPassword: string; newPassword: string; oauthToken?: string; onProgress?: (fraction: number) => void },
): Promise<void> {
  const state = await loadState(accountId)
  if (!state) throw new CloudSyncError('not_enabled', '这个账号还没有开通云同步。')
  const account = await db.accounts.get(accountId)
  if (!checkPassword(options.newPassword, { uid: state.uid, nickName: account?.nickName }).ok) throw new CloudSyncError('weak_password', '新密码不符合规则。')
  if (state.requireHg && !options.oauthToken) throw new CloudSyncError('need_hg', '这个账号开启了双重验证，需要鹰角 token。')
  const hg = state.requireHg ? hgOf(state.game, state.uid, options.oauthToken) : undefined
  const progress = (base: number) => (f: number) => options.onProgress?.(base + f / 2)
  const old = await passwordKeys(state.game, state.uid, options.oldPassword, { onProgress: progress(0) })
  const proof: Proof = { locator: state.locator, authKey: b64(old.authKey), hg }
  let meta: PullMeta
  try {
    meta = (await apiPull(proof, state.lastSeq)).meta
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401) throw new CloudSyncError('wrong_password', '旧密码不对。')
    throw error
  }
  const wrapped = fromBase64Url(meta.wrappedDek)
  if (!wrapped) throw new CloudSyncError('corrupt', '云端的钥匙格式不对。')
  const dek = await unwrapDek(wrapped, old.kek, state.locator, meta.kid, true)
  const fresh = await passwordKeys(state.game, state.uid, options.newPassword, { onProgress: progress(0.5) })
  const rewrapped = await wrapDek(dek, fresh.kek, state.locator, meta.kid)
  await apiRekey(proof, { newAuthKey: b64(fresh.authKey), wrappedDek: b64(rewrapped) })
  const stored = await unwrapDek(rewrapped, fresh.kek, state.locator, meta.kid)
  await saveState({ ...state, kid: meta.kid }, { authKey: fresh.authKey, dek: stored })
}

/** 开关鹰角 token 双重验证：需要这台设备上的钥匙和鹰角 token */
export async function setTwoFactor(accountId: string, enabled: boolean, oauthToken: string): Promise<void> {
  const state = await loadState(accountId)
  if (!state) throw new CloudSyncError('not_enabled', '这个账号还没有开通云同步。')
  const keys = keysOf(state)
  if (!keys) throw new CloudSyncError('need_password', '请先输入云同步密码。')
  await apiTwoFactor({ locator: state.locator, authKey: b64(keys.authKey), hg: hgOf(state.game, state.uid, oauthToken) }, enabled)
  await saveState({ ...state, requireHg: enabled })
}

/** 删除云端数据：优先用这台设备上的钥匙；忘记密码时只用鹰角 token。成功后也删除这台设备上的状态 */
export async function deleteCloud(target: { game: CloudGame; uid: string }, options: { oauthToken?: string } = {}): Promise<void> {
  const accountId = makeAccountId(target.game, target.uid)
  const state = await loadState(accountId)
  const keys = state ? keysOf(state) : null
  const locator = await computeLocator(target.game, target.uid)
  const hg = hgOf(target.game, target.uid, options.oauthToken)
  if (!keys && !hg) throw new CloudSyncError('need_hg', '没有这台设备上的钥匙时，需要用鹰角 token 证明账号是你的。')
  await apiDelete({ locator, ...(keys ? { authKey: b64(keys.authKey) } : {}), hg })
  await removeState(accountId)
}

/** 退出云同步：只删除这台设备上的状态和钥匙，云端不变 */
export async function forgetCloud(accountId: string): Promise<void> {
  await removeState(accountId)
}
