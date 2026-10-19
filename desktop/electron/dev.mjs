/**
 * 桌面版开发环境（npm run desktop:dev）：编译主进程和 preload，启动 Vite 开发服务器（desktop 模式），再启动 Electron。
 * Electron 退出时关闭开发服务器。页面代码由 Vite 热更新；改了 desktop/electron 里的代码要重新运行。
 *
 * --smoke（npm run desktop:smoke）：页面加载后检查 window.arkrecord、后端和登录窗口，然后退出，退出码 0 表示通过。
 * --fake-hg（npm run desktop:dev -- --fake-hg）：应用内登录用本机的假登录页（fake-hg.mjs），不连接鹰角。冒烟测试总是用假登录页。
 * --shots <目录>（和 --smoke 一起用）：冒烟测试时把主窗口、登录弹窗、登录窗口截图存到这个目录，看界面效果用。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { createServer } from 'vite'
import { startFakeHg } from './fake-hg.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const smoke = process.argv.includes('--smoke')
const fakeHg = smoke || process.argv.includes('--fake-hg') ? await startFakeHg() : undefined

const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'desktop/electron'], { cwd: root, stdio: 'inherit' })
if (tsc.status !== 0) process.exit(tsc.status ?? 1)

const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), mode: 'desktop', clearScreen: false })
await server.listen()
const url = server.resolvedUrls?.local[0]
if (!url) {
  console.error('Vite 开发服务器没有本机地址')
  await server.close()
  process.exit(1)
}
server.printUrls()

const env = { ...process.env, ARKRECORD_DEV_SERVER_URL: url }
// 从其他 Electron 应用（编辑器、终端）里启动时可能带着这个变量，会让 Electron 以 Node 方式运行
delete env.ELECTRON_RUN_AS_NODE
if (smoke) env.ARKRECORD_SMOKE = '1'
const shotsIndex = process.argv.indexOf('--shots')
if (smoke && shotsIndex !== -1 && process.argv[shotsIndex + 1]) env.ARKRECORD_SMOKE_SHOTS = resolve(process.argv[shotsIndex + 1])
if (fakeHg) {
  env.ARKRECORD_FAKE_HG_ORIGIN = fakeHg.origin
  // 冒烟测试拿它核对登录窗口交回来的 token
  if (smoke) env.ARKRECORD_FAKE_HG_TOKEN = fakeHg.token
  console.log(`  ➜  假登录页: ${fakeHg.origin}/login`)
}

const electron = spawn(electronPath, ['.'], { cwd: root, env, stdio: 'inherit' })
electron.on('exit', async (code, signal) => {
  await Promise.all([server.close(), fakeHg?.close()])
  process.exit(signal ? 1 : (code ?? 0))
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => electron.kill())
