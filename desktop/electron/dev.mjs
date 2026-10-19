/**
 * 桌面版开发环境（npm run desktop:dev）：编译主进程和 preload，启动 Vite 开发服务器（desktop 模式），再启动 Electron。
 * Electron 退出时关闭开发服务器。页面代码由 Vite 热更新；改了 desktop/electron 里的代码要重新运行。
 *
 * --smoke（npm run desktop:smoke）：页面加载后检查 window.arkrecord 和后端 ping，然后退出，退出码 0 表示通过。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const smoke = process.argv.includes('--smoke')

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

const electron = spawn(electronPath, ['.'], { cwd: root, env, stdio: 'inherit' })
electron.on('exit', async (code, signal) => {
  await server.close()
  process.exit(signal ? 1 : (code ?? 0))
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => electron.kill())
