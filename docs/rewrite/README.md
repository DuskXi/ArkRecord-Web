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
| 1 | 部署到 Cloudflare **Workers + Static Assets** | 同一个 Worker 托管 SPA，并在同域 `/api/*` 上做转发。Worker 只转发鹰角接口，**不访问 PRTS**（见 data-sources.md） |
| 2 | 计算全部在浏览器本地 | Worker 无状态，不存储、不记录 token |
| 3 | 在新分支上从零重写 | 切换前 master 保持现状 |
| 4 | 终末地只支持国服 | 国际服（Gryphline）暂不支持 |
| 5 | 使用统计改用 Cloudflare Web Analytics | 去掉旧版的 UUID 上报和页面上的“使用者”徽章 |
| 6 | UI 可以放弃 Quasar，只保留 Vue | 以美观和功能为先。选型为 Nuxt UI v4（纯 Vue 模式），备选 shadcn-vue |
| 7 | 继续使用 `ark.kaltsit.dev` 域名 | 浏览器本地数据按域名隔离；同域名才能在新版首次打开时自动迁移旧版 localStorage |
| 8 | 测试优先 | 维护者测试通过之前，只部署到测试域名 `ark-next.kaltsit.dev`，不改动正式域名 |
| 9 | Worker 只为本站服务 | 只接受同源请求，不返回 CORS 头，拒绝预检；用 Cloudflare 限速绑定加前端限速防滥用（见 design.md 第 1 节） |
| 10 | 部署走 GitHub Actions | 部署用的 Cloudflare token 存在 GitHub 仓库级 Secrets；AI 助手只用只读方式访问 Cloudflare API |

## 分阶段计划

0. **脚手架**：Vue 3.5 + Vite 8 + TS 6 + Nuxt UI v4 工程；Worker 转发骨架（白名单）；CI（lint / 类型检查 / 测试 / 构建）；元数据与头像的构建脚本；部署到预览地址，不影响线上。
1. **明日方舟核心**：新接口登录与增量同步、新数据模型（IndexedDB）、旧数据迁移与导入、总览 / 记录 / 卡池页面。完成后线上失效的同步就恢复了。
2. **终末地（国服）**：同一账号 token 换 `appCode=endfield`，按终末地规则做保底和统计。
3. **分析与分享**：精确保底分析、运气百分位、时间线、分享卡片、图鉴；源石 / 充值（需要先确认新接口）。
4. **切换线上**：`ark.kaltsit.dev` 切到新 Worker，旧数据自动迁移。

## 待确认事项

- **源石 / 充值记录的新接口**：没有任何开源实现。需要在已登录的 ak.hypergryph.com/user 页面用 DevTools 抓取请求，token 打码后提供。
- **B 服明日方舟**：已绑定到鹰角通行证的 B 服角色应该会出现在 `binding_list` 中，这一点只有部分项目验证过。
- **鹰角接口基本未经实测**（云端容器连不到鹰角域名）。目前只有终末地 `api/content` 由维护者在浏览器中实测可用（见 research.md 2.2）。其余结论来自多个 2025–2026 年仍在维护的开源实现的源码交叉核对。实测由项目维护者在本地浏览器完成，**账号 token 不要交给 AI 助手**。
- **终末地头像**：目前没有持续维护、按 ID 索引的图标源（见 data-sources.md）。
- **现有部署情况**：`ark.kaltsit.dev` / `api.kaltsit.dev` 由哪个平台托管尚未确认，等有 Cloudflare 只读权限后核查。

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
