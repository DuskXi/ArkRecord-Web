# 重构设计（2026-10-16）

## 1. 总体架构

```
浏览器（所有计算都在本地）
  Vue 应用 ── Pinia ── Dexie（IndexedDB）：长期存档、快照、设置
     │          └── Web Worker：统计引擎（保底精确计算）、导入解析
     ├── 同源静态资源：/meta/ak-meta.json、/meta/ef-meta.json、/assets/avatars/*.webp（每日 CI 生成）
     ├── /api/hg/*  ──►  Cloudflare Worker（无状态，只转发）──► 鹰角白名单域名
     └── 图片兜底：浏览器直连 torappu.prts.wiki → media.prts.wiki
```

### Worker 的职责（且只有这些）

- 按白名单把 `/api/hg/{上游别名}/{路径}` 转发到鹰角域名，只放行列出的路径前缀和 HTTP 方法，其他请求一律拒绝。
- 请求头 `x-cookie` → `Cookie`（只放行 `ak-user-center`）；响应 `Set-Cookie: ak-user-center` → 同源可读的响应头 `x-ak-user-center`。
- 不存储、不记录请求体和 token；不打印请求内容。
- 不解析业务数据，不访问 PRTS。

### 防滥用：只为本站服务

前端与 `/api/*` 同源，因此**完全不需要 CORS**。Worker 的规则如下：
- **只接受本站发出的请求**：
  - `Sec-Fetch-Site` 存在时必须为 `same-origin`；
  - `Origin` 存在时必须等于本站 origin（每个部署环境单独配置）；
  - 两者都缺失时（较旧的浏览器）退回检查 `Referer`，必须来自本站页面，否则拒绝。
- **不返回任何 CORS 头**；`OPTIONS` 预检请求一律返回 405。其他网站无法通过浏览器借用这个转发。
- **限速**：
  - Cloudflare Workers Rate Limiting 绑定，认证类和数据类接口分开计数。IPv4 按单个地址、IPv6 按 /64 前缀为键（一个用户通常分到整个 /64，按完整地址计数容易绕开）；
  - 前端同步时主动控制节奏，正常使用不会触发限速。

  该绑定按机房分别计数、计数只保证最终一致，所以它是“防滥用”，不是精确计费。测试环境实测（2026-10-16）：限速确实会触发，但在 10 秒内的并发突发下拦截得很宽松。如果需要更严格的上限，可以在 kaltsit.dev 域名的 WAF 中再加一条 Rate limiting rule（免费套餐有 1 条，按 IP、10 秒窗口），匹配 `ark-next.kaltsit.dev` 的 `/api/hg/` 路径。
- **严格限制请求**：方法 + 路径前缀白名单、请求体大小上限（4 KB）、只转发白名单内的请求头；响应统一加 `Cache-Control: no-store`。
- 浏览器请求头可以被脚本伪造，所以来源检查只能挡住“其他网站借用”。针对脚本滥用，靠限速和白名单兜底；以后需要时可以再加 Turnstile。

### 匿名使用人数统计

旧版为每个浏览器生成 UUID 存进 KV，统计人数要列出全部键，用户越多越慢。新版：
- **只维护计数器**：全站一个 Durable Object（SQLite 存储），表 `counters(scope, key, value)`，scope 为 `all` / `day:日期` / `month:月份`。每次上报是几条 UPSERT，读取是一条按主键范围的查询，耗时与用户数无关；汇总接口在 Cloudflare 边缘缓存 5 分钟。
- **去重在浏览器本地**：localStorage 记住今天、本月是否已上报，每天最多一次。上报只有 `first`、`newMonth`、`games`、`newGames` 四个字段，不含账号、UID、记录或任何标识符；服务端不保存 IP（只用于限速）。
- **知情与选择**：第一次打开时弹出说明，说明消失后才会第一次上报；关于页列出全部细节并可关闭，关闭后不再发出任何请求。
- **局限**：换浏览器或清除数据会被算作新用户，“累计用户”实为浏览器数。

Worker 与前端放在同一个开源仓库，页面上“不上传你的数据”的承诺可以被验证。

### 源码标注要求：写明为什么必须转发

