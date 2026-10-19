# ArkRecord 桌面版

开发计划见 [../docs/desktop/plan.md](../docs/desktop/plan.md)。这里记录各部分之间的接口约定。

```
desktop/
  electron/   Electron 主进程、preload、开发启动脚本
  backend/    Python 后端（uv 管理）
```

## 常用命令（仓库根目录）

| 命令 | 做什么 |
|---|---|
| `npm run desktop:dev` | 编译主进程和 preload → 启动 Vite（desktop 模式）→ 启动 Electron → 主进程拉起后端并 ping。页面代码热更新；改了 `desktop/electron` 要重新运行 |
| `npm run desktop:smoke` | 冒烟测试：检查 `window.arkrecord`、页面里没有 Node、ping、白名单以外的方法被拒绝、`hg.request` 拒绝白名单以外的路径、应用内登录窗口（用本机的假登录页），不发出真实请求，跑完自动退出，退出码 0 表示通过。加 `-- --shots <目录>` 会把主窗口、登录弹窗、登录窗口截图存到这个目录。每次用一个新的临时数据目录（第一次打开的状态，跑完删掉），不碰开发版的数据，开发版开着也能跑 |
| `npm run desktop:build` | 游戏数据 + `vite build --mode desktop`（输出到 `desktop/electron/dist/renderer`）+ 编译主进程 |
| `npm run desktop:start` | 运行构建好的版本（页面从 `app://arkrecord/` 加载） |

- 需要 Node 22.12 以上、uv。Electron 版本写死在 `package.json`（目前 44.9.0）。
- 第一次 `npm install` 之后如果没有 Electron 本体，运行 `node node_modules/electron/install.js`。网页版的 CI 和部署设置了 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，不下载。
- desktop 模式不加载 `cloudflare()` 和给搜索引擎的文件；默认的网页版构建不受影响（产物逐字节相同）。
- 桌面版没有 Worker：鹰角的请求经 `src/lib/transport.ts` 的 `postHg` 交给后端的 `hg.request`，由本机直连鹰角；其他调用 `/api/*` 的功能（统计、反馈、云同步）要等 M5。
- 开发时主进程每次启动会清掉 HTTP 缓存：Vite 给依赖的地址带版本号并让浏览器长期缓存，上次运行留下的缓存会让依赖版本对不上（504，页面空白）。
- `npm run desktop:dev -- --fake-hg`：应用内登录用本机的假登录页（`desktop/electron/fake-hg.mjs`），不连接鹰角。假登录页的地址只在没打包时读取，`fake-hg.mjs` 不编译进 `dist`。

## Python 后端

```sh
cd desktop/backend
uv sync              # 安装依赖（Python 3.12 以上，uv 会自动选）
uv run pytest        # 测试
uv run ruff check .  # Lint
uv run ruff format . # 格式化
```

主进程在仓库根目录用这条命令启动后端（开发时）：

```sh
uv run --project desktop/backend python -m arkrecord_backend
```

手动测试时输入一行 `{"jsonrpc":"2.0","id":1,"method":"ping"}`，应该回一行 pong；输入结束（Ctrl+D，Windows 上 Ctrl+Z 回车）后退出。行首的 BOM 会被忽略（Windows PowerShell 5.1 用管道传入时会加）。

打包后怎么带上 Python，在 M4 里定。

## 主进程和后端之间的协议

- stdin / stdout，一行一个 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 消息，UTF-8，以 `\n` 分隔（后端也接受 `\r\n` 和行首的 BOM）。
- stdout 只输出协议消息；日志写到 stderr，已经脱敏（`redact.py`），主进程可以原样写进日志文件。
- 不支持批量请求。通知（没有 `id`）不回复。
- stdin 关闭时后端退出，退出码 0。
- 请求交给线程池并发处理（最多 4 个），耗时的网络请求不会挡住 ping；回复顺序可能和请求不同，按 `id` 对应。stdin 关闭后，等已收到的请求处理完再退出。

### 方法

