# 给 AI 助手的项目说明

ArkRecord：明日方舟 / 终末地寻访记录的本地存档与统计网站（Vue 3 + Vite + TypeScript + Nuxt UI，Cloudflare Workers）。正在开发支持四款游戏的桌面版，计划见 [docs/desktop/plan.md](docs/desktop/plan.md)。

## 和维护者沟通

- **始终用中文**：回复、总结、提示框里的问题和快捷回复按钮（按钮文字和点了发出的话）都用中文。维护者发来的话是英文时（多半是点了英文按钮）也用中文回复。
- 先说结果，再说细节；不确定的地方说清楚是推测。
- 快捷回复按钮里不要预先写好“预期的结果”（比如“读完了，没有新记录”），只写动作，结果让维护者自己说，再按日志核对。

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
- 不按 IP 等标识统计用户；网页版的匿名统计只在用户选择“全部接受”后上报，演示账号不计入。
- 桌面版的统计（维护者 2026-10-19 决定）：默认开启、“关于”页可关闭，不弹 Cookie 同意；由 Python 后端上报设备随机 ID 的哈希、加盐的 UID 哈希（服务器再用 `STATS_UID_SALT` 做 HMAC 才保存），设备和 UID 分开上报、互不关联。安装版（打包发布的版本）暂不上报，等正式站有了接口、维护者同意后再开（维护者 2026-10-20 决定）。细节见 SECURITY.md 的“桌面版的使用人数统计”。
- 同步识别码（维护者 2026-10-19 决定）：第一次开通云同步时生成的随机数，随加密的同步数据上传，任何开关都不删；只用来数独立用户，网页版要“全部接受”、桌面版默认开启，单独上报加盐哈希。细节见 SECURITY.md 的“同步识别码的统计”。
- 改动服务器接触敏感信息的方式时，同步更新 SECURITY.md。

## 本地环境（Windows）

- Node 要求 22.12 以上（`package.json` 的 `engines`）。用 nvm-windows 时**不要 `nvm use`**：它改的是全局链接，会影响本机所有程序。
- 改为只在当前进程把 Node 22 放到 PATH 最前面：`$env:PATH = "$env:LOCALAPPDATA\nvm\v22.21.1;$env:PATH"`（nvm 目录用 `nvm root` 查，版本号按实际安装的）。
- AI 助手每次执行命令都是新的 shell，PATH 不会保留：每条用到 node / npm / npx 的命令前都加上这一行。装依赖用 Node 22 自带的 npm。

## 提交前

- `npm test`、`npm run lint`、`npm run typecheck`；改了 Worker 或构建配置时再跑 `npm run build`。
- 发布新版本时按 docs/rewrite/README.md 的流程改版本号、写更新公告。