Worker 的存在**只是因为上游接口不允许浏览器直接请求**，不是为了获取任何信息。这一点必须在源码里写清楚：
- 白名单文件顶部写总体说明；
- 每个上游条目写明具体原因（CORS 被拦截，或需要浏览器无法设置的 Cookie），以及实测日期和方式；
- 尚未实测的条目标注“未实测”，测到后再更新；
- 应用内的“关于与透明度”页面列出同样的上游清单和原因。

模板：

```ts
// worker/upstreams.ts
//
// Worker 允许转发的全部上游。
//
// 为什么需要转发：下列鹰角接口不允许浏览器跨域（CORS）请求，或者依赖浏览器 JS
// 无法设置 / 读取的 Cookie，网页无法直接调用。转发只为绕过这一浏览器限制，
// 不是为了获取任何信息：Worker 不解析、不记录、不存储任何请求或响应内容（包括 token），
// 所有数据处理都在用户浏览器本地完成。
export const UPSTREAMS = [
  {
    host: 'ef-webview.hypergryph.com',
    paths: ['/api/content', '/api/record/'],
    // 原因：响应不带 Access-Control-Allow-Origin，浏览器请求被 CORS 拦截。
    // 实测：2026-10-16，从 https://www.bilibili.com 发起 fetch，上游返回 200 但被浏览器拦截。
  },
  {
    host: 'ak.hypergryph.com',
    paths: ['/user/api/role/login', '/user/api/inquiry/gacha/'],
    // 原因：响应不带 Access-Control-Allow-Origin（2026-10-16 实测，上游返回 401 但被浏览器拦截）；
    // 另外数据接口依赖 Cookie ak-user-center，浏览器 JS 无法设置 Cookie，也读不到 Set-Cookie。
  },
  // as.hypergryph.com、binding-api-account-prod.hypergryph.com 同理，逐条写明原因和实测情况。
] as const
```

## 2. 技术栈

| 层 | 选择 | 理由 |
|---|---|---|
| 框架 | Vue 3.5 + Vite 8 + TypeScript 6 + vue-router 5 + Pinia 4 | TypeScript 7（Go 实现）已发布，但 vue-tsc / typescript-eslint 生态尚未跟上 |
| UI | **Nuxt UI v4（纯 Vue 模式）**，基于 Reka UI + Tailwind v4 | 外观现代、可深度定制主题；自带虚拟滚动表格、命令面板、抽屉、日期区间、仪表盘侧栏。不需要 Nuxt：`@nuxt/ui/vite` + `@nuxt/ui/vue-plugin` |
| UI 备选 | shadcn-vue（同样是 Reka + Tailwind） | 组件代码复制进仓库自己维护，两者迁移成本低 |
| 弃用 Quasar | — | CSS 是 215 KB 的整体文件，没有 `@layer`，`.flex` / `.hidden` 会压过 Tailwind；视觉停留在 Material 2；没有官方 MD3 |
| 图表 | ECharts 6 + vue-echarts 8 | Apache-2.0；交互最丰富（日历热力图、dataZoom）；按需引入。ApexCharts 已改为限制性许可，PrimeVue 5 也改成了商业双许可，两者都不用 |
| 本地存储 | Dexie 4 + `navigator.storage.persist()` | 替代 localStorage（5 MB 上限、同步阻塞） |
| 表格 | Nuxt UI `UTable`（TanStack Table v8 + virtual） | 1 万行以上的记录也流畅；与 Nuxt UI 用同一份依赖 |
| 分享图 | @zumer/snapdom（懒加载），modern-screenshot 备选 | 替代停更的 html2canvas；头像同源后不再有跨域问题 |
| 动效 / 图标 | motion-v；Iconify（unplugin-icons，本地打包） | 不在运行时请求 Iconify API，国内可用、可离线 |
| PWA | vite-plugin-pwa 2（`registerType: 'prompt'`） | 可安装、可离线查看本地数据 |
| 字体 | MiSans VF（中文，按 unicode-range 分片自托管）+ 窄体数字字体（Barlow Condensed / Oxanium）+ `tabular-nums` | 国内无法使用 Google Fonts，必须自托管 |
| 日期 / 杂项 | `Intl.DateTimeFormat`（`Asia/Shanghai`）+ date-fns 4；js-md5（Web Crypto 不支持 MD5） | |
| 测试 / 质量 | Vitest 5 + @vue/test-utils，Playwright；oxlint + oxfmt + vue-tsc | |
| Node | 24 LTS | |

