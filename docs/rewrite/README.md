# ArkRecord 重构计划（2026-10）

这个目录记录 ArkRecord-Web 重构前的调研与设计结论。调研时间为 2026-10-16。

| 文档 | 内容 |
|---|---|
| [research.md](research.md) | 明日方舟与终末地的新抽卡接口、保底规则 |
| [data-sources.md](data-sources.md) | 干员 / 卡池元数据和头像图片的来源（含 PRTS 现状） |
| [design.md](design.md) | 架构、技术栈、数据模型、UI 与功能设计 |

## 已确定的决策

| # | 决策 | 说明 |
|---|---|---|
| 1 | 部署到 Cloudflare **Workers + Static Assets** | 同一个 Worker 托管 SPA，并在同域 `/api/*` 上做转发。Worker 转发鹰角接口；图片尽量在构建时镜像为静态文件，构建时拿不到的少量图片（新干员头像、终末地卡池图）经 Worker 转发并缓存在 Cloudflare（见 data-sources.md 第 4 节） |
| 2 | 计算全部在浏览器本地 | Worker 无状态，不存储、不记录 token |
| 3 | 在新分支上从零重写 | 切换前 master 保持现状 |
| 4 | 终末地只支持国服 | 国际服（Gryphline）暂不支持 |
| 5 | 使用统计：Cloudflare Web Analytics（访问量，后台查看）+ 站内匿名用户数 | 去掉旧版的 UUID 上报和 KV（人数越多越慢）。新版用 Durable Object + SQLite 只维护计数器，去重在浏览器本地完成，不上传任何标识符；首次打开时说明，关于页公开全部细节并可关闭（见 design.md 第 1 节） |
| 6 | UI 可以放弃 Quasar，只保留 Vue | 以美观和功能为先。选型为 Nuxt UI v4（纯 Vue 模式），备选 shadcn-vue |
| 7 | 继续使用 `ark.kaltsit.dev` 域名 | 浏览器本地数据按域名隔离；同域名才能在新版首次打开时自动迁移旧版 localStorage |
| 8 | 测试优先 | 维护者测试通过之前，只部署到测试域名 `ark-next.kaltsit.dev`，不改动正式域名 |
| 9 | Worker 只为本站服务 | 只接受同源请求，不返回 CORS 头，拒绝预检；用 Cloudflare 限速绑定加前端限速防滥用（见 design.md 第 1 节） |
| 10 | 部署走 GitHub Actions | 部署用的 Cloudflare token 存在 GitHub 仓库级 Secrets；AI 助手只用只读方式访问 Cloudflare API |
| 11 | 版本号进一个大版本 | 旧版为 v0.1.0.1_alpha；新版测试期为 1.0.0-beta.N，正式发布为 1.0.0。导出文件的格式版本（v2.0）与程序版本号无关 |

## 进度（2026-10-16）

