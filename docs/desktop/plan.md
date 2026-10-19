# 桌面版开发计划（2026-10-19）

在本地开发、调试（需要扫码登录和读本机游戏文件，云端容器做不了）。调研背景见 [../research/multi-game-and-desktop.md](../research/multi-game-and-desktop.md) 和 [../research/notes/](../research/notes/)。

## 已经定下的

- **同一个仓库**，不另开仓库。
- **Electron 做界面，Python 做后端**（维护者的决定）。平台：Windows、Linux（RHEL 系、Ubuntu 系）、macOS（x64、arm64）。
- **第一版就支持四款游戏**：明日方舟、明日方舟：终末地、原神、崩坏：星穹铁道。绝区零暂不做（维护者没有账号，无法测试）。
- **原神、星铁的取数方式**：默认读本机游戏缓存里的抽卡链接 + 粘贴链接 + UIGF 导入。米游社扫码登录是否提供、以什么形式提供，待维护者决定。
- **云同步分开**：鹰角两款继续用 ark.kaltsit.dev；米哈游的用单独的 `mhy.<域名>`（独立 Worker、独立 Durable Object、独立 `SYNC_PEPPER`）。
- **网页版 ark.kaltsit.dev 不变**：只有鹰角两款，产物里不能出现米哈游的代码。

## 架构

```
┌──────────── Electron ────────────┐
│ 渲染进程：现有 Vue 应用（desktop 构建） │
│   └ preload（contextBridge，最小接口） │
│ 主进程：窗口、鹰角登录窗口、子进程管理   │
└───────────────┬──────────────────┘
                │ stdio，一行一个 JSON-RPC 2.0 消息（不开本地端口）
┌───────────────┴──────────────────┐
│ Python 后端（子进程）                 │
│   鹰角：按白名单执行请求信封（代替 Worker）│
│   米哈游：扫码登录、genAuthKey、拉抽卡记录 │
│   本机游戏缓存里的抽卡链接、UIGF 导入导出  │
│   凭据：内存；“记住登录”时存系统钥匙串    │
└──────────────────────────────────┘
```

- **渲染进程**复用现有的页面、统计、合并规则和 IndexedDB 存储（Electron 里 IndexedDB 存在应用数据目录）。
- **请求层抽象**：新增 `src/lib/transport.ts`。网页版照旧发到 `/api/hg/*`（Worker）；桌面版调用 `window.arkrecord.request(...)`，经主进程交给 Python。`src/lib/hg/client.ts` 的请求信封格式不变。
- **白名单共用**：把 `worker/upstreams.ts` 里的上游和路由抽成 `shared/upstreams.json`（Worker 直接 import），Python 读同一份文件，只发白名单内的请求。米哈游的上游也写在这里（只放行扫码登录、取角色、genAuthKey、抽卡记录这几个接口，不放行流水等其他接口）。
- **构建目标**：`vite build`（网页，只有鹰角两款）和 `vite build --mode desktop`（四款）。游戏列表用构建常量控制；网页版的构建清单里检查不能出现米哈游的模块。

### 建议的目录

```
desktop/
  electron/            主进程、preload、鹰角登录窗口
  backend/             Python 包（pyproject.toml，用 uv 管理）
    arkrecord_backend/
      rpc.py           stdio JSON-RPC
      redact.py        日志脱敏
      secrets.py       系统钥匙串（keyring）
      hg.py            鹰角请求信封（按 shared/upstreams.json）
      mhy/
        auth.py        米游社扫码登录、取角色
        ds.py          DS 签名
        gacha.py       抽卡记录分页拉取
        cache.py       读本机游戏缓存里的抽卡链接（Windows）
        uigf.py        UIGF v4.2
    tests/             只用脱敏或合成的样本
  electron-builder.yml
src/lib/transport.ts
src/lib/mhy/           原神、星铁的类型、同步、合并、保底规则
shared/upstreams.json
```

## 登录方式

| 游戏 | 首选 | 备选 |
|---|---|---|
| 明日方舟、终末地 | 应用内打开鹰角官方登录页（独立会话），用户自己登录，主进程在这个会话里请求 `account/info/hg` 取 token，用完清掉会话 | 鹰角 App / 森空岛扫码（`gen_scan/login` 流程，见 docs/rewrite/research.md）；手动粘贴 |
| 原神、星铁 | 读本机游戏缓存里的抽卡链接（Windows，需先在游戏里打开过抽卡记录）；粘贴链接；UIGF 导入 | 米游社 App 扫码（`createQRLogin` → `queryQRLoginStatus` 得到 stoken）→ 取绑定角色 → `genAuthKey` 生成 authkey。**待定** |

