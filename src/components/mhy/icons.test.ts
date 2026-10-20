// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

async function setup(rpc: (method: string, params?: unknown) => Promise<unknown>) {
  vi.resetModules()
  window.arkrecord = { rpc: vi.fn(rpc), platform: 'win32' }
  return (await import('./icons')).mhyIconUrl
}

describe('mhyIconUrl', () => {
  it('把用到的中文名攒起来一起查，给出 /api/img/bwiki/ 的地址；不安全的路径丢掉；同一个名称只查一次', async () => {
    const mhyIconUrl = await setup(async () => ({
      items: { 琴: 'images/ys/1/11/abcdefghijklmnopqrstu.png', 刻晴: 'images/../secret.png', 迪卢克: 'images/ys/a.png?x=1' },
      complete: true,
    }))
    for (const name of ['琴', '刻晴', '迪卢克', 'Bailu', '琴']) expect(mhyIconUrl('genshin', name)).toBeUndefined()
    await vi.waitFor(() => expect(mhyIconUrl('genshin', '琴')).toBe('/api/img/bwiki/images/ys/1/11/abcdefghijklmnopqrstu.png'))
    expect(mhyIconUrl('genshin', '刻晴')).toBeUndefined()
    expect(mhyIconUrl('genshin', '迪卢克')).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(window.arkrecord!.rpc).toHaveBeenCalledTimes(1)
    // 不带汉字的名称（别的语言的记录）不查
    expect(window.arkrecord!.rpc).toHaveBeenCalledWith('mhy.icons', { game: 'genshin', names: ['琴', '刻晴', '迪卢克'] })
  })

  it('之后用到的新名称再查一次，只查新的', async () => {
    const mhyIconUrl = await setup(async (_method, params) => {
      const names = (params as { names: string[] }).names
      return { items: Object.fromEntries(names.map((n, i) => [n, `images/sr/${i}/0${i}/abcdefghijklmnopqrst.png`])), complete: true }
    })
    mhyIconUrl('starrail', '白露')
    await vi.waitFor(() => expect(mhyIconUrl('starrail', '白露')).toBeDefined())
    mhyIconUrl('starrail', '希儿')
    await vi.waitFor(() => expect(mhyIconUrl('starrail', '希儿')).toBeDefined())
    expect(vi.mocked(window.arkrecord!.rpc).mock.calls.map((c) => c[1])).toEqual([
      { game: 'starrail', names: ['白露'] },
      { game: 'starrail', names: ['希儿'] },
    ])
  })

  it('后端没查完（BWIKI 限速、退避中）时，10 分钟后用到头像的地方会自动再问', async () => {
    vi.useFakeTimers()
    let calls = 0
    const mhyIconUrl = await setup(async () => {
      calls++
      return calls === 1 ? { items: {}, complete: false } : { items: { 琴: 'images/ys/1/11/abcdefghijklmnopqrstu.png' }, complete: true }
    })
    const { computed } = await import('vue')
    const url = computed(() => mhyIconUrl('genshin', '琴'))
    expect(url.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(url.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toBe(2)
    expect(url.value).toBe('/api/img/bwiki/images/ys/1/11/abcdefghijklmnopqrstu.png')
    vi.useRealTimers()
  })

  it('后端没有这个方法时只显示文字，不反复请求', async () => {
    const mhyIconUrl = await setup(() => Promise.reject({ code: -32601, message: '不允许调用这个方法' }))
    expect(mhyIconUrl('starrail', '白露')).toBeUndefined()
    await vi.waitFor(() => expect(window.arkrecord!.rpc).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mhyIconUrl('starrail', '白露')).toBeUndefined()
    expect(mhyIconUrl('starrail', '希儿')).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(window.arkrecord!.rpc).toHaveBeenCalledTimes(1)
  })
})