- [x] 阶段 0：新工程、Worker（同源检查 + 限速 + 白名单）、CI、测试环境部署工作流
- [x] 阶段 1：明日方舟新接口与增量同步、数据模型、旧数据迁移、各页面
- [x] 阶段 2（初版）：终末地国服同步与保底规则（待真实账号测试）
- [x] 阶段 3（部分）：分析、时间线、分享卡片
- [x] 寻访记录改版（按十连 / 单抽分组的卡片视图、筛选汇总、高星级染色）；新增“高级统计”页（纪录、6★ 出货序列、十连、抽卡时段、收集、抽卡规划）
- [x] 终末地卡池元数据：卡池类型、UP 名单（含已下线的旧卡池）取自游戏数据表
- [x] 终末地头像与武器图标：BWIKI 为主、森空岛为备，另有手动指定文件（见 data-sources.md 3.2）
- [x] 明日方舟干员名单、UP 名单、头像以 PRTS 为主，GitHub 为备（卡池类型和时间只有游戏数据里有，见 data-sources.md 2.4）
- [x] 终末地角色池与武器池分开查看（标题栏切换，默认角色）；武器池只显示保底进度，不做概率推算
- [x] 高级统计改为内部 Tab（纪录 / 出金分析 / 时段 / 收集 / 规划，终末地叫“出红”）；新增 6★ 抽数分布、歪不歪的概率分布（泊松二项分布精确计算）、欧非走势、出 6★ 时段与各时段出 6★ 的比例；热力图改为分档配色。用词：明日方舟 6★ 叫“出金”，终末地叫“出红”
- [x] 老用户首次打开新版时自动导入旧数据，显示进度与结果；数据页写明支持的三种旧版格式
- [x] 站内匿名用户数：侧栏与关于页显示累计用户、今日活跃等
- [x] 第一次访问的引导：中央的欢迎窗口（网站介绍与高级统计）→ 旧数据迁移（有旧数据时）→ 底部的统计同意（“全部接受”= 本站匿名统计 + Cloudflare Web Analytics，“仅必要”= 只有本地存储）；选择之前不启用任何统计。Cloudflare Web Analytics 改为同意后由网页加载，需要在 Cloudflare 后台关闭自动注入
- [x] 明日方舟源石 / 充值：从官网用户中心的代码中确认了新接口（见 research.md 1.6），每次同步顺便保存；与旧版记录统一去重；新增“源石与充值”页（收支汇总、源石数量变化、每月充值）
- [x] 测试环境已部署到 https://ark-next.kaltsit.dev（2026-10-16，GitHub Actions）。已验证：安全响应头、SPA 回退、元数据与头像、同源检查（预检 405、缺少标记头 / 跨站 403、白名单外 404）、浏览器内同源请求可用而其他网站的页面被浏览器拦截、经 Worker 访问鹰角接口可达、Cloudflare 限速会触发
- [x] 真实账号端到端测试（维护者在测试域名完成，含旧数据导入）
- [x] 干员图鉴（按寻访记录标出抽到过的干员 / 终末地武器，声明可能不全）；用词：明日方舟“出金”、终末地“出红”
- [x] 旧版保留在正式域名的 `/legacy/`（与新版同源，能读到旧版留在浏览器里的数据，见 `scripts/build-legacy.sh`）；迁移弹窗、数据页、关于页说明遇到问题时可以从旧版手动导出再导入
- [x] 阶段 4：切换正式域名（2026-10-16 发布 1.0.0，Worker arkrecord 接管 ark.kaltsit.dev；Pages 项目 arkrecord-web 已移除自定义域名并关闭自动部署，保留 arkrecord-web.pages.dev）
- [ ] 仓库识别：上传截图（森空岛 App 的干员列表、游戏里的仓库），识别后同步账号里实际拥有的干员和物品，补全图鉴
- [ ] 电脑应用：可以安装到电脑上、离线查看本地记录
- [ ] 加密同步：浏览器端加密后上传，服务器不保存任何密钥、只存放和转发密文；换设备后输入密码才能解密；忘记密码无法恢复，所以本地保存仍然必要

## 部署所需的密钥

部署由 GitHub Actions 完成（`.github/workflows/deploy-preview.yml`），需要在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加**仓库级** Secrets：

| 名称 | 内容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 部署专用的 Cloudflare API token（见下） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID（后台右侧栏或 URL 中可见） |

部署 token 的创建：Cloudflare 后台 → My Profile → API Tokens → Create Token → 模板 **Edit Cloudflare Workers**，然后：
- Account Resources：只选自己的账号
- Zone Resources：只选 `kaltsit.dev`
- 可以删掉模板里用不到的权限：Workers KV Storage、Workers R2 Storage、Workers Tail
- 保留：Account Settings Read、Workers Scripts Edit、Workers Routes Edit（创建自定义域名 `ark-next.kaltsit.dev`、`ark.kaltsit.dev` 需要）、User Details Read、Memberships Read

## 正式环境

| | 测试环境 | 正式环境 |
|---|---|---|
| 域名 | ark-next.kaltsit.dev | ark.kaltsit.dev |
| Worker | arkrecord-next | arkrecord |
| 配置 | `wrangler.jsonc` 顶层 | `wrangler.jsonc` 的 `env.production`（构建时 `CLOUDFLARE_ENV=production`） |
| 部署 | `deploy-preview.yml`：推送开发分支 | `deploy-production.yml`：推送 master、推送 `v*` 标签、手动运行（定时更新游戏数据暂未开启） |

两个 Worker 的限速计数和使用人数统计互不影响。旧版网页在 `/legacy/`，由 `scripts/build-legacy.sh` 从 `legacy-v0.1` 分支（合并前的 master）上的旧代码构建，产物提交在 `public/legacy/`。