注意事项：
- Nuxt UI 依赖 TanStack Table v8 和 @vueuse/core v14，我们要固定在同一大版本，避免打包两份。
- 深色模式需要在 `index.html` 内联脚本里设置主题并写 `color-scheme`，避免首屏闪白。
- Workers 的 SPA 回退会对缺失的旧 chunk 返回 `index.html`，需要监听 `vite:preloadError` 后刷新页面。
- `/assets/*` 设置 `immutable` 长缓存；`sw.js`、`index.html` 保持默认缓存策略。
- Web Share 的文件分享在微信、QQ、B 站内置浏览器（Android WebView）和 Firefox 中都不可用，必须同时提供“下载”和“长按保存”。

## 3. 数据模型

```ts
// 明日方舟：一抽一条
interface AkPull {
  key: string          // `${poolId}:${charId}:${gachaTs}:${pos}`；旧数据见第 5 节
  uid: string          // 游戏角色 uid
  poolId: string | null
  poolName: string
  category?: string    // gacha/cate 的 id
  charId: string | null
  charName: string
  rarity: number       // 与接口一致，0 起（5 = 6★）
  isNew: boolean
  gachaTs: number      // 毫秒
  pos: number
  source: 'api' | 'legacy' | 'import'
}

// 终末地：角色与武器
interface EfPull {
  key: string          // `${type}:${seqId}`（seqId 在角色 / 武器间是否唯一待验证，先保守加上 type）
  uid: string
  type: 'char' | 'weapon'
  poolId: string
  poolName: string
  poolType?: string
  itemId: string       // charId 或 weaponId
  itemName: string
  rarity: number       // 4–6
  isNew: boolean
  isFree: boolean
  kind: string         // 'draw' 或 'gift_*'
  gachaTs: number
  seqId: string
  source: 'api' | 'import'
}
```

- 存档**只追加**：每个类别 / 卡池维护一个最新记录位置，增量同步到已有记录即停止。
- 导入、清空、恢复之前先自动做快照。
- 账号表：`{game, uid, nickName, channel, isOfficial}`。
- 账号 token 只存在本地，默认导出时不包含。

## 4. 统计引擎（Web Worker，本地精确计算）

- **保底分组**：明日方舟按 `gachaRuleType` 分为标准 / 中坚 / 独立三组；终末地按限定共享 80 抽、单池 120 抽、武器池、常驻、新手分别计数。规则见 research.md。
- **出 6★ 所需抽数的精确分布**：把逐抽概率代入马尔可夫链 / 动态规划计算。
  - 明日方舟期望 34.59 抽，中位数 35 抽；终末地期望 53.90 抽，中位数 67 抽。
- **运气百分位**：用户实际出 6★ 的抽数序列（当前未出的垫抽作为截尾数据）与理论分布卷积后比较，得出“比 X% 的玩家更欧”。全部在本地计算，不依赖服务器上的全服数据；据调研，目前没有其他工具这样做。
- **其他指标**：
  - 当前垫抽数及“预计还需 N 抽”（条件分布的中位数和 90% 区间）；
  - UP 胜率（不歪率）；
  - 定向保底（150 / 300 / 120）和限定 300 抽进度；
  - 每 6★ / 每 UP 6★ 的平均抽数；
  - 花费换算：明日方舟每抽 600 合成玉，终末地按其货币换算。
- 样本太少时不显示百分比；每个指标都有说明。

## 5. 旧数据迁移

- 新版沿用 `ark.kaltsit.dev`。首次打开时读取旧版 localStorage（`UserDataSet`、`tokens`、`active`、`charactersInformation` 等）并迁移：
  - 旧记录 `{timestamp(秒), pool, result:[{name, rarity, isNew}]}` → 拆成单抽；
  - `gachaTs = timestamp × 1000`，`pos` 取数组下标；
  - `charId` 由 character_table 按名字反查，重名时结合时间和是否可获得判断；
  - `poolId` 按“卡池名 + 时间落在 openTime 到 endTime 之间”在 gacha_table 中匹配；
  - 旧的源石 / 充值数据原样保留。
