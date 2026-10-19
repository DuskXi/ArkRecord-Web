# 调研：米哈游系站点、多站点数据互通、桌面版（2026-10-18）

只调研，没有实现。四个方向的详细笔记（含全部出处链接）在 [notes/](notes/)：

| 笔记 | 内容 |
|---|---|
| [mhy-data.md](notes/mhy-data.md) | 原神 / 星铁 / 绝区零的抽卡接口、两种获取方式、UIGF、现有工具 |
| [cross-domain.md](notes/cross-domain.md) | ark / mhy / game 三个站点之间怎么传数据，各浏览器的存储隔离规则 |
| [desktop.md](notes/desktop.md) | Electron（+ Python）桌面版：取 token、打包、签名、更新、CI |
| [hg-pc.md](notes/hg-pc.md) | 鹰角两款游戏在 PC 上有没有不用手动复制的 token 获取方式 |

证据等级沿用笔记里的标注：**实测**（本次在沙箱里验证过）、**源码**（读了开源实现或浏览器源码）、**文档**（官方文档或规范）、**转述**（只看到搜索摘要，原文打不开）、**推测**。沙箱的出口代理拦截了米哈游、HoYoverse 的全部域名和不少中文资讯站，所以米哈游接口的跨域响应头没能亲自测，相关结论来自开源代码。

---

## 结论速览

> 2026-10-19 维护者决定：桌面版的原神、星铁读本机游戏缓存里的抽卡链接，另支持粘贴链接和 UIGF 导入，**不做米游社登录**。以 [../desktop/plan.md](../desktop/plan.md) 为准，下面第 1 条是当时的调研建议。

1. **米哈游的数据**：两条路都做。**米游社扫码登录**（国服）给大多数人用，尤其是只在手机上玩、根本拿不到抽卡链接的玩家；**粘贴抽卡链接**给国际服和不想登录的人；UIGF v4.2 导入导出做成一等功能。扫码登录的代价是要维护逆向得到、随米游社版本变化的签名盐，偶尔触发风控，而且网页版要经过 Worker 转发登录凭据，合规上比桌面版更灰（见 1.2，2026-10-19 修订）。
2. **域名**：推荐用子域名 `mhy.kaltsit.dev`、`game.kaltsit.dev`。但无论子域名还是独立域名，**都不能靠隐藏 iframe 自动互通**：Safari（以及 iOS 上的所有浏览器）按顶层页面给 iframe 的存储分区，同站也一样。真正可靠的通道是**端到端加密云同步**和**弹窗 + postMessage**。
3. **不影响鹰角站点**：三个站点各用独立的 Worker、Durable Object、限速命名空间、部署 token 和构建证明。要注意 Cloudflare 免费额度按**整个账号**计算；目前账号里所有 Worker 合计每天约 1 千到 4.5 千次请求（额度 10 万次），余量很大，但新站点上量后要考虑 Workers Paid（每月 5 美元）。
4. **桌面版**：建议**纯 Electron，不加 Python**（主进程本身就是 Node.js，直接发请求没有跨域限制）。“调试用户的浏览器取 token”**不可行也不该做**：Chrome 136 起默认用户目录禁止远程调试，读浏览器 cookie 库的行为和窃密木马一样，会被杀毒软件拦。推荐在应用里开一个**官方登录页窗口**让用户自己登录，体验同样“傻瓜”。
5. **桌面版的实际收益**：鹰角两款游戏没有本地捷径（终末地 1.1 起不再把带 token 的链接写进日志），桌面版对鹰角的价值是“应用内登录”；对米哈游的价值更大——可以**直接读取游戏缓存里的抽卡链接**，不用让用户运行 PowerShell 脚本。

---

## 一、米哈游抽卡数据怎么拿

### 1.1 接口概况（源码，多个开源实现一致）

