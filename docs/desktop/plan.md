# 桌面版开发计划（2026-10-19）

在本地开发、调试（要在应用里登录鹰角、读本机游戏文件，云端容器做不了）。调研背景见 [../research/multi-game-and-desktop.md](../research/multi-game-and-desktop.md) 和 [../research/notes/](../research/notes/)；读游戏缓存的细节和开源实现出处见 [mhy-data.md 第 3 节](../research/notes/mhy-data.md)。

## 已经定下的

- **同一个仓库**，不另开仓库。
- **Electron 做界面，Python 做后端**（维护者的决定）。平台：Windows、Linux（RHEL 系、Ubuntu 系）、macOS（x64、arm64）。
- **第一版就支持四款游戏**：明日方舟、明日方舟：终末地、原神、崩坏：星穹铁道。绝区零暂不做（维护者没有账号，无法测试）。
- **原神、星铁的取数方式**（2026-10-19 维护者决定）：读本机游戏日志找到游戏目录，再从游戏的网页缓存里取出抽卡链接；另外支持粘贴链接、UIGF 导入。**不做米游社登录**（扫码或密码都不做），也就不需要 stoken、genAuthKey 和 DS 签名。以后要改，先改这份计划。
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
│   米哈游：读游戏日志和缓存找抽卡链接、    │
│           分页拉取抽卡记录             │
│   UIGF 导入导出                       │
│   凭据：内存；鹰角“记住登录”时存系统钥匙串│
└──────────────────────────────────┘
```

- **渲染进程**复用现有的页面、统计、合并规则和 IndexedDB 存储（Electron 里 IndexedDB 存在应用数据目录）。
- **请求层抽象**：新增 `src/lib/transport.ts`。网页版照旧发到 `/api/hg/*`（Worker）；桌面版调用 `window.arkrecord.request(...)`，经主进程交给 Python。`src/lib/hg/client.ts` 的请求信封格式不变。
- **白名单共用**：把 `worker/upstreams.ts` 里的上游和路由抽成 `shared/upstreams/hg.json`（Worker 直接 import），Python 读同一份文件，只发白名单内的请求。米哈游的上游单独放在 `shared/upstreams/mhy.json`（只有桌面版用，网页版和 Worker 不引用），只放行抽卡记录接口（原神、星铁的 `getGachaLog`，星铁联动池的 `getLdGachaLog`，国服和国际服域名），不放行流水等其他接口。
- **构建目标**：`vite build`（网页，只有鹰角两款）和 `vite build --mode desktop`（四款）。游戏列表用构建常量控制；网页版的构建清单里检查不能出现米哈游的模块。

### 建议的目录

```
desktop/
  electron/            主进程、preload、鹰角登录窗口
  backend/             Python 包（pyproject.toml，用 uv 管理）
    arkrecord_backend/
      rpc.py           stdio JSON-RPC
      redact.py        日志脱敏
      secrets.py       系统钥匙串（keyring，只给鹰角 token 用）
      hg.py            鹰角请求信封（按 shared/upstreams/hg.json）
      mhy/
        locate.py      从游戏日志找游戏目录；找不到时用用户手动选的目录
        cache.py       从 webCaches 的 data_2 里取最新的抽卡链接，只保留必要参数
        gacha.py       校验链接、分页拉取抽卡记录
        uigf.py        UIGF v4.2
    tests/             只用脱敏或合成的样本（含合成的日志和 data_2）
  electron-builder.yml
src/lib/transport.ts
src/lib/mhy/           原神、星铁的类型、同步、合并、保底规则
shared/upstreams/hg.json   鹰角白名单（Worker 和 Python 共用）
shared/upstreams/mhy.json  米哈游白名单（只给桌面版）
```

## 登录和取数

| 游戏 | 首选 | 备选 |
|---|---|---|
| 明日方舟、终末地 | 应用内打开鹰角官方登录页（独立会话），用户自己登录，主进程在这个会话里请求 `account/info/hg` 取 token，用完清掉会话 | 鹰角 App / 森空岛扫码（`gen_scan/login` 流程，见 docs/rewrite/research.md）；手动粘贴 |
| 原神、星铁 | 读本机游戏缓存里的抽卡链接：先在游戏里打开一次抽卡记录（星铁可能要翻几页才会写进缓存），再在应用里点“读取” | 粘贴抽卡链接；UIGF 导入 |

读游戏缓存的步骤和规则：

1. **找游戏目录**：读游戏日志（原神 `output_log.txt`，星铁 `Player.log`，在 `%USERPROFILE%\AppData\LocalLow\` 下，国服、国际服路径不同），用正则取出 `YuanShen_Data` / `GenshinImpact_Data` / `StarRail_Data` 所在目录。找不到时让用户手动选择游戏目录（或直接选 `data_2` 文件），并记住这个路径。
2. **找缓存文件**：`<数据目录>\webCaches\<版本号>\Cache\Cache_Data\data_2`；有多个版本目录时取最近修改的。
3. **取链接**：把 `data_2` **复制**到临时目录再读（游戏运行时文件被占用），从后往前找最新的抽卡记录链接；临时文件用完就删。
4. **清理参数**：只保留拉记录需要的参数（`authkey`、`authkey_ver`、`sign_type`、`game_biz`、`lang` 等），其余参数一律删掉（游戏链接里出现过玩家坐标等信息）。
5. **校验**：发一个小分页请求，`retcode == 0` 才算有效；`-101`（过期）时提示用户回游戏重新打开抽卡记录（链接大约 24 小时过期）。

- **只读**：不写、不改任何游戏文件，不注入、不挂代理、不请求管理员权限。缓存里除抽卡链接以外的内容不读取、不保存、不上传。
- **平台**：
  - Windows：按上面的步骤自动找。
  - Linux：游戏一般跑在 Wine / Proton 里，日志和游戏目录在 Wine 前缀里，自动找不到时用手动选择的路径。
  - macOS：先只提供粘贴链接和 UIGF 导入（有没有可读的游戏缓存，实现时再确认）。
- **国服、国际服都支持**（日志路径和接口域名不同）。
- 手机玩家拿不到链接，只能用 UIGF 导入其他工具导出的记录，界面上要说清楚。
- 不调试、不读取用户自己的浏览器（Chrome 136 起不允许，且行为和窃密木马一样）。
- 实现时可以参考开源实现（出处列在 mhy-data.md 第 3.1 节），引用代码要确认许可兼容并保留许可声明。

## 凭据和隐私

- 鹰角 token、抽卡链接里的 authkey 默认只在 Python 进程内存里。鹰角 token 在用户勾选“记住登录”时存系统钥匙串（Windows 凭据管理器、macOS 钥匙串、Linux Secret Service），不写普通文件。authkey 大约 24 小时就过期，不保存，每次从缓存重新读。
- 抽卡链接当凭据处理：界面上不完整显示，不写日志，不写文件。
- 所有日志经过 `redact.py`：token、cookie、authkey、ticket 等字段的值一律替换成 `***`，有测试检查。
- 凭据不经过任何服务器（桌面版不需要 Worker 转发）。云同步只上传加密后的记录，和网页版一样不上传凭据。

## 数据（米哈游）

- `Game` 类型增加 `genshin`、`starrail`（以后 `zzz`）。
- 记录主键用接口返回的 `id`（19 位，必须当字符串处理）。原神的 `item_id` 基本是空的，要按名称映射；时间按区服时区解释（原神按 UID 推断，星铁读 `region_time_zone`）。
- 卡池：原神 `gacha_type` 100/200/301/400/302/500（301 会混入 400），星铁 1/2/11/12，联动池 21/22 走 `getLdGachaLog`。
- 保底规则在实现时按官方公示核对后写进 `src/lib/mhy/`（不要凭印象写）。
- 导入导出用 UIGF v4.2。

## 里程碑

1. **M0 骨架**：Electron + Python 子进程跑通（ping），一条命令启动开发环境；渲染进程加载现有应用（desktop 构建）。
2. **M1 鹰角两款**：`transport.ts` + `shared/upstreams/hg.json` + Python 执行请求信封；应用内登录窗口取 token；明日方舟、终末地同步跑通，不经过 Worker。
3. **M2 原神**：读日志找目录 → 读缓存取链接 → 校验 → 分页拉取抽卡记录；粘贴链接；手动选择目录；存储、统计页面。
4. **M3 星铁**（含联动池）；UIGF 导入导出；Linux 下的路径处理。
5. **M4 打包**：三平台安装包，每个安装包签发构建证明（签名另议：macOS 需要 Apple 开发者年费，Windows 可申请 SignPath 开源免费签名）。
6. **M5 云同步**：鹰角走 ark.kaltsit.dev，米哈游走 `mhy.<域名>`。现在的 `/api/cloud` 只接受网页同源请求，桌面版要单独设计客户端校验，并经过安全评审、更新 SECURITY.md。

## 本地开发环境

- Node.js 22.12 以上（推荐 24）、Python 3.12 以上、[uv](https://docs.astral.sh/uv/)、Git。
- 测试读缓存：Windows 上装了原神 / 星铁，并在游戏里打开过抽卡记录（国服、国际服各有一个最好）。Linux 上用 Wine 跑游戏的话可以测路径处理。
- M0 完成后：`npm install`，`cd desktop/backend && uv sync`，再用 `npm run desktop:dev` 启动（命令在 M0 里定）。

## 调试规则（给本地会话）

- 维护者自己在游戏里打开抽卡记录、在应用里登录鹰角；AI 助手不读取、不打印凭据（包括抽卡链接和其中的 authkey），调试只看状态码、条数、错误码。
- 调试读缓存时只输出“找到 / 没找到”、文件路径（用户名部分打码）、链接里有哪些参数名，不输出参数值。
- 不把真实的抽卡数据（含 UID、昵称）、游戏日志、缓存文件、截图提交进仓库。
- 需要真实请求时先说清楚会发什么请求、发给谁，维护者同意后再执行。

## 风险

- **缓存格式和路径会随游戏版本变化**：日志里的路径格式、`webCaches` 目录结构、链接里的页面路径都可能变。解析失败时给出明确提示（并允许手动选择目录），粘贴链接和 UIGF 导入一直保留。
- **限流**：翻页太快会被抽卡接口拒绝，翻页之间要有间隔。
- **法律和平台风险**：不做任何注入或修改客户端的功能；只读游戏文件；不做米游社登录；不收费；不仿官方界面，不用官方美术和解包数据；凭据只在本机、不上传；加“非官方”声明，保留随时下线的能力。
- **签名与分发**：macOS 年费、Windows SmartScreen 信誉。
