# 桌面版开发计划（2026-10-19）

在本地开发、调试（要在应用里登录鹰角、读本机游戏文件，云端容器做不了）。调研背景见 [../research/multi-game-and-desktop.md](../research/multi-game-and-desktop.md) 和 [../research/notes/](../research/notes/)；读游戏缓存的细节和开源实现出处见 [mhy-data.md 第 3 节](../research/notes/mhy-data.md)。

## 已经定下的

- **同一个仓库**，不另开仓库。
- **Electron 做界面，Python 做后端**（维护者的决定）。平台：Windows、Linux（RHEL 系、Ubuntu 系）、macOS（x64、arm64）。
- **第一版就支持四款游戏**：明日方舟、明日方舟：终末地、原神、崩坏：星穹铁道。绝区零暂不做（维护者没有账号，无法测试）。
- **原神、星铁的取数方式**（2026-10-19 维护者决定）：读本机游戏日志找到游戏目录，再从游戏的网页缓存里取出抽卡链接；另外支持粘贴链接、UIGF 导入。**不做米游社登录**（扫码或密码都不做），也就不需要 stoken、genAuthKey 和 DS 签名。以后要改，先改这份计划。
- **游戏数据的请求一律由本机直连**（维护者 2026-10-19：“米哈游这边不需要worker转发，老用cf地址请求米哈游的抽卡记录也不好，甚至对于国内用户来说还绕路，所以用python直连请求即可”）：桌面版的鹰角请求（`hg.request`）和米哈游请求（校验抽卡链接、分页拉取抽卡记录）都由本机的 Python 后端直接发给官方接口，**不经过 Cloudflare 或任何 Worker**。Cloudflare 只用于加密云同步（M5）。不做经 Worker 转发抽卡请求的米哈游网页版。
- **图片也由本机拉取**（维护者 2026-10-19：“本地这边的图片，采取python转发，也不用走worker了”）：白名单 `shared/images.json` 和 Worker 共用，Python 拉取并缓存在本机，见 desktop/README.md 的“图片”。
- **云同步分开**：鹰角两款继续用 ark.kaltsit.dev；米哈游的用单独的 `mhy.<域名>`（独立 Worker、独立 Durable Object、独立 `SYNC_PEPPER`），这个 Worker 只做加密云同步，不转发米哈游的接口。
- **网页版 ark.kaltsit.dev 不变**：只有鹰角两款，产物里不能出现米哈游的代码。
- **统计**（维护者 2026-10-19：“本地的统计就不要交给浏览器了，并且关于同意cookie的也可以在本地关闭，本地统计直接交给python，并且做无登陆count+uid哈希count+设备散列count”；补充：UID 和设备分开统计、互不关联，UID 散列要加盐，默认开、可关闭）：桌面版不弹 Cookie 同意；Python 后端上报设备随机 ID 的哈希（附带有没有登录）和加盐的 UID 哈希，服务器再用 `STATS_UID_SALT` 做 HMAC 才保存。见 desktop/README.md 的“使用人数统计”和 SECURITY.md。
- **同步识别码**（维护者 2026-10-19，已实现）：设计见 [../rewrite/sync-user-id.md](../rewrite/sync-user-id.md)。桌面版的识别码由页面传给 Python 后端（`stats.report` 的 `user`），和设备、UID 分开上报。

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