首次切换：`ark.kaltsit.dev` 原来是 Cloudflare Pages 项目 `arkrecord-web` 的自定义域名，需要先在 Pages 项目里移除这个域名，并删除 DNS 里指向 `arkrecord-web.pages.dev` 的 CNAME 记录，Worker 才能接管这个域名。

## 分阶段计划

0. **脚手架**：Vue 3.5 + Vite 8 + TS 6 + Nuxt UI v4 工程；Worker 转发骨架（白名单）；CI（lint / 类型检查 / 测试 / 构建）；元数据与头像的构建脚本；部署到预览地址，不影响线上。
1. **明日方舟核心**：新接口登录与增量同步、新数据模型（IndexedDB）、旧数据迁移与导入、总览 / 记录 / 卡池页面。完成后线上失效的同步就恢复了。
2. **终末地（国服）**：同一账号 token 换 `appCode=endfield`，按终末地规则做保底和统计。
3. **分析与分享**：精确保底分析、运气百分位、时间线、分享卡片、图鉴；源石 / 充值。
4. **切换线上**：`ark.kaltsit.dev` 切到新 Worker，旧数据自动迁移。

## 待确认事项

- **源石 / 充值记录**：接口来自官网代码（research.md 1.6），返回字段按官网页面的用法推断，需要用真实账号确认。
- **B 服明日方舟**：已绑定到鹰角通行证的 B 服角色应该会出现在 `binding_list` 中，这一点只有部分项目验证过。
- **鹰角接口基本未经实测**（云端容器连不到鹰角域名）。目前只有终末地 `api/content` 由维护者在浏览器中实测可用（见 research.md 2.2）。其余结论来自多个 2025–2026 年仍在维护的开源实现的源码交叉核对。实测由项目维护者在本地浏览器完成，**账号 token 不要交给 AI 助手**。
- **终末地头像**：目前没有持续维护、按 ID 索引的图标源（见 data-sources.md）。
- **现有部署情况**（2026-10-16 只读核查）：`ark.kaltsit.dev` 是 Cloudflare Pages 项目 `arkrecord-web`（生产分支 `master`，构建命令 `quasar build`）；`api.kaltsit.dev` 是 Worker `ak`（对所有网站开放 CORS 的旧转发）；`statistics.kaltsit.dev` 是 Worker `arkrecord-extension`。切换正式域名时需要先从 Pages 项目上移除 `ark.kaltsit.dev`，并处理 master 合并后 Pages 会自动触发旧构建的问题（已处理：域名已移除、Pages 自动部署已关闭；新版于 2026-10-16 合并进 master，旧代码保存在 `legacy-v0.1` 分支）。
- **Cloudflare Web Analytics**：测试域名的页面已被 Cloudflare 自动注入统计脚本（`static.cloudflareinsights.com`），CSP 已放行，无需改代码。

## 给 AI 助手 Cloudflare 只读权限的方式

1. Cloudflare 后台 → My Profile → API Tokens → Create Token → Custom token，所有权限只选 **Read**：
   - Account（资源只选自己的账号）：Account Settings、Cloudflare Pages、Workers Scripts、Workers CI
   - Zone（资源只选 kaltsit.dev）：Zone、DNS、Zone Settings、Workers Routes、SSL and Certificates
   - **不要**给 Logs 和 Workers Tail（日志里可能有用户的 token）
   - 设置结束日期（TTL）。云端容器的出口 IP 不固定，IP 过滤意义不大。
2. 在云端环境设置（会话标题栏的环境菜单 → Edit）里：
   - token 放进 Network secrets（如果有这个选项），否则作为环境变量 `CLOUDFLARE_API_TOKEN`；另加 `CLOUDFLARE_ACCOUNT_ID`。
   - Network access 的 Allowed domains 加上 `api.cloudflare.com`、`ark.kaltsit.dev`、`api.kaltsit.dev`、`statistics.kaltsit.dev`。
3. 新开会话后生效。用完在 Cloudflare 后台删除这个 token。

注意：Cloudflare 的 Workers 权限只有“编辑”一档，没有只读档。AI 助手对 Cloudflare API 只发 GET 请求，不用这个 token 部署或修改任何资源。

部署用的写权限 token 单独创建，存放在 GitHub 仓库级 Secrets 中，由 GitHub Actions 使用。
