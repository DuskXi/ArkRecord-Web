# 元数据与图片来源调研（2026-10-16）

> PRTS 与鹰角相关域名在本环境中均不可达，下面的结论来自克隆的仓库、GitHub 源码与提交记录，以及可访问的 raw.githubusercontent。标注「第三方说法」的内容只确认了相关陈述存在，没有验证实际行为。

## 1. PRTS 现状：路径确实变了

- 正文站：`prts.wiki`（`/w/`、`api.php`），MediaWiki 1.43。
- 资源主机：`media.prts.wiki`、`torappu.prts.wiki`、`static.prts.wiki`、`weedy.prts.wiki`（PRTS 官方 `MooncellWiki/prts-widgets` 的 `src/utils/consts.ts`）。
- 上传图片已迁到 **`media.prts.wiki`**。md5 规则没变，但去掉了 `/images/` 前缀：
  ```
  旧：https://prts.wiki/images/{md5[0]}/{md5[0:2]}/{文件名}
  新：https://media.prts.wiki/{md5[0]}/{md5[0:2]}/{URL 编码的文件名}
  ```
  PRTS 自家组件在 2024-04 切换。文件名里的 `+`、`#`、空格要编码。
- 按 charId 取头像：`https://torappu.prts.wiki/assets/char_avatar/{charId}.png`。PRTS 自家前端也是先用 torappu，失败再回退到 media 的按名字 md5 路径（`src/utils/charImage.ts`）；刚实装的干员可能暂时缺图。
- CORS：torappu 与 media 返回 `Access-Control-Allow-Origin: *`；`static.prts.wiki` 有 Referer 防盗链（第三方说法）。图片标签建议加 `crossorigin="anonymous" referrerpolicy="no-referrer"`。
- **服务端访问会被拦截**（第三方说法，均出自 PRTS 维护者或其他项目的提交）：
  - prts.wiki 前有 WAF，拦截非浏览器 TLS 指纹和数据中心 IP；
  - media.prts.wiki 托管在国内，从 Cloudflare 边缘拉取 10 张图全部超时。
- 不需要知道路径的查询方式（MediaWiki 标准功能，未对 PRTS 实测）：
  - `/w/Special:FilePath/<文件名>`
  - `api.php?action=query&prop=imageinfo&iiprop=url&titles=File:A|File:B…&format=json&origin=*`（一次最多 50 个）

**结论：Worker 不碰 PRTS。** 不只是“只做转发”，而是完全不经过 Worker，原因有三：WAF 拦截、国内托管导致边缘超时、Referer 规则。PRTS 只作为浏览器端直连的兜底图源。旧版通过 `api.kaltsit.dev/prts` 转发 PRTS 的做法也一并废弃。

## 2. 明日方舟：改用按 ID 索引的结构化数据

新接口直接返回 `charId` 和 `poolId`，因此不再需要按中文名抓取页面。名字并不唯一，例如“暮落”同时对应 `char_512_aprot` 和 `char_4025_aprot2`。

### 2.1 游戏数据：`Kengxxiao/ArknightsGameData`（仍在维护）

- 最新国服更新：2026-10-09（客户端 2.7.81），大约每 1–2 周更新一次；新卡池数据会在开放前进入仓库。
- `zh_CN/gamedata/excel/character_table.json`（15 MB）：以 `char_xxx` 为键，含 `name`、`rarity`（`"TIER_1"`…`"TIER_6"`）、`profession`、`isNotObtainable` 等。
- `zh_CN/gamedata/excel/gacha_table.json`（462 KB）：`gachaPoolClient[]` 共 453 个卡池，含 `gachaPoolId`、`gachaPoolName`、`openTime` / `endTime`（秒）、`gachaRuleType`、`guarantee5Avail` / `guarantee5Count`、`linkageParam`、`limitParam`、`dynMeta`、`carousel`。
  - **`gachaPoolId` 与新接口的 `poolId` 一致**（例如 `LINKAGE_74_0_1` “幽境狩人”）。
  - 规则类型分布：NORMAL 233、DOUBLE 42、CLASSIC 41、SINGLE 36、CLASSIC_DOUBLE 35、LIMITED 26、FESCLASSIC 14、LINKAGE 9、SPECIAL 8、ATTAIN 5、CLASSIC_ATTAIN 3、BACKFLOW 1。
  - 不足：标准 / 中坚池的名字都是泛称；除 SPECIAL 外**没有 UP 名单**；没有卡池图字段。