| 游戏 | 国服 host | 路径 | 卡池参数 | 特点 |
|---|---|---|---|---|
| 原神 | `public-operation-hk4e.mihoyo.com` | `/gacha_info/api/getGachaLog` | `gacha_type`：100 新手、200 常驻、301 角色、400 角色-2、302 武器、500 集录 | `item_id` 基本为空，要按名称映射；不返回时区，按区服推断；千星奇域另有 `getBeyondGachaLog` |
| 星铁 | `public-operation-hkrpg.mihoyo.com` | `/common/hkrpg_gacha_record/api/getGachaLog` | `gacha_type`：1 常驻、2 新手、11 角色、12 光锥；21/22 联动池走 `getLdGachaLog` | 返回 `region_time_zone` |
| 绝区零 | `public-operation-nap.mihoyo.com` | `/common/gacha_record/api/getGachaLog` | `real_gacha_type`：1 常驻、2 独家、3 音擎、5 邦布、102 / 103 重映 | rank_type 2/3/4 = B/A/S |

- 国际服把 host 换成 `*-sg.hoyoverse.com`。
- 共同参数：`authkey`、`authkey_ver=1`、`sign_type=2`、`lang`、`game_biz`、`size`（上限 20）、`end_id` 翻页。
- 错误码：`-101` 过期、`-100` 无效、`-110` 请求太频繁（没有官方限速数字，工具普遍每页间隔 0.2–2 秒，遇到 -110 就退避）。
- 记录 id 是 19 位数字，JavaScript 里必须当字符串处理。
- 保留期：原神据 BWIKI 和胡桃文档自 4.5 起为 1 年；星铁、绝区零社区说 6 个月，未核实。
- 崩坏3 没有找到可用的公开接口，主流工具也都不支持。
- **跨域**：只有一个开源项目明确说浏览器直连会被拦；所有网页工具（paimon.moe、stardb 等）都经过自己的服务器转发。所以网页版**需要 Worker 转发**，和鹰角一样。

### 1.2 两种获取方式对比

| | A：游戏缓存里的抽卡链接（authkey） | B：登录米游社 / HoYoLAB（stoken） |
|---|---|---|
| 用户怎么做 | 在游戏里打开一次抽卡记录，再取出链接 | 登录或扫码 |
| 凭据能做什么 | 24 小时有效、只读；**推测**只能读抽卡记录（原石流水要另一种 authkey） | 能换出所有网页凭据、生成任意 authkey，**还能生成登录游戏的票据**，接近账号完全控制。不过鹰角的账号 token 同样是账号级凭据，现有设计已经按这个级别保护（只在内存、默认不保存、Worker 不记录），所以这一点不是决定性的差别 |
| 手机玩家 | 基本拿不到（Android 要 ADB，iOS 要抓包） | **扫码即可**，和在哪个平台玩无关 |
| 用户要做的事 | PC 上要先在游戏里打开抽卡记录页（缓存里才会有链接），再运行脚本或手动找 | 用米游社 App 扫一下 |
| 实现难度 | 低：解析链接、分页拉取 | 中到高：扫码本身不难，但生成 authkey（genAuthKey）要 DS 签名，盐是从米游社 App 逆向来的、随版本变化（胡桃构建时会拉最新值）；还要设备指纹，偶尔触发风控（1034）需要用户去米游社 App 里验证 |
| 国际服 | 支持 | 国服扫码流程不支持国际服；国际服要另一套 cookie |
| 风险先例 | 没有找到因导出记录被封的可靠案例 | 米哈游起诉过“模仿登录界面获取玩家数据”的工具（二手报道）。胡桃这类桌面工具的凭据只在用户本机；网页版要经过我们的 Worker 转发，更接近被起诉的那种形态，合规上更灰 |
| 星铁 / 绝区零 | 支持 | genAuthKey 换 `game_biz` 应该就行（**推测**：胡桃只做原神，要实测） |

