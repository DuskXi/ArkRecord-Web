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

### 2.4 改为以 PRTS 为主（2026-10-16，容器已放行 prts.wiki）

维护者要求名单和卡池尽量直接从 wiki 获取。实测：
- PRTS（MediaWiki 1.43，CC BY-NC-SA 4.0）装有 Cargo，`chara` 表一次查询即可得到全部干员（charId、中文名、星级、职业）。当前 463 人，与 GitHub 数据一致（多出阿米娅的两种职业形态），最新到 10-09 上线的克莱门莎。PRTS 在公告后就会收录新干员，比解包数据早。
- PRTS 的 Cargo 里没有卡池表；`weedy.prts.wiki/gacha_table.json` 有全部 457 个卡池的 ID 和 UP 名单，但没有卡池类型和开放时间。
- PRTS 的 [卡池一览](https://prts.wiki/w/卡池一览)（机器人维护）及子页面“限时寻访”“常驻标准寻访/年份”“常驻中坚寻访&中坚甄选/年份”共 452 行，每行有卡池名、起止时间、6★ 与 5★ 特定干员，但没有卡池 ID。按开放时间（12 小时内）和名称可以对应上游戏数据中的 433 个卡池：
  - UP 名单与 weedy 完全一致（weedy 本身就是 PRTS 的数据），没有补出新的 UP；
  - 即将开放的卡池游戏数据更早（如 10-22 的 DOUBLE_78_0_2 已在游戏数据中，PRTS 还没有）；
  - 真正能补上的是**卡池名称**：游戏数据里常驻、联合行动、中坚甄选、定向甄选等 300 多个卡池都叫“适合多种场合的强力干员”或“定向甄选”，PRTS 有具体名称（联合行动23、中坚甄选14、定向甄选08 等）。
- PRTS 会偶尔直接断开连接，请求需要重试。

实现：
- 干员：PRTS `chara` 为主、GitHub 干员表为备，两者合并；两边都有的用游戏内名称（PRTS 为区分页面会加“(卫戍协议)”等后缀）。
- 卡池：ID、类型、开放时间、联动 / 限定参数仍取 GitHub 的游戏数据卡池表（只有这里有）；UP 名单取自 PRTS；GitHub 还没收录的新卡池先按 PRTS 建一条（按 poolId 前缀推断类型），开放当天就能判断 UP。
- 卡池名称：泛称卡池换成 PRTS 卡池一览中的具体名称（46 个：联合行动、中坚甄选、定向甄选等），不带编号的加上开放日期；常规轮换池保持“标准寻访 / 中坚寻访 · 日期”。
- 构建日志中比对 PRTS 卡池一览与现有 UP 名单，列出不一致之处，以及 PRTS 有而游戏数据还没有的近 30 天卡池。
- 头像：PRTS（torappu）为主、GitHub 资源仓库为备，下载并发 4，只下载新增的。
- 任一来源失败不阻塞构建，只有同一项的两个来源都失败时才报错。

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
- 卡池时间：BWIKI“寻访一览”，加一份按官方公告手工维护的覆盖文件（待实现）。
- 游戏美术的版权都归鹰角，页面上注明来源与版权。

### 3.2 实测（2026-10-16，三个 wiki 已加入容器白名单）

| | 结果 |
|---|---|
| BWIKI | 匿名 API 可用（MediaWiki 1.37，无 Cargo / SMW）。“干员”分类 30 人，**缺最新的祀、提弗洛斯、噗切娜**，当期卡池“万物更新”也没有页面；文件命名统一为“名字头像.png”“名字图标.png”（尺寸 120～396 的方图），按名称能对上 118 个角色 / 武器中的 112 个 |
| 森空岛 wiki | 数据接口 `zonai.skland.com/web/v1/wiki/*` 未签名时返回 `10001 设备信息无效`（需要数美设备指纹 + 签名），脚本不读取；图片 CDN `bbs.hycdn.cn` 可直接下载，但**带其他站点的 Referer 会被拒绝（403）** |
| 灰机 wiki | 整站开启 Cloudflare 人机验证（“Just a moment...”），脚本无法读取 |
| 游戏数据表 | 已收录祀、噗切娜和当期卡池，比 wiki 更新更快 |

据此的实现（维护者确认：名单和卡池用游戏数据表，图片 BWIKI 为主、森空岛为备）：
- **卡池、名单**：游戏数据表（见 3.1），构建频率提高到每 3 小时一次。构建日志中比对 BWIKI 的“干员”“武器”分类与游戏数据的名单，提示 BWIKI 还没收录、或游戏数据里没有的名称（首次运行：BWIKI 缺 3 名角色、6 把武器）。
- **头像与武器图标（双备份）**：按顺序尝试，下载失败自动换下一个来源。
  1. `scripts/ef-avatar-overrides.json`：维护者手动指定的地址，优先级最高；
  2. BWIKI 的“头像”“图标”文件；
  3. 森空岛角色头像（`bbs.hycdn.cn`）。地址取自 `cmyyx/cep` 每日用浏览器抓取森空岛生成的索引（AGPL-3.0，只读取其中的图片地址，不分发该文件）；森空岛头像是 456×564 的半身像，从顶部裁成方形。

  只从 `patchwiki.biligame.com/images/zmd/` 和 `bbs.hycdn.cn/image/` 下载，按“来源地址 + sha1”只下载新增或变化的图片，串行并间隔请求。首次实测：BWIKI 48 张、森空岛 2 张（祀、噗切娜）。最新的 4 把武器两边都还没有图，显示文字占位，来源补上后下一次构建自动更新。

## 4. Worker 的访问范围

- `as.hypergryph.com`（grant）
- `binding-api-account-prod.hypergryph.com`（binding_list、u8_token_by_uid）
- `ak.hypergryph.com`（role/login、`user/api/inquiry/gacha/*`、`user/api/inquiry/diamond` 源石记录）
- `u8.hypergryph.com`（`u8/pay/v1/recent` 充值记录）
- `ef-webview.hypergryph.com`（`api/record/*`、`api/content`）

图片缓存转发（`worker/images.ts`，2026-10-16 按维护者要求加入，用 Cloudflare 缓存减少对来源站的请求）：
- `torappu.prts.wiki/assets/char_avatar/{charId}.png`：只用于构建时还没镜像的新干员头像，下一次构建后改用本站静态文件；
- `web.hycdn.cn/upload/image/{日期}/{哈希}.{png|jpg|webp}`：终末地卡池图。

规则：路径严格匹配白名单；只接受本站页面引用（拒绝其他网站盗链）；每个机房缓存 30 天，来源站 404 缓存 1 小时；只有未命中缓存时才回源，回源受限速。
大部分图片仍在构建时镜像为本站静态文件，线上不访问来源站。

## 主要来源

- Kengxxiao/ArknightsGameData；MooncellWiki/prts-widgets（`consts.ts`、`charImage.ts`）；MooncellWiki/prts-design
- KnightCodeSquareMatrix/RIIC-Web（`scripts/sync-gacha-up.mjs`、`docs/gacha-analysis-rules.md`）
- Eltik/myrtle（卡池规则统计）；BiologyHazard/riic-yituliu；IJNKAWAKAZE/arknights_bot
- yuanyan3060/ArknightsGameResource；arkntools/arknights-toolbox-data
- 555me/beyondGameData；MoguJunn/endfield-gacha（`wiki-asset-proxy.js`）；Renari/PROTORIG.app