- UP 名单：`weedy.prts.wiki/gacha_table.json`（服务器侧卡池详情，含 `upCharInfo.perCharList`）。RIIC-Web 的每日 GitHub Action 在 2026-10-15 成功拉取过。只在 CI 构建时获取，失败时降级为“UP 未知”。
- 卡池标题图：`ArknightsAssets/ArknightsAssets2` 仓库的 `assets/dyn/ui/gacha/{poolId}/title.png`。
- 旧版抓 PRTS「卡池一览/常驻标准寻访」HTML 来划分常驻池时段，这一需求可以由 `gacha_table` 的 `openTime` / `endTime` 完全取代。

### 2.2 头像（按 charId）

| 仓库 | 状态 | 路径 | 说明 |
|---|---|---|---|
| `arkntools/arknights-toolbox-data` | 2026-10-14 更新 | `assets/img/avatar/{去掉 char_ 的 id}.png`（435 个） | 80×80，约 5 KB/张；附带精简的 `character.json` |
| `yuanyan3060/ArknightsGameResource` | 2026-10-09 自动更新 | `avatar/{charId}.png`（含 `_2` 等变体） | 180×180，约 58 KB/张；新干员约在数据更新后 8 小时入库 |
| `akgcc/arkdata`、`fexli/ArknightsResource` | 仍在更新 | — | 备选 |
| `Aceship/Arknight-Images` | 2024-05 起停更 | — | 不可用 |

10 月新干员 `char_4231_clemnt`（克莱门莎）在 arkntools 与 yuanyan 中都已收录（已核实）。图片版权归鹰角，这些仓库都声明为学习用途。

CDN 方面：
- raw.githubusercontent 支持 CORS，但国内访问不稳定；
- jsDelivr 自 2021 年失去国内 ICP 备案，出现过 DNS 污染。

### 2.3 推荐方案

1. **每日 GitHub Action** 生成精简的 `ak-meta.json` 并提交到仓库，push 后自动触发部署。内容包括：
   - charId → 名称、星级（整数）、职业；
   - poolId → 名称、规则类型、开放 / 结束时间、联动 / 限定参数、UP 名单。
2. **头像在构建时镜像到同源静态资源**：`/assets/avatars/{charId}.webp`，设置 `Cache-Control: immutable`。
   - 同源图片在分享图导出时不会污染 canvas，也绕开了 GitHub / jsDelivr 在国内的可达性问题；
   - Workers 的静态资源请求免费；体积约 2.5 MB（80×80）到 7 MB（180×180 WebP）。
3. **运行时兜底**（浏览器直连，不经过 Worker）：torappu `char_avatar/{charId}.png` → media 按名字 md5 → 占位图。
4. 遇到未知 poolId 时，用接口返回的 `poolName` 加上 poolId 前缀规则兜底。

## 3. 终末地

- 记录本身已带名称和星级，元数据需求较小。
- 卡池信息来自官方 `ef-webview.hypergryph.com/api/content?pool_id=…&server_id=1&lang=zh-cn`（无需 token，含 `up6_name`、`up6_image`、`up6_avatar`、`all[]`）。**不允许浏览器跨域请求**（2026-10-16 实测：上游返回 200，但没有 `Access-Control-Allow-Origin` 头），因此**需要经 Worker 转发**，结果按 poolId 缓存在 IndexedDB。
- 构建时快照：`555me/beyondGameData`（2026-10-16 更新）的 `tableCfg/GachaCharPoolTable.json`（含 `upCharIds`）和 `GachaWeaponPoolTable.json`。
- 图标：**没有持续维护、按 ID 索引的图标仓库**。
  - `BoxCatTeam/endfield-cat-metadata` 自 2026-03 停更；
  - Warfarin wiki 的图标没有 CORS；
  - 森空岛 wiki 封面只能按名字匹配。

  第一版先用“文字 + 星级色块 + 官方卡池图”，图标作为后续优化。若要在 canvas 中绘制官方卡池图，需要经 Worker 转发。

### 3.1 三个终末地 wiki 的对比（2026-10-16）

维护者给的候选：森空岛 wiki、BWIKI、灰机 wiki，原则是“谁宽松、谁全面就用谁”。云端容器的网络策略拦截了这三个域名，下表来自阅读第三方开源项目的代码和数据文件，**接口行为未亲自请求验证**。