- 与接口数据重叠的约 90 天，用 `(秒级时间, 序号, 干员名)` 跨格式去重。
- 旧版存下的 token 就是账号 token，可尝试直接用于新流程（有效期未知）。
- 同时支持导入旧版导出的 JSON（`dataBody` 格式和更早的 `poolsData` 格式）。

## 6. 导入导出

- 没有明日方舟 / 终末地的通用标准；UIGF 4.2 只覆盖米哈游的游戏。
- 自定义带版本号、仿 UIGF 结构的格式：
  - 顶层 `info` 含 `export_app`、`export_app_version`、`export_timestamp`、`version`；
  - 按游戏分为 `arknights[]` 和 `endfield[]` 两个数组，每个元素是 `{uid, channel, timezone: 8, lang, list}`；
  - 记录**保留接口原始字段名和类型**，另加 `source` 字段；
  - 发布 JSON Schema，并为导入导出编写往返测试。
- 另提供 CSV / XLSX 导出。
- 导入适配器：旧版 ArkRecord，以及按需支持 arklog、ArkScreen、AceDroidX、PROTORIG、headhunt、bhaoo、MoguJunn 的格式。

## 7. UI 与功能设计

### 7.1 取舍：去其糟粕

| 旧功能 / 做法 | 处理 |
|---|---|
| 6 个标签页各自从 localStorage 重新读取和解析 | 统一数据层（Dexie + Pinia + Worker 派生计算） |
| “出货所需 = 1 / 概率”、二项分布“欧非度”、拟合期望公式（41.12 抽，实际应为 34.59） | 删除，改为第 4 节的精确统计 |
| 抓取 PRTS「干员一览」和「卡池一览」HTML（cheerio） | 删除，改用构建时生成的结构化数据 |
| html2canvas 整页截图（反复修复图片丢失） | 改为专门设计的分享卡片 |
| 从 GitHub 分支拉取作者通讯，从扩展仓库拉取 release 说明 | 改为应用内置的更新日志 |
| UUID 上报和“使用者”徽章 | 改用 Cloudflare Web Analytics（无 Cookie） |
| Debug 页面直接显示全部 localStorage | 改为数据中心里的“诊断信息导出” |
| `/IndexBackup` 路由、Popup 页、`src-bex` 扩展代码 | 从网页版移除 |
| 按 token 长度判断官服 / B 服 | 由 binding_list 返回的渠道判断 |
| 每页都铺满背景图 | 改为可选的个性化设置，主要用于分享卡片 |

### 7.2 保留：取其精华

- 本地长期存档（核心价值）
- 多账号
- **时间线**：折叠 3/4/5★ 连段，保留头像
- 新干员高亮
- 按卡池时段拆分常驻池并配卡池图（改由 gacha_table 驱动）
- 截图分享与自定义背景（升级为分享工作室）
- JSON / CSV 导入导出
- 源石收支汇总、源石数量变化、每月充值（“源石与充值”页，仅明日方舟）

### 7.3 新增功能

**必须有**
1. 每个保底分组一张卡片：当前垫抽、软保底区间、硬保底上限、定向保底和 300 抽进度、预计还需抽数。
2. 6★ 出货墙：每个 6★ 带保底进度条，以及 UP / 歪 / NEW / 免费标签。
3. 精确统计：UP 胜率、平均抽数、运气百分位，并附指标说明。
4. 寻访记录表：虚拟滚动，按卡池、星级、日期、名字筛选，十连分组，按 6★ 分段。
5. 安全的数据管理：导入前快照、持久化存储申请、备份提醒、恢复时对比后再合并、防止把一个账号的数据导入到另一个账号。
6. 同步体验：显示每个类别、每一页的进度；失败可重试；token 失效时引导重新登录。
7. 终末地（国服）支持。
8. 手机优先的响应式布局、深色模式、PWA。

**应该有**

9. 卡池历史：卡池图卡片、每期抽数、是否拿到 UP、花费。
10. 图鉴：已获得的干员 / 武器、获得次数、首次获得时间、尚未获得的 6★。
11. 分享工作室：多种模板（本期总结、年度报告、6★ 出货墙、时间线长图），可隐藏 uid，按游戏切换主题，可选 9:16 / 1:1 比例，导出 PNG、Web Share 或复制。
12. 抽卡日历热力图、按月统计。
13. 森空岛扫码登录，免去手动复制 token。
14. 命令面板（⌘K）：快速切换账号、跳转、搜索干员。

