import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_ERROR, INVALID_PARAMS, RpcClient, RpcError } from './rpc.js'

/** 模拟后端：toBackend 是主进程写给后端的内容，fromBackend 是后端的 stdout */
function setup() {
  const toBackend = new PassThrough()
  const fromBackend = new PassThrough()
  const warnings: string[] = []
  const client = new RpcClient(toBackend, fromBackend, (message) => warnings.push(message))
  const sent: unknown[] = []
  toBackend.setEncoding('utf8')
  toBackend.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) sent.push(JSON.parse(line))
  })
  const reply = (message: unknown) => fromBackend.write(`${JSON.stringify(message)}\n`)
  return { client, fromBackend, sent, warnings, reply }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('RpcClient', () => {
  it('一行一个请求，按 id 对应响应', async () => {
    const { client, sent, reply } = setup()
    const first = client.request('ping', undefined, 1000)
    const second = client.request('echo', { text: '你好' }, 1000)
    await tick()
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'echo', params: { text: '你好' } },
    ])
    // 响应可以乱序
    reply({ jsonrpc: '2.0', id: 2, result: { text: '你好' } })
    reply({ jsonrpc: '2.0', id: 1, result: { pong: true } })
    await expect(first).resolves.toEqual({ pong: true })
    await expect(second).resolves.toEqual({ text: '你好' })
  })

  it('一个响应被拆成多段、中文被从中间截断也能拼起来', async () => {
    const { client, fromBackend } = setup()
    const result = client.request('ping', undefined, 1000)
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { name: '明日方舟' } })}\r\n`)
    const cut = bytes.indexOf(Buffer.from('方')) + 1
    fromBackend.write(bytes.subarray(0, cut))
    await tick()
    fromBackend.write(bytes.subarray(cut))
    await expect(result).resolves.toEqual({ name: '明日方舟' })
  })

  it('后端返回的错误原样交给调用方', async () => {
    const { client, reply } = setup()
    const result = client.request('mhy.read', {}, 1000)
    reply({ jsonrpc: '2.0', id: 1, error: { code: APP_ERROR, message: '链接已过期', data: { kind: 'authkey_expired' } } })
    const error = (await result.catch((reason: unknown) => reason)) as RpcError
    expect(error).toBeInstanceOf(RpcError)
    expect(error.toJSON()).toEqual({ code: APP_ERROR, message: '链接已过期', data: { kind: 'authkey_expired' } })
  })

  it('非 JSON 的输出和对不上的 id 只记一条提示，不输出内容', async () => {
    const { client, fromBackend, reply, warnings } = setup()
    const result = client.request('ping', undefined, 1000)
    fromBackend.write('token=secret\n')
    reply({ jsonrpc: '2.0', id: 99, result: null })
    reply({ jsonrpc: '2.0', id: 1, result: 'ok' })
    await expect(result).resolves.toBe('ok')
    expect(warnings).toHaveLength(2)
    expect(warnings.join('\n')).not.toContain('secret')
  })

  it('参数只能是对象或数组，且能转成 JSON', async () => {
    const { client, sent } = setup()
    await expect(client.request('ping', 'text', 1000)).rejects.toMatchObject({ code: INVALID_PARAMS })
    await expect(client.request('ping', { n: 1n }, 1000)).rejects.toMatchObject({ code: INVALID_PARAMS })
    await tick()
    expect(sent).toEqual([])
  })

  it('超时', async () => {
    vi.useFakeTimers()
    const { client } = setup()
    const result = client.request('ping', undefined, 5000)
    vi.advanceTimersByTime(5000)
    await expect(result).rejects.toMatchObject({ code: APP_ERROR, data: { kind: 'timeout' } })
  })

  it('后端退出时，等待中和之后的请求都失败', async () => {
    const { client, fromBackend } = setup()
    const pending = client.request('ping', undefined, 1000)
    fromBackend.end()
    await expect(pending).rejects.toMatchObject({ data: { kind: 'backend_unavailable' } })
    expect(client.closed).toBe(true)
    await expect(client.request('ping', undefined, 1000)).rejects.toMatchObject({ data: { kind: 'backend_unavailable' } })
  })
})
