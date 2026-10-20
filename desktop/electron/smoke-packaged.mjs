/**
 * 打包版冒烟测试（npm run desktop:smoke:packaged）：启动 electron-builder 打好的应用（desktop/release 里没打成安装包的那个目录，
 * 内容和安装包一样），跑和开发版一样的冒烟测试（main.ts 的 ARKRECORD_SMOKE），退出码 0 表示通过。
 *
 * - 每次用一个新的临时数据目录，跑完删掉；不碰安装版自己的数据。
 * - 安装版不读假登录页、假云同步的地址，所以不检查登录窗口和云同步转发；云同步不转发（不连网站），统计不上报。
 * - 测的是打好的后端（resources/backend）、白名单文件（resources/shared）、app:// 协议和 asar 里的页面。
 * - Linux 的 CI 上 chrome-sandbox 没有 setuid 权限，Electron 起不来，所以在 Linux 上加 --no-sandbox（只在冒烟测试里）。
 *
 * 用法：npm run desktop:smoke:packaged [-- --shots <目录>]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const release = join(root, 'desktop', 'release')
const TIMEOUT_MS = 240_000

/** 各平台 electron-builder 输出的、没打成安装包的应用 */
const CANDIDATES = {
  win32: [join(release, 'win-unpacked', 'ArkRecord.exe')],
  darwin: ['mac-arm64', 'mac', 'mac-universal'].map((dir) => join(release, dir, 'ArkRecord.app', 'Contents', 'MacOS', 'ArkRecord')),
  linux: [join(release, 'linux-unpacked', 'arkrecord'), join(release, 'linux-arm64-unpacked', 'arkrecord')],
}

const executable = (CANDIDATES[process.platform] ?? []).find((file) => existsSync(file))
if (!executable) {
  console.error(`[smoke:packaged] 在 ${release} 里找不到打好的应用，先运行 npm run desktop:package`)
  process.exit(1)
}

const dataDir = await mkdtemp(join(tmpdir(), 'arkrecord-smoke-packaged-'))
const env = { ...process.env, ARKRECORD_SMOKE: '1', ARKRECORD_SMOKE_DATA_DIR: dataDir }
// 从其他 Electron 应用（编辑器、终端）里启动时可能带着这个变量，会让 Electron 以 Node 方式运行
delete env.ELECTRON_RUN_AS_NODE
for (const name of ['ARKRECORD_DEV_SERVER_URL', 'ARKRECORD_FAKE_HG_ORIGIN', 'ARKRECORD_FAKE_HG_TOKEN', 'ARKRECORD_FAKE_CLOUD_ORIGIN']) delete env[name]
const shotsIndex = process.argv.indexOf('--shots')
if (shotsIndex !== -1 && process.argv[shotsIndex + 1]) env.ARKRECORD_SMOKE_SHOTS = resolve(process.argv[shotsIndex + 1])

const args = process.platform === 'linux' ? ['--no-sandbox'] : []
console.log(`[smoke:packaged] 启动 ${executable}`)
const child = spawn(executable, args, { env, stdio: 'inherit' })
const timer = setTimeout(() => {
  console.error('[smoke:packaged] 超时，结束应用')
  child.kill()
}, TIMEOUT_MS)

child.on('exit', async (code, signal) => {
  clearTimeout(timer)
  // Windows 上应用刚退出时文件可能还被占着，多试几次
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
  console.log(`[smoke:packaged] 应用退出（${signal ?? `退出码 ${code}`}）`)
  process.exit(signal ? 1 : (code ?? 1))
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill())
