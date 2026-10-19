/**
 * 冒烟测试（npm run desktop:smoke）：页面加载后在页面里调用 window.arkrecord，
 * 检查 ping、方法白名单、hg.request 的路由白名单、页面拿不到 Node，结果写到终端，然后退出（退出码 0 表示通过）。
 * 不发出任何真实的网络请求：hg.request 只用白名单以外的路径，后端在发请求之前就会拒绝。
 */
import type { BrowserWindow } from 'electron'

const TIMEOUT_MS = 180_000
/** 应用没挂载时等页面刷新的时间：开发服务器重新预构建依赖后会自动刷新页面（之前的请求返回 504） */
const RELOAD_WAIT_MS = 30_000

/** 在页面里执行（和页面自己的代码一样，只能用 window.arkrecord） */
const PROBE = `(async () => {
  const bridge = window.arkrecord
  const mounted = () => document.querySelector('#app') !== null && document.querySelector('#app .boot') === null
  for (let i = 0; i < 100 && !mounted(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  const out = {
    bridge: typeof bridge,
    platform: bridge && bridge.platform,
    nodeInPage: typeof require !== 'undefined' || typeof process !== 'undefined',
    appMounted: mounted(),
  }
  if (!out.appMounted) {
    out.failedRequests = performance.getEntriesByType('resource').filter((r) => r.responseStatus >= 400).map((r) => r.responseStatus + ' ' + r.name).slice(0, 5)
    return out
  }
  try { out.ping = await bridge.rpc('ping') } catch (error) { out.pingError = error }
  try { await bridge.rpc('fs.readFile', ['C:/secret']); out.blocked = null } catch (error) { out.blocked = error }
  try {
    const result = await bridge.rpc('hg.request', { upstream: 'ak', path: '/arkrecord-smoke-test/not-allowed', envelope: '{}' })
    out.hgRoute = result && result.headers ? result.headers['x-arkrecord-proxy'] : result
  } catch (error) { out.hgRoute = error }
  if (location.protocol === 'app:') {
    const status = async (path) => { try { return (await fetch(path)).status } catch { return 'error' } }
    const home = await fetch('/')
    out.files = {
      csp: (home.headers.get('content-security-policy') || '').includes("default-src 'self'"),
      spaFallback: (await fetch('/history')).headers.get('content-type'),
      missingAsset: await status('/assets/missing.js'),
      traversal: await status('/..%2f..%2f..%2fpackage.json'),
      traversalBackslash: await status('/..%5c..%5c..%5cpackage.json'),
    }
  }
  return out
})()`

interface ProbeResult {
  bridge: string
  platform?: string
  nodeInPage: boolean
  appMounted: boolean
  failedRequests?: string[]
  ping?: { pong?: boolean; protocol?: number }
  pingError?: unknown
  blocked?: { code?: number } | null
  hgRoute?: unknown
  /** 只有 app:// 协议（正式构建）才检查 */
  files?: { csp: boolean; spaFallback: string | null; missingAsset: number | string; traversal: number | string; traversalBackslash: number | string }
}

function report(result: ProbeResult): boolean {
  const checks: Record<string, boolean> = {
    '页面有 window.arkrecord': result.bridge === 'object',
    'platform 正确': result.platform === process.platform,
    '页面里没有 require / process': !result.nodeInPage,
    '应用已挂载': result.appMounted,
  }
  if (result.appMounted) {
    checks['ping 成功、协议版本 1'] = result.ping?.pong === true && result.ping.protocol === 1
    checks['白名单以外的方法被拒绝（-32601）'] = result.blocked?.code === -32601
    checks['hg.request 拒绝白名单以外的路径（route_not_allowed）'] = result.hgRoute === 'route_not_allowed'
  }
  if (result.files) {
    checks['app:// 响应带 CSP'] = result.files.csp
    checks['app:// 页面地址回退到 index.html'] = result.files.spaFallback?.startsWith('text/html') === true
    checks['app:// 不存在的文件返回 404'] = result.files.missingAsset === 404
    checks['app:// 读不到产物目录以外的文件'] = result.files.traversal === 404 && result.files.traversalBackslash === 404
  }
  console.log(`[smoke] ${JSON.stringify(result)}`)
  for (const [name, ok] of Object.entries(checks)) console.log(`[smoke] ${ok ? '通过' : '失败'}：${name}`)
  return Object.values(checks).every(Boolean)
}

export function runSmokeTest(win: BrowserWindow, done: (ok: boolean) => void): void {
  let finished = false
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  const finish = (ok: boolean) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    clearTimeout(reloadTimer)
    done(ok)
  }
  const timer = setTimeout(() => {
    console.error('[smoke] 超时')
    finish(false)
  }, TIMEOUT_MS)

  // 页面里的报错也写到终端，检查失败时好找原因
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.log(`[smoke] 页面报错：${event.message}`)
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    // -3（ERR_ABORTED）是页面刷新时取消了上一次加载，不算失败
    if (code === -3) return
    console.error(`[smoke] 页面加载失败：${code} ${description}`)
    finish(false)
  })
  win.webContents.on('did-finish-load', async () => {
    clearTimeout(reloadTimer)
    let result: ProbeResult
    try {
      result = (await win.webContents.executeJavaScript(PROBE)) as ProbeResult
    } catch (error) {
      // 检查途中页面刷新了，等下一次加载完成
      console.log(`[smoke] 检查被打断（${(error as Error).message}），等页面重新加载`)
      return
    }
    if (finished) return
    if (!result.appMounted) {
      console.log(`[smoke] 应用还没挂载，等页面刷新：${JSON.stringify(result.failedRequests ?? [])}`)
      reloadTimer = setTimeout(() => finish(report(result)), RELOAD_WAIT_MS)
      return
    }
    finish(report(result))
  })
}