- 不调试、不读取用户自己的浏览器（Chrome 136 起不允许，且行为和窃密木马一样）。
- 扫码登录只支持国服；国际服（HoYoLAB）先只支持粘贴链接和 UIGF 导入。
- 可以参考 MIT 许可的 [genshin.py](https://github.com/seriaati/genshin.py) 的接口实现（扫码、DS、抽卡记录），引用代码要保留许可声明。

## 凭据和隐私

- stoken、鹰角 token、authkey 默认只在 Python 进程内存里。用户勾选“记住登录”时存系统钥匙串（Windows 凭据管理器、macOS 钥匙串、Linux Secret Service），不写普通文件。
- 所有日志经过 `redact.py`：token、stoken、cookie、authkey、ticket 等字段的值一律替换成 `***`，有测试检查。
- 凭据不经过任何服务器（桌面版不需要 Worker 转发）。云同步只上传加密后的记录，和网页版一样不上传凭据。
- DS 签名需要的盐是从米游社 App 逆向得到的，会随版本变化。放在哪里、怎么更新，等决定是否提供扫码登录后再定。

## 数据（米哈游）

- `Game` 类型增加 `genshin`、`starrail`（以后 `zzz`）。
- 记录主键用接口返回的 `id`（19 位，必须当字符串处理）。原神的 `item_id` 基本是空的，要按名称映射；时间按区服时区解释（原神按 UID 推断，星铁读 `region_time_zone`）。
- 卡池：原神 `gacha_type` 100/200/301/400/302/500（301 会混入 400），星铁 1/2/11/12，联动池 21/22 走 `getLdGachaLog`。
- 保底规则在实现时按官方公示核对后写进 `src/lib/mhy/`（不要凭印象写）。
- 导入导出用 UIGF v4.2。

## 里程碑

1. **M0 骨架**：Electron + Python 子进程跑通（ping），一条命令启动开发环境；渲染进程加载现有应用（desktop 构建）。
2. **M1 鹰角两款**：`transport.ts` + `shared/upstreams.json` + Python 执行请求信封；应用内登录窗口取 token；明日方舟、终末地同步跑通，不经过 Worker。
3. **M2 原神**：米游社扫码 → stoken → 角色 → genAuthKey → 拉取抽卡记录；存储、统计页面。
4. **M3 星铁**；Windows 游戏缓存读链接；UIGF 导入导出。
5. **M4 打包**：三平台安装包，每个安装包签发构建证明（签名另议：macOS 需要 Apple 开发者年费，Windows 可申请 SignPath 开源免费签名）。
6. **M5 云同步**：鹰角走 ark.kaltsit.dev，米哈游走 `mhy.<域名>`。现在的 `/api/cloud` 只接受网页同源请求，桌面版要单独设计客户端校验，并经过安全评审、更新 SECURITY.md。

## 本地开发环境

- Node.js 22.12 以上（推荐 24）、Python 3.12 以上、[uv](https://docs.astral.sh/uv/)、Git。
- 手机上装米游社 App，一个国服账号；Windows 上装了原神 / 星铁的话可以测试读缓存。
- M0 完成后：`npm install`，`cd desktop/backend && uv sync`，再用 `npm run desktop:dev` 启动（命令在 M0 里定）。

## 调试规则（给本地会话）

- 维护者在本机自己扫码登录；AI 助手不读取、不打印凭据，调试只看状态码、条数、错误码。
- 不把真实的抽卡数据（含 UID、昵称）、截图提交进仓库。
- 需要真实请求时先说清楚会发什么请求、发给谁，维护者同意后再执行。

## 风险

- **DS 签名盐会变**：米游社更新后扫码换 authkey 可能失效，要能快速更新；读缓存、粘贴链接、UIGF 导入作为不依赖盐的备选。
- **风控**：频繁请求可能触发米游社的验证（1034），请求要节制。
- **法律和平台风险**：不做任何注入或修改客户端的功能；不收费；不仿官方登录界面，不用官方美术和解包数据；凭据只在本机、不上传；默认取数路径不依赖米游社登录；加“非官方”声明，保留随时下线的能力。
- **签名与分发**：macOS 年费、Windows SmartScreen 信誉。
