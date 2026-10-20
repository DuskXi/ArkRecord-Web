import { describe, expect, it, vi } from 'vitest'
import { serveImage } from './images.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const get = (path: string, method = 'GET') => new Request(`app://arkrecord${path}`, { method })

describe('serveImage', () => {
  it('把来源和路径交给 img.fetch（路径原样，不解码），返回图片', async () => {
    const fetchImage = vi.fn(async () => ({ status: 200, contentType: 'image/png', body: PNG.toString('base64') }))
    const response = await serveImage(get('/api/img/prts-avatar/char_002_amiya'), fetchImage)
    expect(fetchImage).toHaveBeenCalledWith('prts-avatar', 'char_002_amiya')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)

    await serveImage(get('/api/img/hycdn/upload/image/20260101/a%2Fb.png'), fetchImage)
    expect(fetchImage).toHaveBeenLastCalledWith('hycdn', 'upload/image/20260101/a%2Fb.png')
  })

  it('同一张图同时被要多次，只交给后端一次，每个请求都拿到完整的图片', async () => {
    const finish = new Map<string, (value: unknown) => void>()
    const fetchImage = vi.fn((_source: string, target: string) => new Promise((resolve) => finish.set(target, resolve)))
    const same = Array.from({ length: 5 }, () => serveImage(get('/api/img/bwiki/images/ys/1/11/abc.png'), fetchImage))
    const other = serveImage(get('/api/img/bwiki/images/ys/2/22/def.png'), fetchImage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 5 个相同的合并成 1 次，另一张图单独 1 次
    expect(fetchImage).toHaveBeenCalledTimes(2)

    const ok = { status: 200, contentType: 'image/png', body: PNG.toString('base64') }
    finish.get('images/ys/1/11/abc.png')!(ok)
    finish.get('images/ys/2/22/def.png')!({ status: 404 })
    for (const response of await Promise.all(same)) {
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
    }
    expect((await other).status).toBe(404)

    // 结果出来以后再要：重新交给后端（由后端的缓存回答）
    const again = vi.fn(async () => ok)
    expect((await serveImage(get('/api/img/bwiki/images/ys/1/11/abc.png'), again)).status).toBe(200)
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('合并的那次后端出错，等着的请求都返回 502，之后可以重试', async () => {
    let fail!: (error: Error) => void
    const fetchImage = vi.fn(() => new Promise((_resolve, reject) => (fail = reject)))
    const waiting = [serveImage(get('/api/img/bwiki/x/y.png'), fetchImage), serveImage(get('/api/img/bwiki/x/y.png'), fetchImage)]
    await new Promise((resolve) => setTimeout(resolve, 0))
    fail(new Error('backend gone'))
    expect((await Promise.all(waiting)).map((r) => r.status)).toEqual([502, 502])
    expect(fetchImage).toHaveBeenCalledTimes(1)
    const again = await serveImage(get('/api/img/bwiki/x/y.png'), async () => ({ status: 200, contentType: 'image/png', body: PNG.toString('base64') }))
    expect(again.status).toBe(200)
  })

  it('带查询参数、格式不对、不是 GET 的不交给后端', async () => {
    const fetchImage = vi.fn(async () => ({ status: 200, contentType: 'image/png', body: '' }))
    for (const path of ['/api/img/prts-avatar/char_002_amiya?v=1', '/api/img/prts-avatar', '/api/img//x', '/api/img/prts-avatar/', '/api/other']) {
      expect((await serveImage(get(path), fetchImage)).status).toBe(404)
    }
    expect((await serveImage(get('/api/img/prts-avatar/char_002_amiya', 'POST'), fetchImage)).status).toBe(405)
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('404 和 502 原样返回，不带正文', async () => {
    for (const status of [404, 502]) {
      const response = await serveImage(get('/api/img/x/y'), async () => ({ status }))
      expect(response.status).toBe(status)
      expect(await response.text()).toBe('')
    }
  })

  it('后端出错或结果不对时返回 502', async () => {
    const results: unknown[] = [
      null,
      'text',
      { status: 200, contentType: 'text/html', body: 'PGh0bWw+' },
      { status: 200, contentType: 'image/png' },
      { status: 200, body: 'AAAA' },
      { status: 500 },
    ]
    for (const result of results) expect((await serveImage(get('/api/img/x/y'), async () => result)).status).toBe(502)
    expect((await serveImage(get('/api/img/x/y'), () => Promise.reject(new Error('backend gone')))).status).toBe(502)
  })
})
