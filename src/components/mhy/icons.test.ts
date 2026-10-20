// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

async function setup(rpc: (method: string, params?: unknown) => Promise<unknown>) {
  vi.resetModules()
  window.arkrecord = { rpc: vi.fn(rpc), platform: 'win32' }
  return (await import('./icons')).mhyIconUrl
}

describe('mhyIconUrl', () => {
  it('按中文名给出 /api/img/bwiki/ 的地址，不安全的路径丢掉，每个游戏只拿一次名单', async () => {
    const mhyIconUrl = await setup(async () => ({
      items: { 琴: 'images/ys/thumb/a/ab/abc.png/128px-abc.png', 坏路径: 'images/../secret.png', 带参数: 'images/ys/a.png?x=1', 不是字符串: 1 },
    }))
    expect(mhyIconUrl('genshin', '琴')).toBeUndefined()
    await vi.waitFor(() => expect(mhyIconUrl('genshin', '琴')).toBe('/api/img/bwiki/images/ys/thumb/a/ab/abc.png/128px-abc.png'))
    expect(mhyIconUrl('genshin', '坏路径')).toBeUndefined()
    expect(mhyIconUrl('genshin', '带参数')).toBeUndefined()
    expect(mhyIconUrl('genshin', '不是字符串')).toBeUndefined()
    expect(window.arkrecord!.rpc).toHaveBeenCalledTimes(1)
    expect(window.arkrecord!.rpc).toHaveBeenCalledWith('mhy.icons', { game: 'genshin' })
  })

  it('后端没有这个方法时只显示文字，不反复请求', async () => {
    const mhyIconUrl = await setup(() => Promise.reject({ code: -32601, message: '不允许调用这个方法' }))
    expect(mhyIconUrl('starrail', '白露')).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mhyIconUrl('starrail', '白露')).toBeUndefined()
    expect(window.arkrecord!.rpc).toHaveBeenCalledTimes(1)
  })
})
