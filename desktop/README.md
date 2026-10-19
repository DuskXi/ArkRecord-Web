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
| `npm run desktop:smoke` | 冒烟测试：检查 `window.arkrecord`、页面里没有 Node、ping、白名单以外的方法被拒绝，跑完自动退出，退出码 0 表示通过 |
| `npm run desktop:build` | 游戏数据 + `vite build --mode desktop`（输出到 `desktop/electron/dist/renderer`）+ 编译主进程 |
| `npm run desktop:start` | 运行构建好的版本（页面从 `app://arkrecord/` 加载） |

- 需要 Node 22.12 以上、uv。Electron 版本写死在 `package.json`（目前 44.9.0）。
- 第一次 `npm install` 之后如果没有 Electron 本体，运行 `node node_modules/electron/install.js`。网页版的 CI 和部署设置了 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，不下载。
- desktop 模式不加载 `cloudflare()` 和给搜索引擎的文件；默认的网页版构建不受影响（产物逐字节相同）。
- 桌面版没有 Worker：页面里调用 `/api/*` 的功能（同步、统计、云同步）要等 M1、M5 接入后端后才能用。

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

### `hg.request`

- `upstream`、`path`：和网页版请求 `/api/hg/{upstream}{path}` 相同，必须在 [`shared/upstreams/hg.json`](../shared/upstreams/hg.json) 的白名单里（路径精确匹配）。
- `envelope`：字符串，和网页版发给 Worker 的请求体完全相同（`{query?, body?, roleToken?, akCookie?}`，见 `worker/proxy.ts` 的 `ProxyEnvelope`），校验规则和大小上限也相同。
- 结果：`status` 是上游的状态码；`headers` 只有 `content-type`、`x-ak-user-center`（明日方舟登录下发的 Cookie）、`x-arkrecord-proxy`（转发层自己的错误，和 Worker 相同：`route_not_allowed`、`bad_request`、`body_too_large`、`upstream_unreachable`）；`body` 是响应内容（字符串）。前端用 `new Response(body, { status, headers })` 还原，`src/lib/hg/client.ts` 的解析不用改。
- 不跟随重定向，20 秒超时。请求头带 `user-agent: ArkRecord-Desktop/<版本>`，如实标明是桌面版。
- 日志只记上游名、路径、状态码和耗时，不记查询参数、请求体和响应内容。
- 参数格式不对（不是这三个字符串）时返回 JSON-RPC 错误 -32602；其余情况都按上表返回结果，和网页版的处理路径一致。

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
- 只放行白名单里的方法（`desktop/electron/main.ts` 的 `ALLOWED_METHODS`，目前只有 `ping`）；
- 再把请求交给后端。普通请求 30 秒超时；启动时的 ping 120 秒（uv 第一次运行要建虚拟环境）。后端退出后，下一次请求会重新启动它。

`rpc()` 失败时 reject 的是**普通对象** `{ code, message, data? }`，不是 `Error`，这样 `code` 和 `data` 经过 contextBridge 后还在（类型 `RpcErrorObject`，判断用 `isRpcErrorObject`，都在 `src/lib/transport.ts`）。除了后端返回的错误，主进程自己会产生：

| code | 含义 |
|---|---|
| -32601 | 不允许调用这个方法（不在白名单里） |
| -32602 | 参数不是对象或数组，或者不能转成 JSON |
| -32603 | 主进程内部错误 |
| -32000 | `data.kind` = `backend_unavailable`（没装 uv、后端启动失败或已退出）或 `timeout`（超时） |

## Electron 的安全设置

- 渲染进程：`contextIsolation`、`sandbox`（`app.enableSandbox()` 对所有页面生效），不开 Node，不允许 `<webview>`。
- 正式构建从 `app://arkrecord/` 加载：协议注册成 standard + secure，页面来源固定，升级后 IndexedDB 里的数据还在。读文件时防路径穿越；没有扩展名的地址回退到 `index.html`（前端路由）；响应带 CSP（网页版的 CSP 去掉 Cloudflare 统计）和 `nosniff`。
- 开发服务器地址只接受本机（`localhost`、`127.0.0.1`、`[::1]`），只在没打包时读取。
- 不开新窗口；跳转到应用以外的地址一律拦下。`https:` 链接（关于页、GitHub 等）交给系统浏览器打开，其他协议直接忽略。
- 权限只放行 `clipboard-sanitized-write` 和 `persistent-storage`，其余一律拒绝。
- 开发版和安装版的数据目录分开（`ArkRecord Dev` / `ArkRecord`）。
- 还没做（M4）：Electron fuses、正式菜单、打包。

## 安全规则

- 凭据（鹰角 token、抽卡链接里的 authkey 等）不写日志、不写文件、不出现在报错信息里；测试只用合成的假值。
- 只读游戏文件，不修改。
- 详见 [../CLAUDE.md](../CLAUDE.md) 和计划里的“凭据和隐私”。