**可以有**

15. 不经过我们服务器的可选同步（WebDAV）。
16. 攒抽规划器 / 抽卡模拟器。
17. 截图 OCR 补录 90 天以前的记录。
18. 浏览器扩展形式的一键获取 token（可复用 `src-bex` 的思路）。

### 7.4 信息架构

```
顶栏 / 侧栏：游戏切换（明日方舟 | 终末地，切换时换主题色）· 账号切换 · 同步按钮与状态 · ⌘K
├── 总览     保底卡片、数字卡片（总抽数 / 6★ 数 / 平均抽数 / 不歪率 / 运气百分位）、最近 6★、当前卡池
├── 记录     寻访记录表（桌面）/ 卡片列表（手机），筛选、分段、导出所选
├── 卡池     卡池历史网格 → 卡池详情（统计 + 该池时间线）
├── 分析     出货分布对比理论分布、UP 胜率、星级分布、热力图、花费
├── 源石与充值  收支汇总、源石数量变化、每月充值、明细（仅明日方舟）
├── 图鉴     干员 / 武器收集情况
├── 分享     时间线与分享卡片工作室
└── 数据     账号、同步、导入导出、快照与备份、存储状态、诊断；设置（主题、背景、隐私、关于与透明度说明）
```

- 桌面：可折叠侧栏加内容区，总览页采用 bento 网格。
- 手机：底部导航放 5 个入口（总览 / 记录 / 分析 / 分享 / 我的），游戏和账号切换放在顶栏的底部抽屉里。

### 7.5 视觉方向

- 两套主题令牌，随游戏切换：
  - **罗德岛（明日方舟）**：单色工业风，细分隔线，冷色强调色，中文旁配宽字距的大写英文标签。
  - **终末地**：`#FFFA00` 配 `#0A0A0A`，面板 `#141414`，边框 `#333`，零圆角，区块标题用 `// 01` 编号。
- 星级色（各工具基本一致）：6★ 橙 `#FF8A32`，5★ 金 `#FFD036`，4★ 紫 `#7A45E8`，3★ 灰 `#9AA3AB`。
- 字体：MiSans VF 配窄体数字字体；数字使用等宽数字。
- 浅色、深色都要做好；动效克制。

## 8. CI/CD 与统计

- **GitHub Actions**（部署用的 Cloudflare token 存在 GitHub 仓库级 Secrets 中）：
  - 每次 push / PR：lint、类型检查、测试、构建；
  - 重写分支 push 后：构建并部署到**测试域名**（`ark-next.kaltsit.dev`）；
  - 构建时从 GitHub 拉取最新的游戏数据和头像，所以每次部署都带上最新元数据；每日定时任务只重新部署测试环境。
- **测试优先**：新功能先部署到测试域名，维护者测试后再合并进 master 部署到正式域名（2026-10-16 起正式域名已切换到新版）。
  - Wrangler 配置里**默认环境就是测试环境**；正式环境在构建时设置 `CLOUDFLARE_ENV=production`（deploy-production.yml）。
- **Wrangler 配置**：`assets.not_found_handling = "single-page-application"`，`run_worker_first = ["/api/*"]`，各环境分别配置自定义域名、允许的 origin 和限速命名空间。
- **使用统计**：本站匿名使用人数统计（Durable Object 计数器，见 worker/stats.ts）与 Cloudflare Web Analytics（不使用 Cookie）。两项都只在用户在统计同意里选择“全部接受”后启用（src/lib/consent.ts）；“仅必要”只保留本地存储。Cloudflare Web Analytics 由网页在同意后加载（src/lib/analytics.ts），Cloudflare 后台需要关闭自动注入。

## 9. 风险

- 所有用户的请求都从 Cloudflare 的 IP 发出，可能触发鹰角的频率限制或风控。缓解：前端限速、退避重试、浏览器 UA；Cloudea 的工具用同样的架构正常运行。
- 鹰角接口可能再次变更：接口层单独做成模块，并用记录下来的样例响应（fixture）做测试。
- 头像和卡池图版权归鹰角：同人工具的常见做法，风险较低，在页面中注明来源。
- 依赖 weedy.prts.wiki 获取 UP 名单：失败时降级，不阻塞构建。
