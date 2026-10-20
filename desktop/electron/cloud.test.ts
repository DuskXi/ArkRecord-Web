import { describe, expect, it, vi } from 'vitest'
import { CLOUD_OPS as SHARED_OPS, CLOUD_PREFIX as SHARED_PREFIX } from '../../shared/cloud-protocol.js'
import { checkSameOrigin } from '../../worker/security.js'
import { CLOUD_OPS, CLOUD_PREFIX, MAX_REQUEST_BYTES, forwardCloud } from './cloud.js'

const SITE = 'https://ark.kaltsit.dev'
const post = (op: string, body: Uint8Array<ArrayBuffer> = new Uint8Array([0, 2, 123, 125])) =>
  new Request(`app://arkrecord${CLOUD_PREFIX}${op}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-arkrecord-client': '1' }, body })

describe('forwardCloud', () => {
  it('和 shared/cloud-protocol.ts 的接口一致', () => {
    expect(CLOUD_PREFIX).toBe(SHARED_PREFIX)
    expect([...CLOUD_OPS].toSorted()).toEqual([...SHARED_OPS].toSorted())
  })

  it('原样转发到网站，带 x-arkrecord-client 和 Referer，不带 Cookie、不跟随跳转；Worker 的同源检查能通过', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'a=b' } }),
    )
    const res = await forwardCloud(post('pull'), SITE, fetcher)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')

    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(`${SITE}/api/cloud/v1/pull`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' })
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(new Uint8Array([0, 2, 123, 125]))
    const sent = new Request(url, init)
    expect(sent.headers.get('content-type')).toBe('application/octet-stream')
    expect(checkSameOrigin(sent)).toBeNull()
  })

  it('Worker 的错误码和等待时间原样交给页面', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 429, headers: { 'x-arkrecord-cloud': 'locked', 'retry-after': '120' } }))
    const res = await forwardCloud(post('pull'), SITE, fetcher)
    expect(res.status).toBe(429)
    expect(res.headers.get('x-arkrecord-cloud')).toBe('locked')
    expect(res.headers.get('retry-after')).toBe('120')
  })

  it('info 用 GET', async () => {
    const fetcher = vi.fn(async () => Response.json({ protocol: 1 }))
    const res = await forwardCloud(new Request(`app://arkrecord${CLOUD_PREFIX}info`), SITE, fetcher)
    expect(await res.json()).toEqual({ protocol: 1 })
    expect(fetcher).toHaveBeenCalledWith(`${SITE}/api/cloud/v1/info`, expect.objectContaining({ method: 'GET', body: undefined }))
  })

  it('白名单以外的操作、带查询参数、方法不对、请求体太大：不发请求', async () => {
    const fetcher = vi.fn(async () => new Response(null))
    expect((await forwardCloud(post('evil'), SITE, fetcher)).status).toBe(404)
    expect((await forwardCloud(post('pull?x=1'), SITE, fetcher)).status).toBe(404)
    expect((await forwardCloud(post('../hg/x'), SITE, fetcher)).status).toBe(404)
    expect((await forwardCloud(new Request(`app://arkrecord${CLOUD_PREFIX}pull`), SITE, fetcher)).status).toBe(405)
    expect((await forwardCloud(post('info'), SITE, fetcher)).status).toBe(405)
    const big = await forwardCloud(post('push', new Uint8Array(MAX_REQUEST_BYTES + 1)), SITE, fetcher)
    expect(big.status).toBe(413)
    expect(big.headers.get('x-arkrecord-cloud')).toBe('body_too_large')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('没有网站地址时返回 503；网络出错返回 502（network），页面显示“网络连接失败”', async () => {
    const offline = await forwardCloud(post('pull'), undefined, vi.fn())
    expect(offline.status).toBe(503)
    expect(offline.headers.get('x-arkrecord-cloud')).toBe('cloud_unavailable')
    const failed = await forwardCloud(post('pull'), SITE, async () => Promise.reject(new TypeError('fetch failed')))
    expect(failed.status).toBe(502)
    expect(failed.headers.get('x-arkrecord-cloud')).toBe('network')
  })
})