PC 上取链接的原理（三款游戏相同）：从 `%USERPROFILE%\AppData\LocalLow\miHoYo\<游戏>\` 下的日志找到游戏目录，再在 `<游戏>_Data\webCaches\<版本>\Cache\Cache_Data\data_2` 里找最后一个抽卡链接。网上流行让用户执行 `iex(irm …)` 远程脚本，问题很大：执行的是下载那一刻的远端代码、用户看不到内容、容易被钓鱼模仿。手机端很难：Android 要用 ADB 看日志，iOS 只能装证书抓包。

### 1.3 推荐方案（网页版）

- **米游社扫码登录（国服）**：给大多数人，尤其是手机玩家。登录凭据按鹰角 token 的同一套规则处理：只在浏览器内存里，用户选“记住登录”才保存；Worker 只放行扫码、换 authkey 这几个接口，不记录不存储；签名盐写在公开代码里，米游社更新导致失效时尽快跟进。上线前要实测：星铁、绝区零能否用同一流程生成 authkey；风控触发的频率。
- **粘贴抽卡链接**：给国际服、PC 用户和不想登录的人。浏览器里先解析链接，**只保留** authkey 和必要参数交给 Worker 转发，丢掉设备、版本、坐标等多余参数；authkey 只放内存，不保存。
- **帮用户拿链接**，按隐私从好到差：
  1. 网页里直接选择 `data_2` 文件，由浏览器本地解析，不执行任何脚本。游戏运行时能不能读这个文件**要实测**。
  2. 提供一个固定版本、页面上展示全文和 SHA-256、不联网、不要管理员权限的本地脚本，只把链接放进剪贴板。
  3. 云游戏用户用开发者工具。
- **UIGF v4.2 导入导出**作为一等功能：手机、主机用户可以先用别的工具导出再导入；也方便和胡桃、Starward 等工具互通。
- 国际服的 HoYoLAB 登录流程不同（cookie_token_v2），而且 HoYoLAB 默认屏蔽中国大陆的连接，先不做。
- 不默认上传任何统计（paimon.moe 默认勾选上传 pity 统计）。
- 桌面版做扫码登录更干净：凭据只在本机，不经过任何服务器（胡桃就是这样）。

### 1.4 Worker 转发和鹰角相比要多注意的

现有的做法（参数放在 POST 请求体、关闭日志、路由白名单、同源校验、限速、错误不带上游地址）可以直接沿用。米哈游额外要注意：

1. **上游白名单要窄**：只放行 6 个 `public-operation-*` host 和抽卡的 3 个路径（`getGachaLog`、`getLdGachaLog`、`getBeyondGachaLog`），不放行流水接口和 `api-takumi` 账号接口，避免 Worker 变成通用的 authkey 代理。
2. **查询参数白名单**：上游要求 authkey 在网址查询参数里，所以 Worker 发往上游的 URL 一定带着它；Worker 不能记录、不能进 Cloudflare 边缘缓存，异常信息也不能带出去。
3. **authkey 编码**：用户粘贴的链接常被编码过一次甚至两次，要先统一解码再编码，否则 `+` 变成空格导致 authkey 无效。
4. **限速**：所有用户共用 Cloudflare 的出口 IP，米哈游的计数方式不清楚；前端串行拉取、每页间隔几百毫秒，遇到 -110 退避。
5. **数据正确性**：时区（原神按区服推断，星铁、绝区零读 `region_time_zone`）、19 位 id、原神空 `item_id`、301 混入 400、绝区零用 `real_gacha_type`、星铁联动池和千星奇域换接口。
6. **元数据**：item_id → 名称、星级的映射建议构建时生成静态文件（和现在鹰角的 gamedata 一样）。来源有 UIGF API、Yatta、Hakush、EnkaNetwork、StarRailRes，都非官方；注意胡桃原仓库（DGP-Studio/Snap.Hutao）和它的元数据仓库现在是 404，UIGF API 的原神数据源受影响。

### 1.5 待实测

- 本地浏览器用 `authkey=invalid` 发带 Origin 的请求，确认跨域响应头。
- 游戏运行时浏览器能否通过文件选择读到 `data_2`。
- 抽卡 authkey 能否读原石流水（预计不能）。
- 星铁、绝区零的实际保留期；绝区零 102/103 的返回值和 UIGF 映射；千星奇域的 size 上限。

---

## 二、ark / mhy / game 三个站点

### 2.1 子域名还是独立域名

| | 子域名（`mhy.kaltsit.dev`、`game.kaltsit.dev`） | 独立注册的域名 |
|---|---|---|
| 浏览器眼里 | 和 ark **同站不同源** | 跨站 |
| iframe 自动互通 | Chrome / Edge / Firefox 可以（实测 / 源码）；Safari 不行 | 所有浏览器默认都被分区；Chrome 可以用 Storage Access API 解锁，Firefox / Safari 只解锁 cookie |
| Safari 清理存储 | 交互按整个 kaltsit.dev 计算，用户常用 ark 也能让 game 的数据不被清 | 用户不直接打开 game 的话，game 的数据可能被清 |
| 弹窗、云同步 | 可用 | 可用 |
| Cloudflare 配置 | 同一个 zone，最简单 | 新 zone，可以放到另一个账号里彻底隔离 |

**推荐子域名**，除非“账号级彻底隔离”比“本地互通”更重要。另一个产品层面的考虑：kaltsit.dev 是明日方舟角色的名字，米哈游玩家可能会觉得别扭；如果在意，可以给 mhy 和 game 另买一个中性域名（这样 mhy ⇄ game 同站，ark ⇄ game 跨站），因为主要通道（云同步、弹窗）本来就不依赖同站，代价不大。

### 2.2 浏览器存储隔离（同站 iframe：ark 页面里嵌入 game）

| 浏览器 | iframe 里的存储是不是 game 自己那份 | 依据 |
|---|---|---|
| Chrome / Edge | 是；但如果中间夹了跨站页面就会分区 | 实测（Chromium 141） |
| Firefox | 是 | 源码 |
| Safari / iOS 所有浏览器 | **不是**：按顶层页面分区，iframe 的 localStorage 只在内存里 | 源码 + WebKit 官方博客 |

另外：iOS 主屏幕 Web App、macOS Dock Web App 的存储和 Safari 分开，网页手段碰不到，只能靠云同步。测试时注意 Playwright 默认关闭了 Chromium 的第三方存储分区，不去掉这个开关会得出错误结论。

### 2.3 数据通道

| 优先级 | 通道 | 优点 | 代价 / 风险 | 对安全头的改动 |
|---|---|---|---|---|
| 首选（跨设备） | **端到端加密云同步** | 跨设备、跨浏览器，不受 Safari 分区和清理影响 | 用户要设密码；占服务器额度；每个账号 4 MiB 上限 | 无 |
| 首选（本机） | **弹窗 + MessageChannel**：ark 打开 game 的一个页面，用户在 game 页面里确认 | 跨站也能用（实测）；确认发生在 game 自己的页面里，ark 被攻破也伪造不了 | 需要点一下；任何一方设置 `Cross-Origin-Opener-Policy: same-origin` 都会失败 | 无 |
| 增强 | 同站隐藏 iframe 自动同步，Safari 下退回弹窗 | Chrome / Firefox 上无感 | Safari 静默失败；game 集中了所有数据，出安全问题影响面最大 | ark 加 `frame-src`；game 只对 `/bridge` 放开 `frame-ancestors` |
| 兜底 | 文件导出 / 导入（鹰角用 ArkRecord 格式，米哈游用 UIGF） | 简单 | 手动 | 无 |

建议分两步：**先单向**（game 只从 ark / mhy 拉取，ark 的数据库不接受任何外来写入，最符合“不影响 ark”）；**再考虑双向**（game 推回 ark 的数据按不可信的导入文件处理，让用户确认）。现有合并规则与顺序无关，三个站点共用同一个合并实现就能保证任意方向、任意次合并结果一致。同步范围限定：ark ⇄ game 只传鹰角游戏，mhy ⇄ game 只传米哈游游戏，永远不传 token、云同步钥匙和本机设置。

### 2.4 game 怎么接入 ark 的云同步

现有云同步按“游戏 + UID”存储，服务器只保存密文，格式可以直接扩展到新游戏。game 要读写 ark 的云端数据，推荐：

- ark 的 Worker 新增一个**只能通过 service binding 调用**的内部入口（Cloudflare 同一账号内 Worker 之间的直接调用，不经过公网）。ark 仍然是唯一能碰自己的 Durable Object 和 `SYNC_PEPPER` 的代码。
- game 的前端照常请求同源的 `/api/cloud`，由 game 的 Worker 转给 ark。两边的 CSP 都不用改。
- **不推荐**让 game 直接绑定 ark 的 Durable Object（game 的代码能绕过 ark 的校验，pepper 也要交出去）；**也不推荐**给 ark 开跨域（要改现在的同源校验，扩大公网攻击面）。

### 2.5 部署隔离与额度

- 三个独立 Worker：各自的配置、域名、Durable Object、secrets、限速 `namespace_id`。**限速 id 在整个账号内唯一，不同 Worker 用同一个 id 会共用计数器。**
- CI：Cloudflare 支持把 API token 限定到单个 Worker；三个站点各用一个 token、一个 GitHub Environment，各自生成构建清单和构建证明，ark 现有的流程可以照搬。
- **免费额度按账号计算**（Worker 请求、Durable Object 请求、DO 写入各每天 10 万）。超额后，所有经过 Worker 的请求返回 429；ark 1.1.8 起页面地址也经过 Worker（为了给 AI 返回 Markdown），所以**超额时 ark 的页面也会打不开**，不只是接口。现在账号里所有 Worker 合计每天约 1 千到 4.5 千次（2026-10-11 到 10-18，Cloudflare Analytics），离上限很远。新站点上线前建议：开 Workers Paid，或者 mhy / game 放到另一个 Cloudflare 账号（子域名做不到直接跨账号，只能走 Cloudflare for SaaS，需要实测），并且新站点尽量少用 `run_worker_first`。

### 2.6 代码组织

- 推荐 monorepo（pnpm workspaces）：`apps/{ark,mhy,game}` + `packages/{ui,stats,merge,cloud-protocol,bridge-protocol,game-*}`。每个站点只 import 自己需要的游戏包，构建清单可以用来确认 ark 的产物里没有米哈游代码。
- **第一阶段 ark 仓库不动**：mhy / game 新开仓库（或新目录），把需要共用的统计、合并、云同步代码复制或抽成包；等稳定后再考虑把 ark 迁进 monorepo，迁移时要保住“同一个 commit 构建结果逐字节相同”。
- 现有代码里和游戏无关、可以直接复用的：统计库（保底、分布、规划）、合并规则、云同步协议和加密、公告、审计、UI 外壳。和鹰角绑定的：`src/lib/hg`、`src/lib/sync`、`worker/upstreams.ts`、`Game` 类型。

### 2.7 待实测

真机 Safari / iOS（同站 iframe、弹窗流程、主屏幕 Web App 里的 `window.open`）；Firefox 同站 iframe（目前是源码结论）；Cloudflare `_headers` 同一块里先摘掉再设置 CSP 是否生效；Cloudflare for SaaS 跨账号挂子域名。

---

## 三、桌面版

### 3.1 “调试用户的浏览器取 token”：不可行，也不该做

- **Chrome 136 起**，`--remote-debugging-port` 指向默认用户目录时不再生效，必须用非默认目录。Google 的理由正是“攻击者越来越多地用远程调试偷 cookie”（Chrome 官方博客，2025-03）。也就是说，附加到用户已经登录的日常浏览器这条路已经被堵了。Chrome 144+ 虽然允许用户在 `chrome://inspect` 手动开启并逐次批准，但一点也不“傻瓜”。
- **Firefox** 的远程调试只能用命令行参数启动，CDP 已经移除，官方安全文档把“能执行命令的攻击者”列为不防护的范围——用它取 token 就是在复刻攻击者手法。
- **直接读浏览器的 cookie 数据库**：Windows 上 Chrome 127 起有 App-Bound Encryption，普通应用解不开；这种行为和窃密木马无法区分，Elastic 等安全产品有现成的检测规则。对一个强调“token 不记录、代码可审计”的项目，被杀毒软件报毒的代价太大。
- 用临时 profile 启动用户装的 Chrome 再让用户登录：技术上可行，但用户照样要登录一次，还依赖本机浏览器版本，进程形态正好命中安全软件的规则，没有任何优势。