| | 森空岛 wiki | BWIKI（wiki.biligame.com/zmd） | 灰机 wiki |
|---|---|---|---|
| 访问方式 | 数据接口需要签名（设备指纹 + token 刷新 + HMAC），否则 401；自动化抓取很可能违反用户协议 | 匿名 MediaWiki `api.php`，有 WAF | `api.php` 需要申请 `X-authkey` |
| 角色 / 武器 | 有，`itemId` 是数字，不是游戏 ID | 有名称、星级，没有游戏 ID | 未找到抓取它的项目 |
| 卡池时间 | 有时间戳（同样需要签名） | “寻访一览”页有时间段和 UP | 未知 |
| 方形头像 | `bbs.hycdn.cn`（下载不需要请求头） | `patchwiki.biligame.com` 上的头像与武器图标 | 未知 |
| 许可 | 未找到开放许可 | CC BY-NC-SA（按同平台惯例推断，待核实） | CC BY-NC-SA（推断） |

**最宽松、最全的 ID 来源其实是官方 `api/content`**：每个卡池的 `all[]` 是 `{id: "chr_…", name, rarity}`，GET 请求、不需要 token。构建脚本在 GitHub Actions 里直接请求即可（服务端没有 CORS 限制），不经过 Worker。旧卡池会从接口下线，所以结果要追加保存。

实测补充（2026-10-16，云端容器可访问 `*.hypergryph.com` 和 raw.githubusercontent.com）：
- 官方 `api/content` 对 38 个已知卡池中的 29 个返回 `40402 Pool not found`，**只保留当期卡池**，不能作为历史 UP 名单的来源。
- `555me/beyondGameData` 的 `tableCfg/GachaCharPoolTable.json`（17 个角色池，`type` 0 特许 / 1 启程 / 2 基础 / 3 辉光庆典 / 4 重构，`upCharIds`）、`GachaWeaponPoolTable.json`（21 个武器池，`type` 0 / 1 重构，`upWeaponIds`）、`ItemTable.json`（角色 type 4、武器 type 5，含中文名与星级）完整覆盖全部卡池与角色、武器。

结论：
- **已实现**：卡池类型、UP 名单、角色与武器的名称和星级取自上述三张游戏数据表，构建时生成 `public/gamedata/ef-meta.json`（约 7 KB）。前端据此判断 6★ 是否为 UP、确定保底分组；官方接口只用于当期卡池的卡池图，下线卡池返回 40402 后一周内不再请求。
- ID → 名称 / 星级的备用来源：官方 `api/content` 的 `all[]`（只覆盖当期卡池）。
- 头像与武器图标（**待实现**，需要容器能访问 BWIKI 才能调试）：BWIKI（匿名 API，按中文名与上面的 ID 表关联），构建时下载并转成同源的 128×128 WebP，与明日方舟头像相同。BWIKI 被 WAF 拦截时退回到维护一张 `bbs.hycdn.cn` 头像地址表。
- 卡池时间：BWIKI“寻访一览”，加一份按官方公告手工维护的覆盖文件。
- 森空岛（需要签名）、灰机（需要 key）不采用。游戏美术的版权都归鹰角，页面上注明来源与版权。

## 4. Worker 只转发这些

- `as.hypergryph.com`（grant）
- `binding-api-account-prod.hypergryph.com`（binding_list、u8_token_by_uid）
- `ak.hypergryph.com`（role/login、`user/api/inquiry/gacha/*`，以及确认后的源石 / 充值接口）
- `ef-webview.hypergryph.com`（`api/record/*`、`api/content`）
- 可选：终末地官方图片 CDN（仅限 canvas 导出时）

PRTS 不在其中。

## 主要来源

- Kengxxiao/ArknightsGameData；MooncellWiki/prts-widgets（`consts.ts`、`charImage.ts`）；MooncellWiki/prts-design
- KnightCodeSquareMatrix/RIIC-Web（`scripts/sync-gacha-up.mjs`、`docs/gacha-analysis-rules.md`）
- Eltik/myrtle（卡池规则统计）；BiologyHazard/riic-yituliu；IJNKAWAKAZE/arknights_bot
- yuanyan3060/ArknightsGameResource；arkntools/arknights-toolbox-data
- 555me/beyondGameData；MoguJunn/endfield-gacha（`wiki-asset-proxy.js`）；Renari/PROTORIG.app
