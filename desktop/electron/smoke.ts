/**
 * 冒烟测试（npm run desktop:smoke）：页面加载后在页面里调用 window.arkrecord，
 * 检查 ping、方法白名单、页面拿不到 Node，结果写到终端，然后退出（退出码 0 表示通过）。
 */
import type { BrowserWindow } from 'electron'

const TIMEOUT_MS = 180_000

/** 在页面里执行（和页面自己的代码一样，只能用 window.arkrecord） */
const PROBE = `(async () => {
  const bridge = window.arkrecord
  const out = {
    bridge: typeof bridge,
    platform: bridge && bridge.platform,
    nodeInPage: typeof require !== 'undefined' || typeof process !== 'undefined',
    appMounted: document.querySelector('#app') !== null && document.querySelector('#app .boot') === null,
  }
  try { out.ping = await bridge.rpc('ping') } catch (error) { out.pingError = error }
  try { await bridge.rpc('fs.readFile', ['C:/secret']); out.blocked = null } catch (error) { out.blocked = error }
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
  ping?: { pong?: boolean; protocol?: number }
  pingError?: unknown
  blocked?: { code?: number } | null
  /** 只有 app:// 协议（正式构建）才检查 */
  files?: { csp: boolean; spaFallback: string | null; missingAsset: number | string; traversal: number | string; traversalBackslash: number | string }
}

export function runSmokeTest(win: BrowserWindow, done: (ok: boolean) => void): void {
  const timer = setTimeout(() => {
    console.error('[smoke] 超时')
    done(false)
  }, TIMEOUT_MS)
  const finish = (ok: boolean) => {
    clearTimeout(timer)
    done(ok)
  }

  win.webContents.once('did-fail-load', (_event, code, description) => {
    console.error(`[smoke] 页面加载失败：${code} ${description}`)
    finish(false)
  })
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = (await win.webContents.executeJavaScript(PROBE)) as ProbeResult
      const checks: Record<string, boolean> = {
        '页面有 window.arkrecord': result.bridge === 'object',
        'platform 正确': result.platform === process.platform,
        '页面里没有 require / process': !result.nodeInPage,
        '应用已挂载': result.appMounted,
        'ping 成功、协议版本 1': result.ping?.pong === true && result.ping.protocol === 1,
        '白名单以外的方法被拒绝（-32601）': result.blocked?.code === -32601,
      }
      if (result.files) {
        checks['app:// 响应带 CSP'] = result.files.csp
        checks['app:// 页面地址回退到 index.html'] = result.files.spaFallback?.startsWith('text/html') === true
        checks['app:// 不存在的文件返回 404'] = result.files.missingAsset === 404
        checks['app:// 读不到产物目录以外的文件'] = result.files.traversal === 404 && result.files.traversalBackslash === 404
      }
      console.log(`[smoke] ${JSON.stringify(result)}`)
      for (const [name, ok] of Object.entries(checks)) console.log(`[smoke] ${ok ? '通过' : '失败'}：${name}`)
      finish(Object.values(checks).every(Boolean))
    } catch (error) {
      console.error(`[smoke] 执行失败：${(error as Error).message}`)
      finish(false)
    }
  })
}