### 3.2 推荐的取 token 方式

| 顺序 | 方式 | 说明 |
|---|---|---|
| 首选 | **应用内官方登录窗口** | 用独立会话打开 `user.hypergryph.com`，用户自己登录（手机验证码或密码，极验验证由官方页面自己处理）；登录后应用用这个会话请求 `account/info/hg` 拿 token，然后清除会话。不往官方页面注入脚本，只读取需要的那个响应。终末地的开源工具（bhaoo/endfield-gacha、RoLingG/EndField_Gacha_App）已经验证可行。 |
| 备选 | **森空岛 / 鹰角 App 扫码** | `gen_scan/login` → 轮询 → `token_by_scan_code`，用户扫码即可，不用过极验（流程已记在 docs/rewrite/research.md）。只拿账号 token，不碰森空岛的 cred 和数美设备指纹。 |
| 兜底 | 手动粘贴 | 和网页版一样。 |

注意事项：`account/info/hg` 依赖登录后的 HttpOnly cookie，而且它的跨域白名单只认鹰角自己的域名，所以必须在登录窗口的同一会话里、由主进程发请求。官服 token 有效期很短，需要“过期就提示重新登录”。登录窗口按 Electron 安全清单配置：contextIsolation、sandbox、禁用 nodeIntegration、拒绝所有权限请求、限制跳转和新窗口、开启 cookie 加密。

