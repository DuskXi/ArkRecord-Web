# 给 AI 助手的项目说明

ArkRecord：明日方舟 / 终末地寻访记录的本地存档与统计网站（Vue 3 + Vite + TypeScript + Nuxt UI，Cloudflare Workers）。正在开发支持四款游戏的桌面版，计划见 [docs/desktop/plan.md](docs/desktop/plan.md)。

## 和维护者沟通

- 用中文回复。
- 先说结果，再说细节；不确定的地方说清楚是推测。

## 先读这些

- [README.md](README.md)：功能、目录结构、开发命令。
- [docs/rewrite/README.md](docs/rewrite/README.md)：设计决定、发布流程（版本号、更新公告的“正式更新 / 小更新”）、给搜索引擎和 AI 的文件。
- [SECURITY.md](SECURITY.md)：服务器接触敏感信息的全部位置、线上代码的公开核对。
- [docs/research/](docs/research/)：米哈游系站点、多站点数据互通、桌面版的调研。

## 部署

- 测试站 https://ark-next.kaltsit.dev ：推送到开发分支后由 GitHub Actions 自动部署。
- 正式站 https://ark.kaltsit.dev ：只从 master 部署，经 PR 压缩合并。**维护者明确同意之前不发布到正式站。**
- 每次部署后会自动核对线上文件和 Worker 代码（`scripts/audit/`），失败时先看运行摘要。

## 安全规则（必须遵守）

- 不在对话里索要、粘贴或复述任何凭据：鹰角 token、u8 token、Cookie、米游社 stoken / ltoken / cookie_token、authkey、云同步密码。调试时只看状态码、条数和错误码，日志和输出里的凭据必须脱敏。
- 不把真实的寻访 / 抽卡数据（含 UID、昵称）提交进仓库，测试用脱敏或合成的样本。维护者的截图也不提交。
- Cloudflare API：环境变量里的 token 只做只读调用（Workers 权限只有“管理员”一档，必须自律）。不输出账号 ID、账号邮箱等信息。Analytics 的 GraphQL 查询可以用。
- 不按 IP 等标识统计用户；匿名统计只在用户选择“全部接受”后上报，演示账号不计入。
- 改动服务器接触敏感信息的方式时，同步更新 SECURITY.md。

## 提交前

- `npm test`、`npm run lint`、`npm run typecheck`；改了 Worker 或构建配置时再跑 `npm run build`。
- 发布新版本时按 docs/rewrite/README.md 的流程改版本号、写更新公告。
