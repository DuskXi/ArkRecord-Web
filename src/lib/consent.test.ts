import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readConsent, writeConsent } from './consent'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('统计同意', () => {
  it('没有选择之前为 null（不启用任何统计）', () => {
    expect(readConsent()).toBeNull()
  })

  it('记住选择', () => {
    writeConsent('all')
    expect(readConsent()).toBe('all')
    writeConsent('essential')
    expect(readConsent()).toBe('essential')
  })

  it('旧版本里关掉过“参与统计”的，视为“仅必要”；重新选择后清掉旧开关', () => {
    localStorage.setItem('arkrecord:usage-optout', '1')
    expect(readConsent()).toBe('essential')
    writeConsent('all')
    expect(localStorage.getItem('arkrecord:usage-optout')).toBeNull()
    expect(readConsent()).toBe('all')
  })

  it('localStorage 不可用时视为没有选择', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(readConsent()).toBeNull()
  })
})