| 方法 | 参数 | 结果 | 说明 |
|---|---|---|---|
| `ping` | 无 | `{"pong": true, "protocol": 1, "backend": "0.1.0", "python": "3.12.x"}` | 启动后先调用一次，确认后端可用、协议版本一致 |
| `hg.request` | `{upstream, path, envelope}` | `{status, headers, body}` | 执行鹰角请求信封，代替网页版的 Worker 转发（见下） |
| `mhy.locate` | `{game}` | `{logs, searched, dataDirs}` | 读游戏日志找游戏数据目录（不读缓存、不发请求） |
| `mhy.cacheStamp` | `{game, dataDir?}` | `{mtime}` | 最新的 `data_2` 修改时间，“等待读取”时轮询 |
| `mhy.readCache` | `{game, dataDir?}` | `{handle, game, gameBiz, region, uid, source}` | 从缓存里找抽卡链接、校验，返回句柄 |
| `mhy.useLink` | `{url}` | 同上 | 校验用户粘贴的抽卡链接，返回句柄 |
| `mhy.fetchPage` | `{handle, gachaType, endId?, size?}` | `{list, region, regionTimeZone}` | 拉一页记录（从新到旧，`size` 最大 20） |
| `mhy.forget` | `{handle}` | `{ok}` | 丢掉这个链接 |

### `hg.request`

- `upstream`、`path`：和网页版请求 `/api/hg/{upstream}{path}` 相同，必须在 [`shared/upstreams/hg.json`](../shared/upstreams/hg.json) 的白名单里（路径精确匹配）。
- `envelope`：字符串，和网页版发给 Worker 的请求体完全相同（`{query?, body?, roleToken?, akCookie?}`，见 `worker/proxy.ts` 的 `ProxyEnvelope`），校验规则和大小上限也相同。
- 结果：`status` 是上游的状态码；`headers` 只有 `content-type`、`x-ak-user-center`（明日方舟登录下发的 Cookie）、`x-arkrecord-proxy`（转发层自己的错误，和 Worker 相同：`route_not_allowed`、`bad_request`、`body_too_large`、`upstream_unreachable`）；`body` 是响应内容（字符串）。前端用 `new Response(body, { status, headers })` 还原，`src/lib/hg/client.ts` 的解析不用改。
- 不跟随重定向，20 秒超时。请求头带 `user-agent: ArkRecord-Desktop/<版本>`，如实标明是桌面版。
- 日志只记上游名、路径、状态码和耗时，不记查询参数、请求体和响应内容。
- 参数格式不对（不是这三个字符串）时返回 JSON-RPC 错误 -32602；其余情况都按上表返回结果，和网页版的处理路径一致。

### 米哈游（`mhy.*`）

- `game` 是 `genshin` 或 `starrail`；`dataDir` 是用户手动选的目录（游戏安装目录、游戏数据目录或 `webCaches` 都行），不传就读日志自动找（只在 Windows 上）。
- 抽卡链接（含 authkey）只留在后端内存里，页面拿到的是随机句柄（最多保留 8 个，后端重启后失效）。
- 请求由本机直连米哈游官方接口，只发 [`shared/upstreams/mhy.json`](../shared/upstreams/mhy.json) 白名单里的抽卡记录接口；两次请求至少间隔 0.5 秒；日志不记地址。
- `gachaType`：原神 100、200、301（会同时返回 400）、302、500；星铁 1、2、11、12、21、22（21、22 走联动池接口）。
- 业务错误（-32000）的 `data.kind`：`game_not_found`、`no_link`（先在游戏里打开抽卡记录）、`link_expired`、`link_invalid`、`bad_link`、`handle_expired`、`rate_limited`（-110，稍后重试）、`network`、`upstream_error`、`unsupported`。
- 本机只读检查（不输出参数值、不发请求）：`uv run --project desktop/backend python -m arkrecord_backend.mhy.inspect genshin`。

### 错误

| code | 含义 |
|---|---|
| -32700 | 不是合法 JSON |
| -32600 | 不是合法的 JSON-RPC 请求 |
| -32601 | 没有这个方法 |
| -32602 | 参数不对 |
| -32603 | 后端内部错误（详情只在 stderr 日志里） |
| -32000 | 业务错误，`error.data.kind` 说明类型；`error.message` 可以直接显示给用户，不含凭据 |

## 渲染进程能用的接口

preload 用 `contextBridge.exposeInMainWorld('arkrecord', …)` 暴露（类型见 `src/lib/transport.ts`）：

```ts
interface ArkrecordBridge {
  rpc(method: string, params?: unknown): Promise<unknown>
  readonly platform: 'win32' | 'darwin' | 'linux'
}
```