### 3.3 游戏在 PC 上的本地数据

| 游戏 | 本地有没有带凭据的链接 | 桌面版能做什么 |
|---|---|---|
| 终末地 | 1.1（2026-03-12）以前日志 `HGWebview.log` 里有带 `u8_token` 的链接；**1.1 起不再写入**，读日志在国服基本失效 | 应用内登录；读日志最多作为提示可能失效的降级尝试 |
| 明日方舟 | 有官方 PC 版（2026-02 开始技术性开放测试），但没有找到本地捷径，所有工具都用账号 token | 应用内登录 |
| 原神 / 星铁 / 绝区零 | 有：游戏网页缓存 `data_2` 里有最近的抽卡链接 | **自动读取**，不用 PowerShell；Linux 上游戏在 Wine / Proton 里，路径在前缀目录里（推测，需实测）；macOS 没有这几款的 PC 版 |

**警示案例**：终末地曾有一个闭源工具 EndfieldRecords 让用户运行 PowerShell 脚本、上传日志，后来脚本被换成会回连外部服务器、创建计划任务的版本（转述）。“让用户运行第三方脚本”这个模式本身就危险，桌面版正好可以替代它。

### 3.4 要不要 Python

建议**不要**。Electron 主进程就是 Node.js，用主进程的网络 API 发请求没有跨域限制，`worker/upstreams.ts` 的白名单可以几乎原样移植过去；项目的逻辑全是 TypeScript，没有非 Python 不可的部分。加 Python 的代价：两套运行时（安装包多几十 MB）、PyInstaller 打包的程序常被杀毒软件误报、macOS 上每个 Python 二进制都要签名公证、npm 和 PyPI 两套依赖的供应链审计、每个平台都要原生构建（不能交叉编译）。如果一定要用：Python 作为子进程，通过 stdio 交换 JSON（不开本地端口）；PyOxidizer 已停止维护，不要用。次选是 Tauri（体积小），但它用系统自带的 WebView，极验登录在各平台上能否通过要逐个实测，而应用内真 Chromium 恰恰是这个项目最需要的。

