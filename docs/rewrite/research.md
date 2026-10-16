# 抽卡接口与保底规则调研（2026-10-16）

> 所有鹰角接口均**未经本环境实测**（云端容器连不到 `*.hypergryph.com`）。下列内容来自多个 2025–2026 年仍在维护的开源实现的源码交叉核对；标注「未确认」的条目没有可靠来源。

## 1. 明日方舟（国服）

### 1.1 旧接口已失效

旧版使用的 `ak.hypergryph.com/user/api/inquiry/gacha?channelId=&page=&token=` 现在返回网页 HTML（arklog、arknights-mcp 两个项目于 2026-10-12 实测）。线上旧版因此无法同步新数据。

### 1.2 新的认证流程

无需签名，但必须经过服务端转发（见 1.5）。

```
0. 账号 token：登录后打开 https://web-api.hypergryph.com/account/info/hg，复制 data.content
   （仍是各工具的主流获取方式；旧版存下的 token 也是这个值）
1. POST https://as.hypergryph.com/user/oauth2/v2/grant
   {"token": <账号token>, "appCode": "be36d44aa36bfb5b", "type": 1}        → data.token（OAuth token）
2. GET  https://binding-api-account-prod.hypergryph.com/account/binding/v1/binding_list
        ?token=<OAuth token>&appCode=arknights
   → data.list[{appCode, bindingList:[{uid, nickName|nickname, channelName, isOfficial, isDefault, channelMasterId?}]}]
3. POST https://binding-api-account-prod.hypergryph.com/account/binding/v1/u8_token_by_uid
   {"token": <OAuth token>, "uid": <uid>}                                     → data.token（u8 / role token）
4. POST https://ak.hypergryph.com/user/api/role/login
   {"token": <u8>, "source_from": "", "share_type": "", "share_by": ""}      → Set-Cookie: ak-user-center=…
```

后续数据请求需要同时带上：
- 请求头 `x-role-token: <u8>`
- `Cookie: ak-user-center=<值>`
- 可选：`x-account-token`、`Referer: https://ak.hypergryph.com/user/headhunting`

`as.` 与 binding 域名的响应格式是 `{status,msg,data}`，`ak.` 域名是 `{code,msg,data}`，两个字段都要检查。认证失败时返回 HTTP 401 和 `{"reason":"UN_LOGIN" | "MissingCookie" | "DETECTED_ROLE_CHANGED"}`，**没有 `code` 字段**，不能当成成功。Cookie 与 role token 必须属于同一个角色。

### 1.3 寻访记录接口

- 类别：`GET /user/api/inquiry/gacha/cate?uid=<uid>`
  - 返回 `data: [{id, name}]`
  - 已见过的 id：`normal`（标准）、`classic`（中坚）、`anniver_fest` / `summer_fest` / `spring_fest`（限定）、各联动独立 id（如 `MH_02`）。
- 记录：`GET /user/api/inquiry/gacha/history?uid=&category=&size=&pos=&gachaTs=`
  - 返回 `data: {list, hasMore}`。
  - 每条记录是**一抽**：`{poolId, poolName, charId, charName, rarity, isNew, gachaTs, pos}`。
  - `rarity` 从 0 开始（5 = 6★）；`gachaTs` 是**毫秒字符串**；十连是 10 条 `gachaTs` 相同、`pos` 为 0–9 的记录。
  - 没有唯一 ID，去重键用 `poolId:charId:gachaTs:pos`。
  - 必须按类别分别查询；翻页游标是上一页最后一条的 `pos` 和 `gachaTs`；`size` 可取 10 / 50 / 100。
  - 各实现在翻页之间等待 250 ms–3 s。
- 可查范围：官方页面写“可查询 90 日内寻访记录，查询结果可能存在 30 分钟延迟”（过去是 30 天）。

### 1.4 B 服

新接口不再有 `channelId` 参数，服务器由 `binding_list` 中的条目区分。B 服角色绑定到鹰角通行证后，会出现在 `binding_list` 中（arknights-mower PR 1173 支持，属部分验证）。否则只能让用户从网页手动复制 `ak-user-center` cookie 和 role token（ArkScreen 的做法）。

### 1.5 为什么必须转发

浏览器 JS 不能设置 `Cookie`，也读不到 `Set-Cookie`。因此无论 CORS 如何，都需要转发层做两件事：
- 把请求头 `x-cookie` 转成 `Cookie`；
- 把响应里的 `Set-Cookie: ak-user-center` 改为暴露头 `x-ak-user-center`。