主进程收到 `arkrecord:rpc` 时：

- 只接受主窗口顶层页面、地址是应用自己的请求，其他的直接拒绝；
- `app.` 开头的方法由主进程自己处理，不转给后端（见下面的“应用内鹰角登录”）；
- 其他方法只放行白名单里的（`desktop/electron/main.ts` 的 `ALLOWED_METHODS`：`ping`、`hg.request`、`stats.status`、`stats.setEnabled`、`stats.report`），再交给后端。超时：`ping` 30 秒，`hg.request` 45 秒（后端对上游 20 秒超时，留出余量），启动时的 ping 120 秒（uv 第一次运行要建虚拟环境）。后端退出后，下一次请求会重新启动它。

### 应用内鹰角登录（`app.hgLogin`）

设计见 [../docs/desktop/plan.md](../docs/desktop/plan.md) 的“应用内鹰角登录窗口”，代码在 `desktop/electron/hg-login.ts`（规则在 `hg-login-rules.ts`）。

| 方法 | 结果 | 说明 |
|---|---|---|
| `app.hgLogin` | `{ token }` | 打开登录窗口，用户登录后返回账号 token（和 `account/info/hg` 的 `data.content` 相同）。用户关窗口：-32000 + `cancelled`；打不开登录页、超时（10 分钟）、多次读不到登录状态：-32000 + `login_failed`。同一时间只有一个登录窗口，再次调用时把它切到前面，拿到同一个结果 |
| `app.hgLoginCheck` | `{ checking }` | 用户点“我已登录”：马上查一次登录状态；没有打开的登录窗口时 `checking` 是 `false` |
| `app.setTitleBar` | `{}` | 参数 `{ color, symbolColor }`（`#rrggbb`）：设置右上角窗口按钮的背景色和图标色，由 `DesktopTitleBar.vue` 按深浅色调用；macOS 上不做什么 |

- 每次登录用新的内存分区 `hg-login-<随机>`，结束时清掉它的全部存储、缓存和认证缓存，再销毁窗口；不调用鹰角的退出接口。
- 登录窗口：沙盒、上下文隔离、不开 Node、**没有 preload**、不允许 `<webview>`、安装版关掉开发者工具；标题显示当前域名。权限请求和下载一律拒绝，证书错误不放行（保持默认）。
- 顶层页面只允许 `https://*.hypergryph.com`，子框架另外放行 `*.geetest.com`；其他链接交给系统浏览器，`window.open` 一律拒绝。主进程的全局跳转规则跳过登录窗口。
- 开发版（没打包）里，被拦下的跳转在终端输出一行 `[hg-login] 拦下：顶层页面 / 子框架 / 新窗口 <域名>`，只有域名，不记端口、路径、参数和 fragment；真机测试时用来确认白名单够不够。安装包里不输出。
- 取 token：在登录会话里请求 `https://web-api.hypergryph.com/account/info/hg`，时机是每次跳转后防抖 1 秒，或 `app.hgLoginCheck`；每个窗口最多 20 次。token 只作为这次 `rpc` 的返回值交给页面，不写日志、主进程不保存。

页面里鹰角的请求不用直接调 `rpc`：`postHg` 在桌面版里调用 `hg.request`，把结果还原成 `Response`（只保留上面三个响应头，`204` 等状态不带正文）；`rpc()` 失败或结果格式不对时抛 `TransportError`（继承 `TypeError`），`client.ts` 当作网络错误处理，和网页版 `fetch` 失败一样。

`rpc()` 失败时 reject 的是**普通对象** `{ code, message, data? }`，不是 `Error`，这样 `code` 和 `data` 经过 contextBridge 后还在（类型 `RpcErrorObject`，判断用 `isRpcErrorObject`，都在 `src/lib/transport.ts`）。除了后端返回的错误，主进程自己会产生：

| code | 含义 |
|---|---|
| -32601 | 不允许调用这个方法（不在白名单里） |
| -32602 | 参数不是对象或数组，或者不能转成 JSON |
| -32603 | 主进程内部错误 |
| -32000 | `data.kind` = `backend_unavailable`（没装 uv、后端启动失败或已退出）、`timeout`（超时）；`app.hgLogin` 还有 `cancelled`、`login_failed` |

