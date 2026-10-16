# ArkRecord

明日方舟 / 明日方舟：终末地 寻访记录的本地存档与分析工具。

鹰角官方只能查询最近 90 天的寻访记录，ArkRecord 会把每次同步到的记录追加保存在你的浏览器里，长期积累，并在本地完成所有统计分析。

> 当前分支是 2.0 的全新重写版本（测试中），旧版代码保留在 `master` 分支。重构调研与设计见 [docs/rewrite](docs/rewrite/README.md)。

## 功能

- **两个游戏**：明日方舟（官服 / 已绑定通行证的 B 服）与终末地（国服），同一个鹰角通行证登录
- **保底追踪**：按游戏规则区分共享 / 独立的保底分组，显示当前垫抽、软保底区间、预计还需抽数；定向保底（150 / 300 / 120 抽）与限定池 300 抽进度
- **精确统计**：由保底规则精确计算出货分布与运气百分位，UP 胜率、各分组平均抽数、每月抽数、抽卡日历
- **时间线与分享卡片**：以 6★ 分段的时间线，一键生成分享图片
- **数据安全**：只追加不覆盖、导入前自动快照、JSON / CSV 导出、旧版数据自动迁移
- 手机与桌面自适应、深浅色、按游戏切换的主题

## 隐私

- 所有记录、统计结果和账号 token 只保存在浏览器的 IndexedDB 中，本站没有数据库或用户系统。
- 鹰角的接口不允许网页直接调用（不支持 CORS，并依赖浏览器无法设置的 Cookie），所以由同域名下的 Cloudflare Worker 原样转发。Worker 不解析、不记录、不存储任何内容，只接受本站同源请求，并有限速保护。转发清单与原因见 [`worker/upstreams.ts`](worker/upstreams.ts)，网站的“关于”页面显示同一份清单。

## 开发

需要 Node.js 22.12 以上（推荐 24）。

```bash
npm install
npm run gamedata     # 拉取干员 / 卡池元数据与头像到 public/gamedata（12 小时内会跳过，加 --force 强制）
npm run dev          # 开发服务器，Worker 同时在本地运行（Cloudflare Vite 插件）
npm test             # 单元测试
npm run lint         # oxlint
npm run typecheck    # vue-tsc
npm run build        # 拉取数据 + 类型检查 + 构建
```

在“数据”页可以载入演示数据，不登录也能查看各个页面。

## 部署

部署到 Cloudflare Workers（静态资源 + `/api/*` 转发同一个 Worker）。

- `wrangler.jsonc` 当前**只包含测试环境** `ark-next.kaltsit.dev`，正式域名的配置会在测试通过后再加。
- GitHub Actions：
  - `ci.yml`：每次 push / PR 运行 lint、类型检查、测试、构建
  - `deploy-preview.yml`：重写分支 push 后部署到测试域名
- 需要的仓库级 Actions Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`

## 目录

```
src/            前端（Vue 3 + Nuxt UI + Tailwind v4）
  lib/hg/       鹰角接口客户端
  lib/sync/     增量同步
  lib/stats/    保底模型与统计
  lib/legacy.ts 旧版数据迁移
worker/         Cloudflare Worker（转发、同源检查、限速）
scripts/        构建时的游戏数据同步脚本
docs/rewrite/   重构调研与设计文档
```

## 数据来源

[鹰角网络](https://www.hypergryph.com/)、[ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)、[ArknightsGameResource](https://github.com/yuanyan3060/ArknightsGameResource)、[PRTS](https://prts.wiki/)。

本工具为玩家自制，与鹰角网络无关。游戏内名称与图像版权归鹰角网络所有。