### 3.5 打包、签名、更新、可审计

- **打包**：electron-builder。Windows 用 NSIS；Linux 出 AppImage、deb（Ubuntu 系）、rpm（RHEL 系）；macOS 出 dmg，x64 和 arm64 分别在原生机器上构建。Linux 要在 glibc 较老的环境里构建（Electron 本身需要 glibc 2.25，在 glibc 2.28 的 manylinux 容器里构建可以覆盖 RHEL 8）；Ubuntu 24.04 的 AppArmor 限制非特权 user namespace，electron-builder 新版本已有处理；Wayland 下 Electron 38 起默认原生运行。
- **macOS 签名**：必须加入 Apple Developer Program（每年 99 美元），否则 macOS 15 起用户基本打不开（“已损坏”）。绕不开。
- **Windows 签名**：EV 证书自 2024 年起不再立即获得 SmartScreen 信誉，已不值得；Azure Artifact Signing（原 Trusted Signing）个人只对美国、加拿大开放。开源项目推荐 **SignPath Foundation 免费签名**（要求 OSI 许可证、从公开仓库全自动构建，本项目符合），或者上架 Microsoft Store（个人开发者免注册费）。
- **自动更新**：electron-updater + GitHub Releases；electron-builder 27 默认要求更新清单签名（Ed25519），建议启用。
- **可审计**：每个安装包都用 `actions/attest-build-provenance` 签发构建证明，加上 GitHub 不可变发布（immutable releases），用户可以用 `gh attestation verify` 核对。字节级可复现对 Electron 很难（官方二进制、签名会改字节），可以像 Signal 一样先只对 Linux 包做。