## 图片（`img.fetch`）

维护者的决定：桌面版的图片由本机 Python 拉取，不经过 Worker。页面里的地址照旧是 `/api/img/<来源>/<路径>`（`src/lib/meta.ts`），由主进程转给后端：

| 方法 | 参数 | 结果 |
|---|---|---|
| `img.fetch` | `{source, target}` | `{status, contentType?, body?}`：`status` 200 时 `body` 是图片的 base64；404 是不在白名单里或来源站没有；502 是来源站出错或返回的不是图片 |

- 白名单是 [`shared/images.json`](../shared/images.json)，和 Worker（`worker/images.ts`）同一份；路径必须完整匹配，不跟随重定向，只接受 `image/*`、不超过 5 MB。
- 缓存在 `ARKRECORD_DATA_DIR/image-cache`：成功的 30 天，来源站 404 的 1 小时。
- 主进程这一侧：
  - 正式构建：`app://arkrecord/api/img/<来源>/<路径>` 由 `protocol.handle('app')` 交给 `img.fetch`，和页面同源，导出分享图时 canvas 不会因为跨域图片出错；
  - 开发时：页面在 Vite 开发服务器上，`/api/img/*` 也要转给 `img.fetch`（不要转到 Worker）；
  - 返回时带上 `content-type`、`x-content-type-options: nosniff`；地址里带查询参数的一律 404（和 Worker 一样）；`img.fetch` 加进主进程能调用的方法里，但**不要**放进页面能直接调用的白名单。
- 实现：`desktop/electron/images.ts`（`serveImage`，不依赖 Electron，有单元测试）。解析和 Worker 一样：第一段是来源，其余原样是路径，不解码；带查询参数、格式不对、不是 GET / HEAD 的直接 404 / 405，不交给后端。后端返回 404 / 502 时原样返回、不带正文；后端出错或结果不对时返回 502。
  - 正式构建：`main.ts` 的 `serveAppFile` 遇到 `/api/img/` 时交给 `serveImage`。
  - 开发模式：只在应用的默认会话里拦截 `http`，开发服务器地址下的 `/api/img/` 交给 `serveImage`，其余请求用 `net.fetch(request, { bypassCustomProtocolHandlers: true })` 原样交给 Vite；登录窗口用单独的会话，不受影响。
  - 冒烟测试只用白名单以外的来源名（不会真的去拉图片）：检查返回 404、交给了后端一次、临时数据目录的 `image-cache` 是空的（真的向来源站发过请求就会有缓存）；带查询参数时返回 404、不交给后端。

## 使用人数统计（`stats.*`）

维护者的决定：桌面版不弹 Cookie 同意，统计交给 Python 后端，默认开启、“关于”页可关闭；统计没登录的设备、加盐的 UID、设备，UID 和设备互不关联。上报什么、服务器保存什么见 [SECURITY.md](../SECURITY.md) 的“桌面版的使用人数统计”。

| 方法 | 参数 | 结果 | 说明 |
|---|---|---|---|
| `stats.status` | 无 | `{enabled, available}` | `available` 为 false 时（没设置上报地址或数据目录）不会上报 |
| `stats.setEnabled` | `{enabled}` | `{enabled}` | 关闭后不再发出任何统计请求，已经排好的也不发 |
| `stats.report` | `{accounts: [{game, uid}]}` | `{scheduled}` | 页面在账号列表变化时调用（`src/lib/desktop-stats.ts`）；后端每天去重，设备马上报，每个账号在 30 到 300 秒后单独、乱序上报 |

主进程启动后端时要传两个环境变量：

- `ARKRECORD_DATA_DIR`：应用数据目录（`app.getPath('userData')`），后端在这里存 `stats.json`（开关、随机设备 ID、今天报过什么）。
- `ARKRECORD_STATS_URL`：安装版 `https://ark.kaltsit.dev`，开发版 `https://ark-next.kaltsit.dev`。后端只接受这两个地址，没设置时不上报。
- 主进程这一侧在 `desktop/electron/main.ts`（`STATS_URL`，经 `backend.ts` 的 `env` 传给后端）。**冒烟测试不设上报地址**，继承来的环境变量里有也会删掉，测试数据不算进统计；数据目录是冒烟测试的临时目录。冒烟测试检查页面上没有同意弹窗、`stats.status` 的 `available` 为 false。