Cloudea 的浏览器版工具（`scripts/cloudflare-worker.mjs`）就是这么做的。

### 1.6 源石 / 充值记录（未确认）

官方用户中心仍有“源石记录”“充值记录”入口，但**没有任何 2025–2026 年的开源实现**使用新接口。旧的 `inquiry/diamond` 与 `u8/pay/v1/recent` 很可能已经和寻访接口一样失效（推测）。需要在 DevTools 里抓取实际请求。

### 1.7 森空岛

`zonai.skland.com` 没有明日方舟寻访接口。但森空岛扫码 / 手机号登录可以拿到鹰角账号 token，再走 1.2 的流程（RIIC-Web、nonebot-plugin-skland 都这么做）。扫码登录：

```
POST as.hypergryph.com/general/v1/gen_scan/login {appCode:"4ca99fa6b56cc2ba"}
GET  /general/v1/scan_status?scanId=
POST /user/auth/v1/token_by_scan_code {scanCode}
```

### 1.8 明日方舟保底规则（国服）

- **6★ 概率**：基础 2%；连续 50 抽未出 6★ 后，第 51 抽 4%，此后每抽 +2%，第 99 抽必出。
  精确计算：期望 **34.59** 抽，中位数 35 抽。旧版“统计学分析”里拟合公式给出的 41.12 是错的。
- **首次十连保底**：每个卡池前 10 抽必出 5★ 及以上（gacha_table 中全部 453 个卡池都是 `guarantee5Avail=1, guarantee5Count=10`）。
- **保底计数分组**（按 `gacha_table` 的 `gachaRuleType`）：

  | 分组 | 规则类型 | 计数方式 |
  |---|---|---|
  | 标准 | NORMAL、SINGLE、DOUBLE；SPECIAL 按数据分析也属于这一组 | 共享计数 |
  | 中坚 | CLASSIC、CLASSIC_DOUBLE、FESCLASSIC | 共享计数，但与标准组分开 |
  | 独立 | LIMITED、LINKAGE、ATTAIN、CLASSIC_ATTAIN、BACKFLOW、新手池 `BOOT_*` | 每个池单独计数，卡池结束即清零 |

- **UP 占 6★ 的比例**：
  - LIMITED：两名各 35%（共 70%），往期限定干员权重 ×5。
  - SINGLE、LINKAGE：单 UP 占 50%。
  - NORMAL、DOUBLE、CLASSIC、CLASSIC_DOUBLE：两名各 25%（共 50%）。
  - FESCLASSIC：两名合计 50%。
  - SPECIAL：三名占 6★ 的 100%、5★ 的 60%。
- **定向保底**：
  - SINGLE：第 150 抽必得 UP。
  - DOUBLE、CLASSIC_DOUBLE：150 抽得其中一名，300 抽得另一名。
  - LINKAGE：120 抽内必得联动 6★；自 `LINKAGE_74_0_1` 起改为 `LINKAGE_LOOP6_NEW5`，每 120 抽循环。
- **限定池 300 抽**：赠送限定干员（`limitParam.freeCount: 300`），不影响保底计数。
- 不要用 API 的类别推导规则，要用 **poolId → gachaRuleType** 映射。查不到时按 poolId 前缀回退：`NORM_` / `SINGLE_` / `DOUBLE_` / `SPECIAL_` 归标准组，`CLASSIC*` / `FESCLASSIC_` 归中坚组，其余视为独立。

## 2. 终末地（国服）

2026-01-22 上线；国服由鹰角运营（`*.hypergryph.com`）。B 服角色需要先在 `user.hypergryph.com/bindCharacters?game=endfield` 绑定到通行证。

### 2.1 认证

与明日方舟**共用同一个账号 token** 和 grant 步骤（`appCode: be36d44aa36bfb5b`），只是：
- `binding_list` 改用 `appCode=endfield`；
- `u8_token_by_uid` 拿到的 u8 token 直接用于 `ef-webview`，不需要 role login。

### 2.2 记录接口

所有请求都是 `GET https://ef-webview.hypergryph.com`，公共参数为 `token=<u8>&server_id=1&lang=zh-cn`：

