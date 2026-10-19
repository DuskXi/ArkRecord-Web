import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountsForDesktopStats, desktopStatsStatus, reportDesktopStats, setDesktopStatsEnabled } from './desktop-stats'

afterEach(() => vi.unstubAllGlobals())

const accounts = [
  { id: 'arknights:demo', game: 'arknights', uid: 'demo' },
  { id: 'arknights:100000001', game: 'arknights', uid: '100000001' },
  { id: 'endfield:200000002', game: 'endfield', uid: '200000002' },
] as const

describe('desktop stats', () => {
  it('passes only game and UID of real accounts to the backend', () => {
    expect(accountsForDesktopStats(accounts as never)).toEqual([
      { game: 'arknights', uid: '100000001' },
      { game: 'endfield', uid: '200000002' },
    ])
  })

  it('does nothing in the web version', async () => {
    expect(await desktopStatsStatus()).toBeNull()
    expect(await setDesktopStatsEnabled(false)).toBe(false)
    expect(() => reportDesktopStats(accounts as never)).not.toThrow()
  })

  it('talks to the backend in the desktop app', async () => {
    const rpc = vi.fn(async (method: string) => (method === 'stats.status' ? { enabled: true, available: true } : { ok: true }))
    vi.stubGlobal('window', { arkrecord: { rpc, platform: 'win32' } })
    expect(await desktopStatsStatus()).toEqual({ enabled: true, available: true })
    expect(await setDesktopStatsEnabled(false)).toBe(true)
    reportDesktopStats(accounts as never)
    expect(rpc).toHaveBeenCalledWith('stats.setEnabled', { enabled: false })
    expect(rpc).toHaveBeenCalledWith('stats.report', { accounts: accountsForDesktopStats(accounts as never) })
    reportDesktopStats([], 'a'.repeat(32))
    expect(rpc).toHaveBeenLastCalledWith('stats.report', { accounts: [], user: 'a'.repeat(32) })
  })

  it('treats backend failures as unavailable', async () => {
    vi.stubGlobal('window', { arkrecord: { rpc: vi.fn(() => Promise.reject({ code: -32601, message: 'x' })), platform: 'linux' } })
    expect(await desktopStatsStatus()).toBeNull()
    expect(await setDesktopStatsEnabled(true)).toBe(false)
    expect(() => reportDesktopStats([])).not.toThrow()
  })
})