## 鹰角 token 的保存（主进程，`app.tokens.*`）

维护者的要求：要记住，但只能用系统钥匙串加密；没有钥匙串就不记住。页面这一侧在 `src/lib/token-vault.ts`（账号表的钩子，token 不进 IndexedDB），主进程这一侧的约定：

| 方法 | 参数 | 结果 | 说明 |
|---|---|---|---|
| `app.tokens.status` | 无 | `{available, backend}` | `available` 为 true 才保存。Linux 上 `safeStorage.getSelectedStorageBackend()` 是 `basic_text` / `unknown`，或者 `isEncryptionAvailable()` 为 false 时，一律 false |
| `app.tokens.load` | 无 | `{tokens: {[accountId]: token}}` | 启动时读一次；解不开的条目（钥匙串变了）直接丢掉 |
| `app.tokens.save` | `{accountId, token}` | `{ok}` | `safeStorage.encryptString` 后存到应用数据目录的 `hg-tokens.json`（base64 密文，先写临时文件再改名）。不可用时返回 -32000 + `keychain_unavailable` |
| `app.tokens.delete` | `{accountId}` | `{ok}` | |

- `app.` 开头的方法由主进程自己处理，不转给后端；同样只接受应用自己页面的请求。
- `accountId` 形如 `arknights:<uid>` / `endfield:<uid>`；token 只能是可见 ASCII、长度有上限。
- token 和密文都不写日志。
- 实现：`desktop/electron/keychain.ts`（safeStorage、四个方法）和 `token-store.ts`（文件格式、校验、读写按顺序排队，不依赖 Electron，有单元测试）。`backend` 在 Windows 上是 `dpapi`，macOS 是 `keychain`，Linux 是 safeStorage 选中的后端。一条都不剩时删掉 `hg-tokens.json`。钥匙串不可用时 `load` 返回空、`delete` 照常删文件里的条目。
- 冒烟测试用假账号 `arknights:arkrecord-smoke-test` 和随机的假 token 走一遍 save → load → delete，并检查文件里只有密文、结束后没有残留。

## Electron 的安全设置

- 渲染进程：`contextIsolation`、`sandbox`（`app.enableSandbox()` 对所有页面生效），不开 Node，不允许 `<webview>`。
- 正式构建从 `app://arkrecord/` 加载：协议注册成 standard + secure，页面来源固定，升级后 IndexedDB 里的数据还在。读文件时防路径穿越；没有扩展名的地址回退到 `index.html`（前端路由）；响应带 CSP（网页版的 CSP 去掉 Cloudflare 统计）和 `nosniff`。
- 开发服务器地址只接受本机（`localhost`、`127.0.0.1`、`[::1]`），只在没打包时读取。
- 不开新窗口；跳转到应用以外的地址一律拦下。`https:` 链接（关于页、GitHub 等）交给系统浏览器打开，其他协议直接忽略。
- 权限只放行 `clipboard-sanitized-write` 和 `persistent-storage`，其余一律拒绝。
- 开发版和安装版的数据目录分开（`ArkRecord Dev` / `ArkRecord`）。
- 主窗口不用系统标题栏：页面顶部是 40px 的自定义标题栏（`src/components/shell/DesktopTitleBar.vue`，和侧边栏同色，用来拖动窗口），页面整体往下让出这一条，通知也放到它下面。Windows / Linux 的最小化、最大化、关闭按钮由 Electron 画在右上角（`titleBarOverlay`，高 39px，不盖住底下的分隔线），颜色由页面按深浅色设置；macOS 的红绿灯在左上角。Windows / Linux 没有菜单栏，开发时按 F12 打开开发者工具。挂在 `body` 下的弹窗、菜单、通知设成不可拖动，盖到标题栏上时也能点到。登录窗口保留系统标题栏（标题里显示当前域名）。
- 还没做（M4）：Electron fuses、正式菜单、打包。

## 安全规则

- 凭据（鹰角 token、抽卡链接里的 authkey 等）不写日志、不写文件、不出现在报错信息里；测试只用合成的假值。
- 只读游戏文件，不修改。
- 详见 [../CLAUDE.md](../CLAUDE.md) 和计划里的“凭据和隐私”。