### 3.6 CI（GitHub Actions，公开仓库免费）

建议矩阵：`windows-latest`、`ubuntu-24.04`、`ubuntu-24.04-arm`、`macos-15-intel`（x64）、`macos-latest`（arm64）。`macos-13` 已于 2025-12 下线；GitHub 计划在 macOS 15 runner 于 2027 年秋退役后不再提供 Intel Mac，x64 Mac 构建长期要另想办法。每个平台构建大约 5–15 分钟，安装包大约 70–140 MB（推测）。

### 3.7 MVP 范围与风险

- **MVP**：三平台安装包；应用内官方登录拿 token → 主进程直连鹰角（移植 Worker 白名单）→ 复用现有前端的本地存储和统计 → 自动更新 → 每个安装包签发构建证明。云同步、Flatpak、米哈游游戏放到后面。
- **最大的未知数**：极验 / 风控对内置登录窗口的反应，要尽早用真机实测；扫码登录是规避路径。
- **其他风险**：macOS 年费；Windows 新签名没有 SmartScreen 信誉、Smart App Control 可能拦截；Intel Mac 构建环境 2027 年后消失；云同步的同源模型要为桌面版调整（桌面应用的来源不是官网），且仍然不能让 token 上云；安装包接近 100 MB，最好做差分更新。

---

## 四、建议的推进顺序（供讨论）

1. **先做 mhy 网页版的最小版本**：子域名、独立 Worker 和仓库，支持米游社扫码、粘贴链接、UIGF 导入导出和基本统计。它验证了接口、跨域、限速这些最大的未知数，又完全不碰 ark。
2. **再做 game**：先单向从 ark / mhy 拉取（弹窗 + 云同步），等稳定后再考虑双向和 iframe 增强。
3. **桌面版**：可以和第 1 步并行做技术验证（内置登录窗口能否稳定通过极验），正式开发放在网页版稳定之后；米哈游的“自动读缓存”是桌面版最有吸引力的功能，所以桌面版最好等 mhy 的数据层成形后再做。

## 五、需要维护者决定的事

1. mhy / game 用 kaltsit.dev 的子域名，还是另买一个中性域名。
2. 新站点上线前是否开 Workers Paid（每月 5 美元），或者放到另一个 Cloudflare 账号。
3. 米哈游的 authkey 和米游社登录凭据经过 Worker 内存转发（和鹰角 token 一样，不记录不存储）是否可以接受；是否接受维护米游社签名盐。
4. 桌面版：是否放弃 Python；是否接受 macOS 每年 99 美元；Windows 走 SignPath 还是 Microsoft Store。
5. 网页版要不要做浏览器扩展：扩展可以在鹰角官网页面里一键取 token（比书签小工具稳），但要上架各浏览器商店。