1. **找游戏目录**：读游戏日志（原神 `output_log.txt`，星铁 `Player.log`，在 `%USERPROFILE%\AppData\LocalLow\` 下，国服、国际服路径不同），用正则取出 `YuanShen_Data` / `GenshinImpact_Data` / `StarRail_Data` 所在目录。日志只用来找目录，里面没有抽卡链接（实测）。找不到时让用户手动选择游戏目录（或直接选 `data_2` 文件），并记住这个路径。
2. **找缓存文件**：`<数据目录>\webCaches\<版本号>\Cache\Cache_Data\data_2`。`webCaches` 下还有 `Cache`、`Network`、`IndexedDB` 等不是版本号的目录，要按版本号格式（如 `2.55.0.0`）过滤。按版本号从新到旧找：最新的版本目录里可能一条链接都没有（这个版本还没打开过抽卡记录），就去更早的目录找。
3. **取链接**：**只读打开** `data_2`（不加锁，游戏运行时也能读；不复制，避免在临时目录留下含 authkey 的副本），从后往前找抽卡记录链接。匹配规则按“有 `authkey` + 和抽卡有关的路径 + 有 `game_biz`”，**不要写死页面路径**：
   - 页面地址和接口地址都会出现，两种都要能处理；
   - 页面路径会变（实测原神是 `hk4e/event/e20190909gacha-<哈希>/index.html`，不是常见的 `gacha-v3`；星铁是 `hkrpg/event/e20211215gacha-v2/index.html`）；
   - 接口域名也变过（星铁现在是 `public-operation-hkrpg.mihoyo.com/common/gacha_record/api/getGachaLog`，更早是 `api-takumi.mihoyo.com`）。
4. **清理参数**：只保留拉记录需要的参数（`authkey`、`authkey_ver`、`sign_type`、`auth_appid`、`game_biz`、`region`、`lang` 等），其余一律删掉（`timestamp`、`device_type`、`game_version`、`gacha_id`、`win_mode` 等用不到；游戏链接里还出现过玩家坐标）。
5. **校验**：发一个小分页请求，`retcode == 0` 才算有效；`-101`（过期）时换下一条更早的链接，全部失效就提示用户回游戏重新打开抽卡记录（链接大约 24 小时过期）。**链接里的 `timestamp` 不是生成时间**（实测比缓存写入时间早几周），不能据此离线判断过期，只能发校验请求。
6. **等待读取**（可选）：用户点“等待”后，每隔几秒检查一次 `data_2` 的修改时间，用户在游戏里打开抽卡记录后自动读到新链接。只读文件，不挂代理、不抓包。

本机实测（2026-10-19，Windows，国服两款，`mhy.inspect` 只读检查）：日志里都能找到游戏目录、都没有抽卡链接；原神 `data_2` 里去重后 10 条抽卡链接；星铁有 15 个版本目录，最新的（2.53.0.0）里一条都没有，更早的目录里有；两款的接口路径都是 `gacha_record`。当时缓存里的链接都已过期，真实测试前要先在游戏里打开一次抽卡记录。

第一次真实请求（2026-10-19，原神国服，`mhy.probe genshin --yes`，维护者同意后由本地会话运行）：缓存里第一条链接就有效；每个卡池按 `end_id` 翻页到最后一页，所有格式检查都通过（id 都是 19 位数字字符串、时间是 `YYYY-MM-DD HH:MM:SS`、从新到旧、没有重复、uid 和链接一致）。字段是 `count, gacha_type, id, item_id, item_type, lang, name, op_gacha_type, rank_type, time, uid`；`item_id` 全部为空（要按名称映射）；查 301 时同时返回 301 和 400 的记录；原神的接口不返回 `region_time_zone`（时区按区服推断）。`op_gacha_type` 的含义还没确认，`mhy.probe` 已经会输出 `gacha_type → op_gacha_type` 的对应，下次实验时确认。空卡池第 1 页就结束。整个过程十几秒，没有遇到 -101、-110。

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

- 抽卡链接里的 authkey 只在 Python 进程内存里，大约 24 小时就过期，不保存，每次从缓存重新读。页面只拿到随机句柄，拉记录时传句柄（`mhy.*` 方法，见 desktop/README.md），authkey 不进渲染进程；用户粘贴的链接除外（粘贴时已经在页面里了）。
- **鹰角 token 的“记住登录”只用系统钥匙串**（维护者 2026-10-19：“yj的key要保留，但是用系统的钥匙串加密，系统没钥匙串的，比如说Linux，那么就不保留”）：
  - 主进程用 Electron 的 `safeStorage` 加密（Windows DPAPI、macOS 钥匙串、Linux Secret Service / KWallet），密文存在应用数据目录里；
  - 系统没有可用的钥匙串（Linux 上 `safeStorage` 退回 `basic_text`，或者加密不可用）就**不保存**，token 只留在内存里，关闭应用就没了；界面上“记住登录”不可选并说明原因；
  - 桌面版的 token **永远不写进 IndexedDB**：账号表上装了钩子（`src/lib/token-vault.ts`），写入时转给主进程、读取时从内存补回，其余代码不用改。网页版不变。
  - 以后可以再进一步改成句柄：token 只在主进程或后端，页面和请求信封里只有句柄。要同时改 `client.ts`、`auth.ts`，单独做。
- 抽卡链接当凭据处理：界面上不完整显示，不写日志，不写文件。
- 所有日志经过 `redact.py`：token、cookie、authkey、ticket 等字段的值一律替换成 `***`，有测试检查。
- 凭据不经过任何服务器（桌面版不需要 Worker 转发）。云同步只上传加密后的记录，和网页版一样不上传凭据。

## 应用内鹰角登录窗口（设计，2026-10-19）

- 页面调用 `rpc('app.hgLogin')`（`app.` 开头的方法由主进程自己处理，不转给后端）。成功返回 `{ token }`；用户关闭窗口返回 -32000 + `cancelled`，失败或超时返回 `login_failed`。同一时间只开一个登录窗口。
- 每次登录用新的内存分区（`session.fromPartition('hg-login-<随机>')`，不带 `persist:`），和应用的会话完全分开。窗口：沙盒、上下文隔离、不开 Node、**没有 preload**、不允许 `<webview>`、安装版关掉开发者工具；标题显示当前域名。这个会话的权限请求和下载一律拒绝。
- 顶层页面只允许 `https://*.hypergryph.com`，子框架另外放行极验的域名（真机测试时确认列表）；其他链接交给系统浏览器，`window.open` 一律拒绝。不注入脚本、不读页面内容、不用 debugger 或 webRequest 读响应。
- 取 token：主进程在登录会话里请求 `https://web-api.hypergryph.com/account/info/hg`（带这个会话的 Cookie），时机是 `*.hypergryph.com` 上每次跳转后防抖 1 秒，或用户点“我已登录”；每个窗口最多查 20 次。`code === 0` 且 `data.content` 是非空字符串才算成功。token 不写日志、不进报错。
- token 只作为这次 `rpc` 调用的返回值交给登录弹窗，之后和粘贴的 token 走同一条路；不挂在 `window` 上，主进程交出后不保存。
- 结束时（拿到 token、用户关窗或 10 分钟超时）清掉这个会话的全部存储、缓存和认证缓存，再销毁窗口。**不调用鹰角的退出接口**（可能让刚拿到的 token 失效）。
- 界面上说明：在应用内窗口输入密码，理论上应用能读到；ArkRecord 不注入脚本、代码开源，不想在应用里输密码可以用扫码或粘贴 token。
- 极验：先用 Electron 默认的 User-Agent 真机测试；如果被拦，是否只对登录会话去掉 `Electron/…` 由维护者决定。备选：森空岛 / 鹰角 App 扫码（`gen_scan/login`），粘贴 token 一直保留。
- 先用本机的假登录页把窗口、跳转限制、取 token、清会话整套流程跑通（不发真实请求），再由维护者本人真机登录测试。