| 路径 | 额外参数 | 返回 |
|---|---|---|
| `/api/record/char/meta` | — | `data.tabs[].poolType` |
| `/api/record/char` | `pool_type=E_CharacterGachaPoolType_{Special\|Rerun\|Joint\|Standard\|Beginner}`、`seq_id` | 角色记录 |
| `/api/record/weapon/pool` | — | `[{poolId, poolName, poolType, online}]` |
| `/api/record/weapon` | `pool_id` / `pool_ids` 或不传、`seq_id` | 武器记录 |
| `/api/record/{char\|weapon}/rerun-counts` | — | 重构池服务器端累计抽数 |
| `/api/content` | `pool_id`（**无需 token**） | 卡池详情：`up6_name`、`up6_image`、`all[{id,name,rarity}]` 等 |

- **`/api/content` 已实测**（2026-10-16，项目维护者在浏览器中直接打开）：
  - `GET https://ef-webview.hypergryph.com/api/content?lang=zh-cn&pool_id=standard&server_id=1` 无需 token，返回 `code: 0`。样本见 [fixtures/ef-api-content-standard.json](fixtures/ef-api-content-standard.json)。
  - `pool_id=standard` 对应“基础寻访”，但 `pool_type` 为 `"normal"`，规则映射以 `pool_id` 为准。
  - `all[]` 给出 `{id: "chr_0025_ardelia", name, rarity(4–6)}`，可作为角色名录来源。
  - 常驻池的 `up6_image`、`up6_avatar`、`rotate_list` 均为空。
  - `data.timezone` 为 8。
  - 浏览器跨域请求（CORS）是否被允许尚未测试。
- 翻页：首次不带 `seq_id`，之后取上一页最后一条的 `seqId`，直到 `hasMore` 为假；记录按时间倒序返回。
- 角色记录：`{poolId, poolName, charId, charName, rarity(4–6), isFree, isNew, gachaTs(毫秒字符串), seqId, kind, poolVersion}`。
- 武器记录：`{poolId, poolName, weaponId, weaponName, weaponType, rarity, isNew, gachaTs, seqId, poolType, kind}`。
- `kind == "draw"` 才是真实抽取，`gift_*` 是赠送条目，统计时排除。
- token 失效返回 `code: 40100`，需要重新走一遍 grant 流程。
- 可查范围约 90 天。
- 未发现 CORS 支持，各网页工具都通过服务端转发。

### 2.3 终末地保底规则

主要来自攻略站和开源实现，部分规则需要进一步核实：
- 6★ 基础 0.8%，5★ 8%；第 65 抽之后每抽 +5%，第 80 抽必出。按此模型计算期望 **53.90** 抽，中位数 67 抽。
- 至少每 10 抽一个 5★。
- 特许寻访（限定）之间**共享** 80 抽计数；重构寻访单独共享一个计数；常驻、新手（40 抽封顶）分别计数。
- 同一限定池第 120 抽必得当期 UP，**不继承**（重构寻访同名池跨版本继承）；240 抽额外奖励。
- `isFree` 的免费十连不计保底；辉光庆典（Joint）池没有保底。
- 武器池：每次 10 连，40 抽内必出 6★，80 抽必得 UP 6★；计数不跨池继承（重构武器池除外）。

## 3. 参考实现

| 项目 | 关键文件 |
|---|---|
| Gordenghost/arklog | `internal/hypergryph/auth.go`、`internal/gacha/arknights/arknights.go`（文档最完整） |
| AceDroidX/arknights-gacha-export | `API.md`、`src/api/arknights.rs`、`src/api/endfield.rs`（同一 token 两个游戏） |
| CloudeaSoft/cloudea-blog-nextra | `app/_components/tools/arknights-gacha/*`、`scripts/cloudflare-worker.mjs`（浏览器 SPA + CF Worker 转发） |
| bhaoo/endfield-gacha | `app/composables/gacha/gachaApi.ts`、`useGachaAuth.ts`、`app/utils/gachaCalc.ts` |
| MoguJunn/endfield-gacha | `src/utils/endfieldAuthChain.js`（网页版 + 转发） |
| blueskybone/ArkScreen | `ui/account/LoginWeb.kt`（B 服网页登录） |
| KnightCodeSquareMatrix/RIIC-Web | `src/server/gacha-history.ts`、`docs/gacha-analysis-rules.md` |
| Yum0Rin/arknights-mcp | `docs/DATA-SOURCES.md` |
