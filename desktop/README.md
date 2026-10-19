# ArkRecord 桌面版

开发计划见 [../docs/desktop/plan.md](../docs/desktop/plan.md)。这里记录各部分之间的接口约定。

```
desktop/
  electron/   Electron 主进程、preload（开发中）
  backend/    Python 后端（uv 管理）
```

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

打包后怎么带上 Python，在 M4 里定。

## 主进程和后端之间的协议

- stdin / stdout，一行一个 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 消息，UTF-8，以 `\n` 分隔（后端也接受 `\r\n`）。
- stdout 只输出协议消息；日志写到 stderr，已经脱敏（`redact.py`），主进程可以原样写进日志文件。
- 不支持批量请求。通知（没有 `id`）不回复。
- stdin 关闭时后端退出，退出码 0。
- 目前按顺序处理请求。M1 加入耗时的网络请求时再改成并发。

### 方法

| 方法 | 参数 | 结果 | 说明 |
|---|---|---|---|
| `ping` | 无 | `{"pong": true, "protocol": 1, "backend": "0.1.0", "python": "3.12.x"}` | 启动后先调用一次，确认后端可用、协议版本一致 |

M1 会加 `hg.request`（按 `shared/upstreams/hg.json` 的白名单执行鹰角请求信封）。

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

- 只放行白名单里的方法；
- 只接受应用自己页面的请求；
- 再把请求交给后端。

## 安全规则

- 凭据（鹰角 token、抽卡链接里的 authkey 等）不写日志、不写文件、不出现在报错信息里；测试只用合成的假值。
- 只读游戏文件，不修改。
- 详见 [../CLAUDE.md](../CLAUDE.md) 和计划里的“凭据和隐私”。