## 数据（米哈游）

- `Game` 类型增加 `genshin`、`starrail`（以后 `zzz`）。
- 记录主键用接口返回的 `id`（19 位，必须当字符串处理）。原神的 `item_id` 基本是空的，要按名称映射；时间按区服时区解释（原神按 UID 推断，星铁读 `region_time_zone`）。
- 卡池：原神 `gacha_type` 100/200/301/400/302/500（301 会混入 400），星铁 1/2/11/12，联动池 21/22 走 `getLdGachaLog`。
- 保底规则在实现时按官方公示核对后写进 `src/lib/mhy/`（不要凭印象写）。
- 导入导出用 UIGF v4.2。

## 里程碑

1. **M0 骨架**（2026-10-19 完成）：Electron + Python 子进程跑通（ping），一条命令启动开发环境（`npm run desktop:dev`）；渲染进程加载现有应用（desktop 构建）。
2. **M1 鹰角两款**：`transport.ts` + `shared/upstreams/hg.json` + Python 执行请求信封；应用内登录窗口取 token；明日方舟、终末地同步跑通，不经过 Worker。
3. **M2 原神**（2026-10-19 完成）：读日志找目录 → 读缓存取链接 → 校验 → 分页拉取抽卡记录；粘贴链接；手动选择目录；存储、统计页面。数据层在 `src/lib/mhy/`（单独的 IndexedDB `arkrecord-mhy`），界面在 `src/components/mhy/`、`src/pages/mhy/`，只在桌面构建里出现（`@/platform`，网页构建引用到就报错）。真机测试：第一次读取十几次请求、各卡池条数和 `mhy.probe` 一致；第二次读取每个卡池 1 页就停，没有新记录。保底规则（上限、小保底 / 大保底）还没按官方公示核对，界面只显示数出来的抽数。
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
- 需要真实请求时先说清楚会发什么请求、发给谁，维护者同意后再执行。米哈游的真实请求用 `arkrecord_backend.mhy.probe`：不加 `--yes` 时列出会发的请求（可以直接拿给维护者看），加了才发，输出里只有页数、条数和格式检查。

## 风险

- **缓存格式和路径会随游戏版本变化**：日志里的路径格式、`webCaches` 目录结构、链接里的页面路径都可能变。解析失败时给出明确提示（并允许手动选择目录），粘贴链接和 UIGF 导入一直保留。
- **限流**：翻页太快会被抽卡接口拒绝，翻页之间要有间隔。
- **法律和平台风险**：不做任何注入或修改客户端的功能；只读游戏文件；不做米游社登录；不收费；不仿官方界面，不用官方美术和解包数据；凭据只在本机、不上传；加“非官方”声明，保留随时下线的能力。
- **签名与分发**：macOS 年费、Windows SmartScreen 信誉。
