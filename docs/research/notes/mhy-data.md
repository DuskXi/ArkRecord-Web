# 米哈游系抽卡数据获取方式调研笔记（2026-10-18）

> 范围：原神（hk4e）、崩坏：星穹铁道（hkrpg）、绝区零（nap）、崩坏3（bh3）。
> 方法：只读开源代码（主要通过 raw.githubusercontent.com）+ 网络搜索。**没有用任何真实账号或凭据**。
> 沙箱出口代理拦截了所有 `*.mihoyo.com` / `*.hoyoverse.com` / paimon.moe / stardb.gg / zzz.rng.moe / starrailstation.com / gist / hackmd / 知乎 / 新闻站，**没能亲自测 CORS 响应头**，相关结论来自开源代码和项目文档。
>
> 标记：**[确认]** = 多个独立的近期开源实现或文档一致；**[单源]** = 只有一个来源；**[推测]** = 我的推断；**[过时]** = 信息较老或已变。
> 来源类型：**官方** = 米哈游/HoYoverse 自己的文本；**开源** = 开源代码；**文档** = 开源项目文档；**第三方** = 文章/wiki/新闻。
> 注意：米哈游**没有**公开文档说明这些接口，所以下面的接口细节全部来自开源实现（逆向）。

---

## 0. 重要背景变化（2025–2026）

- **原 Snap.Hutao 仓库 `DGP-Studio/Snap.Hutao` 已经 404**（raw 和 GitHub 网页都打不开；`DGP-Studio/Snap.Metadata`、`Snap.Hutao.Docs` 也 404，只有 `Snap.Hutao.SourceGeneration` 还在）。社区有多个分支继续维护：`wangdage12/Snap.Hutao`、`SnapHutaoRemasteringProject/Snap.Hutao.Remastered`、`zhongshen6/Snap.Hutao.Rev`；`Snap.Hutao-Manjusaka` 已在 2026-03-31 归档。下线原因**没找到官方说明**；有知乎评论称“被老米告了”，**未证实**。
  - https://github.com/wangdage12/Snap.Hutao （开源）
  - https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered （开源）
  - https://github.com/Millennium-Science-Technology-R-D-Inst/Snap.Hutao-Manjusaka （开源，README 写着“已结束维护”）
- **原神 4.5 起祈愿记录可查范围从 6 个月改为 1 年**（BWIKI：“4.5版本将祈愿查询时间从 6个月 改为 1年。”；胡桃文档：“原神官方仅提供一年的抽卡记录”“只能查询到过去一年内的祈愿记录”）。**[确认]**
  - https://wiki.biligame.com/ys/%E7%A5%88%E6%84%BF （第三方 wiki）
  - https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered.Docs/blob/master/docs/zh/features/wish-export.md （文档）
- **原神“千星奇域（Miliastra Wonderland）”有独立的“颂愿”卡池和独立接口 `getBeyondGachaLog`**；UIGF 为此出了 v4.2（新增 `hk4e_ugc`）。**[确认]**
- **星铁 3.4 联动卡池（Fate）用 `getLdGachaLog`，gacha_type 21/22**；UIGF v4.1 为此更新。**[确认]**
- **绝区零新增 real_gacha_type 102（独家重映）、103（音擎回响）**（Starward、zzz-signal-search-export、genshin.py 都已支持）。**[确认]**；但 UIGF v4.2 schema 中 `nap.gacha_type` 枚举仍只有 1/2/3/5。**[确认 schema；具体怎么映射未确认]**
- **星铁 API 路径有两种**：`/common/gacha_record/api/` 和 `/common/hkrpg_gacha_record/api/`。Starward、HoYo.Gacha、star-rail-warp-export 用后者；genshin.py 用前者；stardb 按用户 URL 里的路径二选一。**建议沿用用户 URL 里的路径**。**[确认两种都在用；哪个更“官方”未确认]**

---

## 1. 各游戏抽卡记录接口

### 1.1 通用参数（三款游戏都有）

| 参数 | 含义 / 取值 | 出处 |
|---|---|---|
| `authkey` | 约 1024 字符的 base64（URL 编码后有 `%2B` `%2F` `%3D`）；24 小时有效 | genshin.py 文档 |
| `authkey_ver` | 固定 `1` | 各实现 |
| `sign_type` | 固定 `2` | 各实现 |
| `auth_appid` | 游戏内链接里是 `webview_gacha`；Snap.Hutao 手动输入时会校验它必须是 `webview_gacha` | Snap.Hutao GachaLogQueryManualInputProvider.cs |
| `lang` | 返回 `name`/`item_type` 的语言（zh-cn、en 等）。千星奇域接口要用完整语言代码（genshin.py：`short_lang_code=banner_type not in MW_BANNER_TYPES`） | genshin.py gacha.py |
| `game_biz` | `hk4e_cn` / `hk4e_global` / `hkrpg_cn` / `hkrpg_global` / `nap_cn` / `nap_global`（还有 bilibili 渠道服） | Starward、stardb、rng.moe 脚本 |
| `page` | 页码（实际靠 end_id 翻页） | 各实现 |
| `size` | 普通接口最大 **20**（GoneTone 2026 设计文档：“`size = 20` 寫死 / API 上限”；旧文档写的是“1–20，默认 6”）。**千星奇域 `getBeyondGachaLog`：Starward 和 Snap.Hutao 都用 size=5**（HarmonyOS 移植计划：“`GachaLogTypedQueryOptions.BeyondSize=5`”），genshin.py 用 20 → 上限是否为 5 **[推测]** | 见下 |
| `end_id` | 上一页最后一条的 `id`；`0` 表示第一页。原神 1.4（2021-03）起改为 end_id 分页 | jvergerolle README |
| `gacha_type` / `real_gacha_type` | 卡池类型，见各游戏 | 见下 |
| `region` | 游戏 URL 自带（`cn_gf01`、`os_usa`、`prod_gf_cn` 等），请求时可以不带 | mihoyo-api-sdk game.tsp |

游戏 URL 里还有其他参数：`init_type`、`gacha_id`、`timestamp`、`device_type`、`game_version`、`plat_type`、`win_mode`、`no_joypad_close`，在 2021 年的样本里还见过 **`ext={"loc":{"x":…,"y":…,"z":…},"platform":"Android"}`（玩家坐标）**。拉记录用不到这些参数。rng.moe 的脚本只保留 `authkey/authkey_ver/sign_type/game_biz/lang`，其余全删；stardb 服务端只保留 `authkey/authkey_ver/sign_type`。**建议前端先剥离其他参数，再交给 Worker**（隐私要点）。
- https://github.com/UIGF-org/mihoyo-api-sdk/blob/main/src/game.tsp （开源：GenshinGachaQuery 字段）
- https://github.com/Rettend/zzz-pull-planner/blob/main/DATA.md （开源：rng.moe 脚本副本，保留参数的逻辑）
- https://github.com/juliuskreutz/stardb-api/blob/master/src/api/warps_import/mod.rs （开源：`gacha_log_url()` 只保留 3 个参数）
- 带 `ext.loc` 的 2021 年样本：https://github.com/MasterZuom/ZuoNewRN/blob/master/zuo_rn/src/component/Home/Home.tsx （开源；**[过时]**，现在的 URL 是否仍带 ext 未确认）

通用返回结构：`{"retcode":0,"message":"OK","data":{"page","size","total","list":[…],"region", ("region_time_zone")}}`

已知错误码 **[确认，多个实现一致]**：
- `-101` `authkey timeout`（过期）
- `-100` `authkey error`（无效）
- `-110` `visit too frequently`（限速）
- 出处：https://github.com/GoneTone/genshin-impact-wish-gacha-analyzer/blob/master/docs/superpowers/specs/2026-05-08-gacha-fetch-and-dashboard-design.md （开源设计文档，2026-05）；https://github.com/JamXi233/ZenlessTools/blob/main/ZenlessTools/Depend/GachaRecords.cs ；https://github.com/tawan475/irminsul/blob/main/src/wish_history/gacha_log.rs

**限速：没有官方数字**。胡桃文档：“API 存在请求速率限制，过快的请求会导致后续的请求失败”。各工具的做法：
- Starward：每请求随机延迟 200–300ms
- biuuu 系导出工具：每页 0.3s，每 10 页再停 1s，失败重试 5 次、每次间隔 5s
- paimon.moe：不同卡池之间 sleep 2s
- GoneTone：每页 600ms，遇到 -110 等 5s、最多重试 3 次，卡池串行抓取
- stardb 服务端：失败后 sleep 1s
- Snap.Hutao 鸿蒙移植：每页随机 1–2s

**数据延迟**：抽卡后约 1 小时才出现在记录里（第三方攻略、胡桃文档“短时间内刚抽取的祈愿记录可能无法被获取”）。**[确认现象，时长为第三方说法]**

### 1.2 原神（hk4e）

| 项 | 值 |
|---|---|
| 国服 host/path | `https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog` |
| 国际服 | `https://public-operation-hk4e-sg.hoyoverse.com/gacha_info/api/getGachaLog`（所有海外区共用 -sg） |
| 千星奇域（颂愿） | 同 host，`/gacha_info/api/getBeyondGachaLog` |
| 旧 host **[过时]** | `hk4e-api.mihoyo.com/event/gacha_info/api/getGachaLog`、`hk4e-api-os.hoyoverse.com/event/gacha_info/api/getGachaLog`（2.5 之前是 `hk4e-api-os.mihoyo.com`） |
| 游戏内网页 | 国服 `https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-v3/index.html?…#/log`；国际服 `https://gs.hoyoverse.com/genshin/event/e20190909gacha-v3/…`（Starward 匹配前缀 `…/e20190909gacha`）；千星奇域 `…/e20250716gacha/index.html` |
| gacha_type | 100 新手祈愿；200 常驻祈愿；301 角色活动祈愿；400 角色活动祈愿-2；302 武器活动祈愿；500 集录祈愿。**查 301 会同时返回 301 和 400 的记录**（各工具只查 100/200/301/302/500），UIGF 用 `uigf_gacha_type` 把 400 合并到 301 |
| 千星奇域 gacha_type | 查询用 1000（常驻颂愿）/ 2000（活动颂愿）；记录里的 `op_gacha_type` 可以是 1000/2000/20011/20012/20021/20022（男/女装扮活动池） |
| 返回字段 | `uid, gacha_type, item_id, count, time, name, lang, item_type, rank_type(3/4/5), id`；`data.region`（cn_gf01/cn_qd01/os_usa/os_euro/os_asia/os_cht） |
| item_id | **原神 API 的 item_id 自 2021-02 起基本是空字符串**（jvergerolle README；2026 年 GoneTone 设计文档：“`item_id` 大多空字串”）→ 需要用名称+语言映射成 ID（UIGF 要求 item_id 必填） |
| 千星奇域返回字段 | `uid, id, region, op_gacha_type, schedule_id, item_type, item_id, item_name, rank_type, is_up, time`（Starward GenshinBeyondGachaItem.cs；UIGF v4.2 `hk4e_ugc`） |
| 时区 | **原神不返回时区**（genshin.py 注释：“Genshin doesn't return timezone data / America: UTC-5, Europe: UTC+1, others are UTC+8”）；biuuu 系按 UID 首位推断：6→-5，7→+1，其他→+8 |
| 保留期 | **1 年**（4.5 起；之前是 6 个月 **[过时]**） |
| authkey 绑定 | 2.3（2021-11）起抽卡接口要求 `webview_gacha` 的 authkey（jvergerolle README：“The authkey to get wish data must be from the webview_gatcha app”） |

出处：
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/GachaLogClient.cs （开源）
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/Genshin/GenshinGachaType.cs （开源）
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/Genshin/GenshinBeyondGachaClient.cs （开源）
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/Genshin/GenshinBeyondGachaItem.cs （开源）
- https://github.com/seriaati/genshin.py/blob/master/genshin/client/components/gacha.py （开源）
- https://github.com/seriaati/genshin.py/blob/master/genshin/client/routes.py （开源）
- https://github.com/seriaati/genshin.py/blob/master/genshin/models/genshin/gacha.py （开源：MWBannerType 等枚举）
- https://github.com/lgou2w/HoYo.Gacha/blob/main/crates/game_biz/src/api.rs （开源）
- https://github.com/jvergerolle/Genshin-Impact-Wish-history-API （文档，**2021–2022 年，部分过时**）
- https://github.com/biuuu/genshin-wish-export/blob/main/src/main/UIGFJson.js （开源：按 UID 推断时区）
- https://github.com/MadeBaruna/paimon-moe/blob/main/src/routes/wish/import.svelte （开源）

### 1.3 星穹铁道（hkrpg）

| 项 | 值 |
|---|---|
| 国服 | `https://public-operation-hkrpg.mihoyo.com/common/hkrpg_gacha_record/api/getGachaLog`（或 `/common/gacha_record/api/getGachaLog`） |
| 国际服 | `https://public-operation-hkrpg-sg.hoyoverse.com/common/hkrpg_gacha_record/api/getGachaLog`（或 gacha_record） |
| 联动池 | 同 host，`…/getLdGachaLog`（gacha_type 21、22） |
| 旧 host **[过时]** | `api-takumi.mihoyo.com/common/gacha_record/api/getGachaLog`、`api-os-takumi.mihoyo.com/…` |
| 游戏内网页 | `https://webstatic.mihoyo.com/hkrpg/event/e20211215gacha-v2/…`；`https://gs.hoyoverse.com/hkrpg/event/e20211215gacha-v2/…` |
| gacha_type | 1 群星跃迁（常驻）；2 始发跃迁（新手）；11 角色活动跃迁；12 光锥活动跃迁；21 角色联动跃迁；22 光锥联动跃迁 |
| 返回字段 | `uid, gacha_id, gacha_type, item_id, count, time, name, lang, item_type, rank_type(3/4/5), id`；`data.region`、**`data.region_time_zone`**（genshin.py：“Star rail returns UTC+n for this value”） |
| 保留期 | 社区普遍说 **6 个月**（游侠网 2023 年攻略：“【历史记录】页面只能查看最近6个月的跃迁历史记录”“1个小时左右的延迟”）**[第三方，2023，未核实是否已改]** |

出处：
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/StarRail/StarRailGachaClient.cs （开源）
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/StarRail/StarRailGachaType.cs （开源）
- https://github.com/biuuu/star-rail-warp-export/blob/main/src/main/getData.js （开源）
- https://github.com/juliuskreutz/stardb-api/blob/master/src/api/warps_import/mod.rs （开源）
- https://github.com/UIGF-org/UIGF-org.github.io/blob/main/docs/zh/standards/uigf.md （文档：v4.1 新增 21/22）
- https://gl.ali213.net/html/2023-7/1096519.html （第三方，2023）

### 1.4 绝区零（nap）

| 项 | 值 |
|---|---|
| 国服 | `https://public-operation-nap.mihoyo.com/common/gacha_record/api/getGachaLog` |
| 国际服 | `https://public-operation-nap-sg.hoyoverse.com/common/gacha_record/api/getGachaLog` |
| 游戏内网页 | `https://webstatic.mihoyo.com/nap/event/e20230424gacha/…#/log`；`https://gs.hoyoverse.com/nap/event/e20230424gacha/…` |
| 查询参数 | 用 **`real_gacha_type`**：1 常驻频段；2 独家频段；3 音擎频段；5 邦布频段；102 独家重映；103 音擎回响。游戏 URL 里的 `gacha_type` 是 1001/2001/3001/5001 这类子类型（rng.moe 实测：请求 2001，返回记录的 gacha_type 是 "2"） |
| 返回字段 | `uid, gacha_id("0"), gacha_type("1/2/3/5"), item_id, count, time, name, lang, item_type("Agents"/"W-Engines"/…), rank_type(2=B, 3=A, 4=S), id` |
| 时区 | genshin.py 读 `data.region_time_zone`；zzz-signal-search-export 用 region→时区表：prod_gf_cn/jp/sg +8、prod_gf_us -5、prod_gf_eu +1 |
| 保留期 | stardb 称“Mihoyo has the tendency to delete pull history every 6 months” **[第三方，未核实]** |

出处：
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/ZZZ/ZZZGachaClient.cs （开源）
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/ZZZ/ZZZGachaType.cs （开源）
- https://github.com/earthjasonlin/zzz-signal-search-export/blob/main/src/main/getData.js （开源）
- https://github.com/Rettend/zzz-pull-planner/blob/main/DATA.md （开源：返回样例，2025-10~12）
- https://stardb.gg/posts/signal-tracker-updates （第三方，从搜索摘要获得）

### 1.5 崩坏3

**没有找到类似的 authkey 抽卡记录接口**。Starward 只为崩坏3保留了注册表路径，没有抽卡客户端；UIGF、genshin.py、HoYo.Gacha 等也都没有崩坏3抽卡支持；搜索也没找到崩坏3补给记录导出工具。**[推测：没有可用的公开接口；也可能是补给记录不走 webview。未证实]**
- https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/GachaLogClient.cs （REG_KEY_BH3_*）

---

## 2. CORS

- **我没能亲自测**：出口代理对 mihoyo/hoyoverse 域名一律返回 403（CONNECT tunnel failed），WebFetch 解析不了这些域名。
- 开源项目的说法：WishLedger README：“Browsers block that request cross-origin (no CORS headers, and it expects headers a normal `fetch` won't send), so the *web* build routes it through our own server… a native build can call HoYoverse directly”。https://github.com/NicholasSameh/WishLedger （开源，**[单源]**）
- **[推测]** 官方记录页在 `webstatic.mihoyo.com` / `gs.hoyoverse.com`，接口在 `public-operation-*`，两者跨源，所以接口很可能对**官方来源白名单**返回 ACAO，对第三方 Origin 不放行。**所有网页版工具都走自己的服务器**，这一点也间接说明浏览器无法直连。
- **各站做法：**
  - **paimon.moe**：**经自己服务器转发**。浏览器 POST `${VITE_API_HOST}/corsproxy`，body 是 `{url: 完整 getGachaLog URL}`（含 authkey）；出现异常时还会调 `/corsreset`。导入后默认勾选“Submit pity for global wish stats”，`submitWishTally()` 会把 **uid + 每次五星的抽数/时间/类型** 等上传到 `/wish`、`/wish/total`、`/wish/constellation`。前端开源（MIT），**后端 API 不在公开仓库中**。
    - https://github.com/MadeBaruna/paimon-moe/blob/main/src/routes/wish/import.svelte
    - https://github.com/MadeBaruna/paimon-moe/blob/main/src/functions/wishTally.js
  - **stardb.gg**：**服务器端拉取**。`POST /api/warps-import {url}`，服务端用 reqwest 逐页拉取，写入 Postgres，计算全局统计。开源（juliuskreutz/stardb-api）。
    - https://github.com/juliuskreutz/stardb-api/blob/master/src/api/warps_import/mod.rs
  - **starrailstation.com / zzz.rng.moe**：站点闭源；获取链接的脚本是 Apache-2.0（`gist.githubusercontent.com/Star-Rail-Station/…/get_warp_link_os.ps1`、`https://zzz.rng.moe/scripts/get_signal_link_os.ps1`）。站点用户提交的是 URL 而不是记录 → **[推测] 服务器端拉取**（浏览器无法直连）。数据存哪里**未确认**（有 `profiles` 导出格式，见 playnite 插件对 rngMoeExport 的解析）。
    - https://github.com/Rettend/zzz-pull-planner/blob/main/DATA.md
    - https://github.com/tzrfabian/Pull-Tracker-Widget （README 中的 SRS 命令）

---

## 3. 方式 A：游戏日志 / 网页缓存里的链接

### 3.1 PC 路径（Windows）

| 游戏 | 日志 | 从日志定位游戏目录 | 缓存文件 |
|---|---|---|---|
| 原神 | `%USERPROFILE%\AppData\LocalLow\miHoYo\原神\output_log.txt`（国服）；`…\miHoYo\Genshin Impact\output_log.txt`（国际服） | 正则 `.:/.+(GenshinImpact_Data\|YuanShen_Data)` | `<游戏>\YuanShen_Data\webCaches\<版本号如 2.xx.0.0>\Cache\Cache_Data\data_2`（国际服 `GenshinImpact_Data`） |
| 星铁 | `…\miHoYo\崩坏：星穹铁道\Player.log`（国服，全角冒号）；`…\Cognosphere\Star Rail\Player.log`（国际服） | `\w:\/.*?\/StarRail_Data\/` | `StarRail_Data\webCaches\<ver>\Cache\Cache_Data\data_2` |
| 绝区零 | `…\miHoYo\绝区零\Player.log`；`…\miHoYo\ZenlessZoneZero\Player.log`（读不到时回退 `Player-prev.log`） | 日志前 16 行里的 `[Subsystems] Discovering subsystems at path …ZenlessZoneZero_Data/UnitySubsystems`，或正则 `([A-Z]:\/.*?\/)(?=ZenlessZoneZero_Data)` | `ZenlessZoneZero_Data\webCaches\<ver>\Cache\Cache_Data\data_2` |

- **定位目录**：主要靠日志（如上）；Starward 还会读启动器注册表和 `config.ini` 的 `game_install_path`；Linux/Wine 下 biuuu 系工具会从 `$WINEPREFIX/drive_c/users/$USER` 读取。
- **在 data_2 里找 URL**：data_2 是 Chromium（CEF）的磁盘缓存文件。常见做法：
  1. 先**复制**到临时目录（游戏运行时文件被占用；Starward 用 `FileShare.ReadWrite|Delete` 直接读）；
  2. 按 `1/0/` 分割（缓存键前缀），**从后往前**找含 `webview_gacha`、`getGachaLog`、`e20190909gacha` / `e20211215gacha` / `e20230424gacha` 的段；
  3. 截到 `\0` 或 `"` 为止（Starward），或用正则 `https.+?game_biz=…`；
  4. 发一个 size=5 的请求，用 `retcode==0` 验证 authkey 没过期；
  5. 把 URL 复制到剪贴板。
  - 有多个版本目录时：取最近修改的（jogerj/Starward），或版本号最大的（rng.moe）。jogerj 的脚本还会检查缓存是否超过 2 天，并提示清空 webCaches。
- 其他获取方式：
  - **代理模式**：genshin-wish-export 用 node-mitmproxy 改系统代理，截获 `webstatic*.mihoyo|hoyoverse.com` 带 authkey 的请求。
  - **剪贴板 HTML**：paimon.moe 的“pc3”方法。在游戏内记录页 Ctrl+A/Ctrl+C，PowerShell 读 `Get-Clipboard -TextFormatType Html` 中的 `SourceURL:`。
  - **手动打开 data_2**：用记事本打开，Ctrl+F 搜 `e20190909gacha`。
- 出处（开源）：
  - https://github.com/jogerj/genshin-wish-url/blob/main/Get-WishUrl.ps1
  - https://github.com/kujou2k/gacha-tracker/blob/main/assets/scripts/stardb-genshin.ps1
  - https://github.com/studiobutter/gacha-stuff/blob/main/gacha_clipboard/getlink.ps1
  - https://github.com/NousIndex/draw_import （starrail_link.ps1、zzz_link.ps1）
  - https://github.com/Rettend/zzz-pull-planner/blob/main/DATA.md （rng.moe 脚本全文）
  - https://github.com/biuuu/star-rail-warp-export/blob/main/src/main/getData.js
  - https://github.com/earthjasonlin/zzz-signal-search-export/blob/main/src/main/getData.js
  - https://github.com/biuuu/genshin-wish-export/blob/main/src/main/getData.js
  - https://github.com/Scighost/Starward/blob/main/src/Starward.Core/Gacha/GachaLogClient.cs
  - https://github.com/MadeBaruna/paimon-moe/blob/main/src/locales/en.json （pc5 手动方法步骤）
  - https://github.com/lgou2w/HoYo.Gacha （“无需任何本地代理服务器，只需读取 Chromium 硬盘缓存”）

### 3.2 一键 PowerShell 脚本的原理与风险

- **典型形式**：
  - paimon.moe：`Set-ExecutionPolicy Bypass -Scope Process -Force; … iex "&{$((New-Object System.Net.WebClient).DownloadString('https://gist.github.com/MadeBaruna/…/raw/getlink.ps1'))} global"`
  - SRS / rng.moe：`[Net.ServicePointManager]::SecurityProtocol = … Tls12; Invoke-Expression (New-Object Net.WebClient).DownloadString("https://…/get_warp_link_os.ps1?cachebust=srs")`
  - jogerj：`iex (irm 'https://github.com/jogerj/genshin-wish-url/raw/main/Get-WishUrl.ps1')`
- **脚本做的事**：读日志 → 找游戏目录 → 复制 data_2 → 提取 URL → 对米哈游发一次验证请求 → `Set-Clipboard`。**本身不上传 URL**（看过 jogerj、stardb、studiobutter、rng.moe 的版本），部分脚本会请求以管理员身份重跑。
- **风险**（**[推测/常识，结合代码观察]**）：
  1. `iex(irm …)` 执行的是**下载那一刻**远端的内容，用户看到的命令里没有代码，远端（gist、站点 `/scripts/` 路径、带 `?cachebust` 的地址）随时可以改，事后也难以审计；
  2. 自动绕过 ExecutionPolicy（`-Scope Process Bypass`）；
  3. 部分脚本会以管理员权限重新运行（`Start-Process powershell -Verb runAs`），一旦被篡改，危害就是整机；
  4. 社区教会了大量用户“复制粘贴 PowerShell”这个动作，钓鱼站可以模仿（同样的社工模式还有 ClickFix 类攻击）；
  5. 站点的域名、gist 账号被盗或被出售，都会变成供应链攻击。
- **缓解办法**：
  - 把固定 commit 的脚本作为文件下载，并给出 SHA-256；
  - 在页面上展示脚本全文；
  - 不请求管理员权限；
  - 只读不写，不联网（不在脚本里调米哈游，验证交给网页）；
  - 或者干脆让用户在网页里选择 data_2 文件，由浏览器本地解析（见第 7 节，需要实测）。

### 3.3 authkey 有效期、权限、泄露风险

- **有效期 24 小时**：genshin.py 文档：“They last only 24 hours, and it's impossible to do any write operations with them.” **[文档；社区普遍说法一致；不同游戏未逐一确认]**。HackMD 笔记说只有 10–20 分钟（**未能打开原文，可信度低**）。
  - https://github.com/seriaati/genshin.py/blob/master/docs/authentication.md
- **权限范围**：
  - 2.3 起抽卡接口只认 `auth_appid=webview_gacha` 的 authkey。原石/摩拉/结晶等流水（`hk4e-api.mihoyo.com/common/hk4e_self_help_query/User/GetPrimogemLog` 等，旧路径 `/ysulog/api/`）用的是 **`auth_appid=csc`** 的 authkey（genshin.py 文档：“Transaction logs use a different kind of authkey, pass `auth_appid="csc"`”；Miao-Yunzai 的 payLogData.js 使用 `auth_appid=csc&csc_authkey_required=true`）。
  - → **游戏内抽卡链接里的 authkey 很可能只能读抽卡记录（含 UID）**。**[推测：没有找到“webview_gacha authkey 调 csc 接口失败”的直接测试记录；旧版 genshinstats（2021）曾用同一个 authkey 读流水 → 已过时]**
  - 出处：https://github.com/yoimiya-kokomi/Miao-Yunzai/blob/master/plugins/genshin/model/payLogData.js （开源）；https://github.com/ashleney/genshinstats/blob/master/genshinstats/transactions.py （开源，**过时**）
- **泄露风险**：
  - 只读、24 小时内有效、限于抽卡记录 + UID + 物品名 + 时间；
  - 但 URL 可能附带设备、版本、坐标等参数；
  - 公开仓库里**确实能搜到别人提交的完整带 authkey 的 URL**（2021、2025 年的例子都有），说明用户和开发者常把它当成普通链接对待。
  - genshin.py 甚至说 authkey “absolutely safe to share”——**我认为表述过度**，至少应提醒“不要公开分享”。jogerj、云原神脚本、Pull-Tracker-Widget 都提醒不要分享。
- **手机端**：
  - **Android**：老方法“断网后刷新页面，错误页显示 URL”在 3.1 后失效（paimon.moe：“The old android method is not working on 3.1”）**[过时]**。现行方法是 **ADB logcat** 抓 `OnGetWebViewPageFinish` 行（Termux 无线调试、WebADB、PC 脚本、Remote ADB Shell），不需要 root；作者 2024-10 称仍可用，gist 2026-05 仍活跃。**难度高**（开发者选项、配对）。
    - https://gist.github.com/jogerj/2372d0e5bee51e001a6d8956240d527b （文档；通过 WebFetch 读取摘要）
  - **iOS**：抓包（paimon.moe 写的是 Stream App：装 VPN 配置 + 信任 CA → 开记录页 → 在抓包历史里找 `.json` 请求）。genshin.py 文档：“iOS: No clue, maybe use a sniffer.” **难度很高**；装 CA 本身也有安全代价。
  - **PlayStation**（原神）：游戏内邮件里网页活动的二维码 → 手机扫码得到链接（paimon.moe，**未验证当前是否可用**）；或者把 PS 账号关联 HoYoverse 账号后走其他方式。
  - **云游戏**：云原神网页版（`ys.mihoyo.com/cloud`）里打开的记录页就在浏览器 DOM/iframe 中，可以用油猴脚本抓取（genshin-cloud-gacha-link-fetcher，支持 PC 和 Kiwi/Edge/Alook 移动浏览器）；也可以用浏览器开发者工具。星铁、绝区零的云游戏 **[推测类似，未验证]**。
    - https://github.com/com16332767-ui/genshin-cloud-gacha-link-fetcher
  - **结论**：手机端拿 authkey 链接很难，这正是 stoken 登录方案流行的主要原因。

---

## 4. 方式 B：登录米游社 / HoYoLAB

### 4.1 凭据一览

| 凭据 | 说明 | 出处 |
|---|---|---|
| `login_ticket` | 米游社通行证网页登录凭证，可换 SToken/LToken（`getMultiTokenByLoginTicket?token_types=3`），**有效期 30 分钟** | mihoyo-api-collect authentication.md；Snap.Hutao ApiEndpoints.csv |
| `stoken` v1 / v2 | 米游社 App 登录态。v1 配 `stuid`；v2 以 `v2_` 开头，配 `mid`。v1 可经 `getTokenBySToken` 换成 v2。**改密码后变化**。可以换 cookie_token、ltoken、authkey、action_ticket、**游戏登录 auth ticket** | 同上；Snap.Hutao 代码 |
| `mid` | 米哈游通行证 ID（与 `ltmid_v2` 同值） | mihoyo-api-collect |
| `ltoken` / `ltoken_v2`（配 ltuid / ltmid_v2） | 网页端查询游戏账号信息（战绩等）；改密码后变化 | mihoyo-api-collect |
| `cookie_token` / `cookie_token_v2`（配 account_id / account_mid_v2） | 网页活动、兑换码等；可由 stoken 刷新（`getCookieAccountInfoBySToken`）。**国际服可用它直接生成 authkey** | genshin.py |
| `game_token` | 游戏登录凭证（游戏 SDK 扫码得到），可换 stoken（`getTokenByGameToken`）/ cookie_token | genshin.py routes.py；Snap.Hutao |
| `action_ticket` | 米游社内部分网页操作的一次性凭证（`getActionTicketBySToken?action_type=…`） | Snap.Hutao AuthClient.cs |
| `authkey` | 见上；米游社联系客服页面也用 | mihoyo-api-collect |

- https://github.com/UIGF-org/mihoyo-api-collect/blob/main/other/authentication.md （文档；该仓库已标为过时，转到 https://github.com/UIGF-org/mihoyo-api-sdk）
- https://github.com/wangdage12/Snap.Hutao/blob/main/src/Snap.Hutao/Snap.Hutao/ApiEndpoints.csv （开源，**端点总表，非常有用**）

### 4.2 stoken → authkey（国服）

- `POST https://api-takumi.mihoyo.com/binding/api/genAuthKey`
  - body：`{"auth_appid":"webview_gacha","game_biz":"hk4e_cn","game_uid":<int>,"region":"cn_gf01"}`
  - Cookie：stoken + mid（v2）
  - 头部：`x-rpc-device_fp`、`x-rpc-app_version=<米游社版本>`、`x-rpc-client_type=5`、`x-rpc-device_id`、`User-Agent: … miHoYoBBS/<ver>`、`Referer: https://app.mihoyo.com`
  - **DS 签名**：Gen1 + LK2 salt
  - 返回 `{authkey, authkey_ver, sign_type}`，拼成查询串再调 getGachaLog
  - 还有 `https://app.mihoyo.com/account/auth/api/genAuthKey`（AppAuthGenAuthKey）
  - 出处：https://github.com/wangdage12/Snap.Hutao/blob/main/src/Snap.Hutao/Snap.Hutao/Web/Hoyolab/Takumi/Binding/BindingClient2.cs ；https://github.com/wangdage12/Snap.Hutao/blob/main/src/Snap.Hutao/Snap.Hutao/Web/Hoyolab/Takumi/Binding/GenAuthKeyData.cs ；https://github.com/wangdage12/Snap.Hutao/blob/main/src/Snap.Hutao/Snap.Hutao/Service/GachaLog/QueryProvider/GachaLogQuerySTokenProvider.cs
  - 星铁、绝区零只需替换 `game_biz`（`hkrpg_cn`/`nap_cn`）**[推测；Snap.Hutao 只做原神]**
- **Snap.Hutao 的 SToken 刷新明确不支持国际服**：代码在 `userAndUid.IsOversea` 时返回 `ServiceGachaLogUrlProviderStokenUnsupported`；文档也写“SToken 刷新方法暂不支持国际服”。
- **DS salt 会随米游社版本变化**：mihoyo-api-collect：“每个APP版本都存有其独有的`salt`”“请求头的`x-rpc-client_type`字段，每个值使用的`salt`不同”。Snap.Hutao 构建时从 `https://internal.gentle.house/Archive/Salt/Latest` 拉取最新的 `CNVersion/CNK2/CNLK2/OSVersion/OSK2/OSLK2`（源码生成器）；X4/X6/PROD 等 salt 写死在代码里。Remastered 分支里留存的版本号是 CN 2.95.1 / OS 2.54.0。**[确认]**
  - https://github.com/DGP-Studio/Snap.Hutao.SourceGeneration/blob/main/src/Snap.Hutao.SourceGeneration/Snap.Hutao.SourceGeneration/Automation/SaltConstantGenerator.cs
  - https://github.com/wangdage12/Snap.Hutao/blob/main/src/Snap.Hutao/Snap.Hutao/Web/Hoyolab/HoyolabOptions.cs
  - 意味着网页实现必须把 salt 放进前端或 Worker，并跟着米游社版本持续更新，维护负担很重；salt 是从官方 App 逆向得到的，合规上属灰色。
- **device_fp**：`https://public-data-api.mihoyo.com/device-fp/api/getFp`（国际服 `sg-public-data-api.hoyoverse.com`）。device_id 通常用随机 UUID（Snap.Hutao：DeviceId36/40/53）。
- **风控与极验**：胡桃文档：“自 2022 年 10 月起，米游社极大地提高了账号被判定为有风险的概率”；1034 验证失败要手动完成验证；“若绑定多个 Bot 或设备频繁访问米游社数据，可能触发米游社的安全限制”。密码、短信登录要过极验（`x-rpc-aigis`）。Snap.Hutao 的鸿蒙移植计划中甚至有“极验自定义组合接口”（让用户配置第三方打码接口）——**灰色**。
  - https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered.Docs/blob/master/docs/zh/features/mhy-account-switch.md
  - https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered.Docs/blob/master/docs/zh/advanced/exceptions.md
  - https://github.com/aichi-chishan/Snap.Hutao.HarmonyOS/blob/main/PORTING_PLAN.md
- **扫码登录**：
  1. **米游社 App 扫码（通行证）**：`POST passport-api.mihoyo.com/account/ma-cn-passport/app/createQRLogin` → 轮询 `…/app/queryQRLoginStatus`（genshin.py 用 `passport-api.miyoushe.com/…/web/createQRLogin`），确认后直接得到 stoken v2 + mid 等。Snap.Hutao 发起时带 `x-rpc-app_id=ddxf5dufpuyo`（HoYoPlay 的 app_id）。
  2. **游戏 SDK 二维码**：`POST hk4e-sdk.mihoyo.com/hk4e_cn/combo/panda/qrcode/fetch {app_id, device}` → 用米游社扫码确认 → `…/qrcode/query` 拿到 `game_token` + uid → `passport-api.mihoyo.com/account/ma-cn-session/app/getTokenByGameToken` 换 stoken v2。Snap.Hutao 的 PandaClient 用 app_id=8。
  - 两者都只适用于**国服**。
  - 出处：https://github.com/wangdage12/Snap.Hutao/blob/main/src/Snap.Hutao/Snap.Hutao/Web/Hoyolab/Passport/HoyoPlayPassportClient.cs ；https://github.com/wangdage12/Snap.Hutao/blob/main/src/Snap.Hutao/Snap.Hutao/Web/Hoyolab/Hk4e/Sdk/Combo/PandaClient.cs ；https://github.com/seriaati/genshin.py/blob/master/genshin/client/routes.py
- **国际服 HoYoLAB 的等价做法**：genshin.py `fetch_authkey()`：`POST https://api-account-os.hoyoverse.com/binding/api/genAuthKeyByCookieToken`，需要 `cookie_token_v2 + account_mid_v2 + account_id_v2`，body `{game_uid, region, game_biz, auth_appid: webview_gacha|csc}`。Snap.Hutao 端点表里也有 `api-account-os.hoyoverse.com/binding/api/genAuthKey`（用 stoken），但胡桃自己没用于国际服。HoYoLAB 登录方式：密码登录（`sg-public-api.hoyoverse.com/account/ma-passport/api/appLoginByPassword`，需要验证码/aigis）、三方登录、浏览器 Cookie。胡桃文档：“HoYoLAB 默认阻拦来自中国大陆的网络连接”。国际服 stoken 刷新 cookie：`sg-public-api.hoyoverse.com/account/ma-passport/token/getBySToken`。
  - https://github.com/seriaati/genshin.py/blob/master/genshin/client/components/gacha.py ；https://github.com/seriaati/genshin.py/blob/master/docs/authentication.md

### 4.3 这条路的安全代价

- **stoken 能做什么（代码可证）**：
  - 换 cookie_token / ltoken（`getCookieAccountInfoBySToken`、`getLTokenBySToken`）→ 所有网页功能；
  - 生成任意 auth_appid 的 authkey（抽卡、`csc` 客服/资源流水）；
  - `getActionTicketBySToken`；
  - 列出账号下的游戏角色（`getUserGameRolesByStoken`）；
  - **`createAuthTicketByGameBiz` 生成游戏登录票据，直接登录游戏客户端**：Snap.Hutao 的 `LaunchExecutionGameIdentityHandler`、Starward 的 `GameAuthLoginService` 都这么用，国服、国际服都有对应端点。这等于能用这个账号进游戏，可以消耗原石、分解物品等；
  - 刷新自身（Starward 调 `ma-cn-session/app/verify` 拿 `new_token`）。该 verify 响应里还有 `realname_info`、`need_realperson` 字段 → **能读到实名相关信息（多半是脱敏后的）[字段存在已确认，内容未确认]**。
- **能否改密码、换绑**：没有证据表明 stoken 单独就能改密码；按惯例这类操作需要短信或邮箱验证码 **[推测]**。改密码会让 stoken 和 ltoken 失效（mihoyo-api-collect）。
- **结论**：stoken 约等于“米游社 App 的登录态 + 能登录游戏”，**接近账号完全控制**（敏感操作有二次验证的除外），而且长期有效，直到注销或改密码。
- **开源工具如何保存**：
  - **Snap.Hutao**：SQLite 表 `users` 的 `Stoken` 列，`HasConversion(e => e!.ToString(), …)` 存的是**明文 TEXT**（wangdage12 分支）。文档提醒：“`SToken` 是一个安全敏感的 Cookie 字段，你**不应该**在任何云端或其它无法保证数据安全的设备上储存含有 `SToken` 字段的 Cookie”“登录过程中数据只经米游社服务器和本地胡桃工具箱处理”。
    - https://github.com/wangdage12/Snap.Hutao/blob/main/src/Snap.Hutao/Snap.Hutao/Model/Entity/Configuration/UserConfiguration.cs
  - **Starward**：`stoken`、`mid` **明文**写入 `config.ini` 或注册表（`key.SetValue("stoken", stoken)`），用于“使用米游社账号登录游戏”功能（仅国服）。
    - https://github.com/Scighost/Starward/blob/main/src/Starward/AppConfig.Configuration.cs
    - https://github.com/Scighost/Starward/blob/main/src/Starward/Features/GameLauncher/GameAuthLoginService.cs
  - **QQ / Discord 机器人**（Yunzai、hoyo-buddy 等）：服务器端保存用户提交的 cookie/stoken，**托管风险最大**。米游社签到类项目普遍自带“可能封号、米游币清零”的免责声明（搜索摘要）。
- **事故与案例**：
  - **米哈游诉“游创工坊”（北京市石景山区人民法院）**：被告运营“抽卡分析小工具”，**模仿《原神》/米游社登录界面**获取玩家抽卡数据、角色数据。法院曾裁定诉中禁令，删除相关公众号文章；报道称一审认定构成侵权/不正当竞争，并指出其“在获取用户游戏数据时并未对此进行任何提示并征得用户同意”。**[第三方新闻二手摘要，原文和判决书未能打开]**
    - https://news.qq.com/rain/a/20231022A0756V00 （2023-10）
    - https://m.bjnews.com.cn/detail/1713706186169852.html （2024-04）
    - https://www.zhihu.com/question/627458384/answer/3262585872
  - 社区评论把“非小酋、提瓦特小助手、游创工坊、Hutao”归为“用含 Stoken 的 Cookie 获取抽卡链接”一类（搜索摘要转述知乎，**[第三方观点]**）。
  - **没有找到“因为用 authkey 导出抽卡记录被封号”的可靠案例。**
- **米哈游的态度与条款**：
  - 国服游戏许可协议禁止“通过非米哈游开发、授权的第三方软件、插件、外挂、系统，使用米哈游游戏及米哈游游戏服务，或制作、发布、传播…”，还提醒外部软件“可能窃取玩家存储在终端设备中的账号、密码等个人信息”。**[官方条款，经搜索摘要引用；PDF 原文被代理拦截]**
    - https://webstatic.mihoyo.com/upload/static-resource/2023/05/22/402907539669967ce473d0a3205df5bc_1436791302714687787.pdf （原神）
    - https://fastcdn.mihoyo.com/static-resource-v2/2025/12/30/f91a0c8796a63ce69bb054d096371593_7574548664798296571.pdf （绝区零，2025-12）
  - HoYoverse 安全提醒：“Do not provide sensitive security information such as account passwords, SMS, and email verification codes to others. Do not share your account with others.” https://www.siliconera.com/genshin-impact-account-security-reminder-issued-after-phishing-issues/ （第三方转述官方）
  - **[推测]** 只读 authkey 的导出工具多年来被默许（游戏内没有导出功能，官方也没有针对性封禁）；但代人保存 stoken、模仿登录界面的产品已有被起诉的先例。

---

## 5. 标准与生态

### 5.1 UIGF v4.2（当前版本）

- 文档：https://github.com/UIGF-org/UIGF-org.github.io/blob/main/docs/zh/standards/uigf.md ；Schema：https://github.com/UIGF-org/UIGF-org.github.io/blob/main/docs/.vuepress/public/schema/uigf.json ；在线校验：https://schema.uigf.org/?schema=uigf
- 版本历史：v4.0 合并 SRGF、加入绝区零；v4.1 加入星铁 v3.4 的新卡池类型；v4.2 加入千星奇域。v4.x **不向下兼容** v3.0 及以下和 SRGF v1.0。
- **单文件多游戏、多账号**。顶层结构：
  - `info{export_timestamp, export_app, export_app_version, version:"v4.2"}`（必填）
  - `hk4e[]`、`hkrpg[]`、`nap[]`、`hk4e_ugc[]`，每项是 `{uid, timezone(int), lang?, list[]}`
- 各游戏 list 的必填字段：
  - **hk4e**：`uigf_gacha_type`(100/200/301/302/500)、`gacha_type`(100/200/301/302/400/500)、`item_id`、`time`、`id`；可选 count/name/item_type/rank_type
  - **hkrpg**：`gacha_type`(1/2/11/12/21/22)、`gacha_id`、`time`、`item_id`、`id`
  - **nap**：`gacha_type`(1/2/3/5)、`item_id`、`time`、`id`（**102/103 不在枚举里**）
  - **hk4e_ugc**：`id, schedule_id, item_type, item_id, item_name, rank_type, time, op_gacha_type(1000/2000/20011/20012/20021/20022)` 全部必填
  - 所有字段都是**字符串**类型（id 最长 19 位数字）
- **时区处理**：`timezone` 为整数偏移，“由米哈游 API 返回，若与服务器时区不同请注意 list 中 time 的转换”；`time` 是“抽取物品时对应时区（timezone）下的当地时间”，格式 `YYYY-MM-DD HH:mm:ss`。实践中原神按区服/UID 推断（-5 / +1 / +8），星铁和绝区零读 `region_time_zone`。
- 认证要求：“针对某一款游戏的支持，必须同时实现数据的导入和导出功能”，并要求在应用内链接到 uigf.org。
- **JS 实现提示**：19 位 id 超出 Number 的 53 位精度 → 必须用 string 或 BigInt（GoneTone 设计文档有同样提醒）。

### 5.2 item_id → 名称 / 星级的元数据

| 来源 | 覆盖 | 形式 | 备注 |
|---|---|---|---|
| UIGF API `api.uigf.org` | 文档写 genshin/starrail；代码里还有 `zzz`（game id 3） | `POST /translate/`、`GET /identify/{game}/{text}`、`GET /dict/{game}/{lang}.json`、`/md5/{game}` | 开源（UIGF-org/UIGF-API）。数据来源：原神来自 **DGP-Studio/Snap.Metadata 的 zip（该仓库现已 404 → 有断供风险）**，星铁来自 Dimbreath turnbasedgamedata（GitLab），绝区零来自 git.mero.moe/dimbreath/ZenlessData。只有名称↔ID，**没有星级**。 |
| Yatta（原 Project Amber / ambr.top） | `gi.yatta.moe/api/v2/{lang}/avatar` 等，也有 sr/zzz 子站 | 非官方 JSON API | genshin.py、TeyvatGuide、GenshinUID 在用；无 SLA |
| Hakush `api.hakush.in` | `/gi/data/…`、`/hsr/data/…`、`/zzz/data/character.json`、`equipment.json`、`new.json` | 非官方 JSON | 有人在用（2026 年的仓库），无 SLA |
| EnkaNetwork API-docs store | `store/gi/avatars.json`、`locs.json`、`store/hsr/honker_characters.json`、`store/zzz/avatars.json`、`weapons.json` | GitHub raw（实测 200） | 主要服务 Enka 展示；原神武器覆盖不全 **[推测]** |
| Mar-7th/StarRailRes | `index_new/{lang}/characters.json`、`light_cones.json` | GitHub raw（实测 200） | 星铁 |
| Starward 静态元数据 | `starward-static.scighost.com/metadata/v1/zzz/ZZZGachaInfo.*.json`、千星奇域 `GenshinBeyondGachaInfo.json` | CDN | Starward 自用 |
| 官方 | 国服 `api-takumi.mihoyo.com/event/platsimulator/config?gids=2&game=hk4e`、`/event/rpgsimulator/config?game=hkrpg`；国际服 `sg-public-api.hoyolab.com/event/simulatoros/config`、`/event/rpgcalc/avatar|equipment/list` | 官方未公开文档的接口（Starward 在用） | 有 CORS 问题，需要转发 |

- **建议**：**构建期**从 git 仓库（Enka store、StarRailRes、Dimbreath 数据）生成静态 JSON 一起发布；运行时不依赖第三方 API。星级可以直接用 API 返回的 `rank_type`。原神 item_id 为空时，按 (lang, name) 映射。
- 出处：
  - https://github.com/UIGF-org/UIGF-org.github.io/blob/main/docs/zh/api.md
  - https://github.com/UIGF-org/UIGF-API/blob/main/fetcher.py
  - https://github.com/UIGF-org/UIGF-API/blob/main/api_config.py
  - https://github.com/seriaati/genshin.py/blob/master/genshin/utility/extdb.py
  - https://github.com/EnkaNetwork/API-docs
  - https://github.com/Mar-7th/StarRailRes

---

## 6. 主流工具对比

| 工具 | 平台 | 获取方式 | 开源 | 数据存放 | 备注 |
|---|---|---|---|---|---|
| paimon.moe | 网页（原神） | PowerShell `iex` 远程 gist；手动粘贴 URL；剪贴板 HTML；手动搜 data_2；iOS 抓包（Stream）；PS 邮件二维码；Android 旧法已失效 | 前端 MIT；后端 API 不公开 | 浏览器本地（localforage），可选 Google Drive 同步；**拉取经自家服务器 `/corsproxy`**；**默认勾选上传 pity 统计（含 uid）** | https://github.com/MadeBaruna/paimon-moe |
| Snap.Hutao（原 DGP-Studio，**原仓库现 404**；现有分支 wangdage12、Remastered、Rev 等） | Windows | **SToken 刷新（米游社登录：短信、扫码、Cookie；仅国服）**；网页缓存（含国际服）；手动 URL | MIT（分支） | 本地 SQLite（stoken **明文**）；可选“胡桃云”上传抽卡存档 | 文档 https://github.com/SnapHutaoRemasteringProject/Snap.Hutao.Remastered.Docs |
| Starward | Windows（WinUI） | 网页缓存 data_2；手动 URL；（另有 stoken 用于登录游戏，与抽卡无关） | MIT | 本地 SQLite；stoken 明文存在 config.ini 或注册表 | https://github.com/Scighost/Starward 支持原神、千星奇域、星铁、绝区零 |
| genshin-wish-export（biuuu） | Windows Electron（Wine 可用） | 日志 + 缓存；**MITM 代理模式** | MIT | 本地 `userData` JSON | 姊妹项目：star-rail-warp-export（biuuu）、zzz-signal-search-export（earthjasonlin） |
| HoYo.Gacha（lgou2w） | Windows（Tauri） | 读 Chromium 磁盘缓存 | MIT/Apache-2.0 | 本地 SQLite（`HoYo.Gacha.v1.db`） | 支持 UIGF v2.0–v4.2；https://github.com/lgou2w/HoYo.Gacha |
| starrailstation.com | 网页（星铁） | PowerShell `Invoke-Expression` 远程脚本（Apache-2.0） | 站点闭源 | **未确认**（推测服务器端拉取并保存） | 脚本 `gist.githubusercontent.com/Star-Rail-Station/2512df54…/get_warp_link_os.ps1` |
| zzz.rng.moe | 网页（绝区零） | PowerShell `Invoke-Expression https://zzz.rng.moe/scripts/get_signal_link_os.ps1` | 站点闭源；脚本 Apache-2.0 | **未确认**（同上，与 SRS 同团队，有 profiles 导出） | |
| stardb.gg | 网页（原神、星铁、绝区零） | PowerShell 脚本（`stardb-genshin.ps1` 等）+ 粘贴 URL | 开源（juliuskreutz/stardb-api 等） | **服务器 Postgres**（服务端拉取，做全局统计） | genshin.py 文档推荐的 PC 获取方式 |
| 官方：游戏内历史记录 | 游戏内 | — | — | 米哈游服务器（原神 1 年；星铁、绝区零社区称 6 个月） | 无导出、无统计 |
| 官方：米游社 App | 手机 | 攻略称可在“旅行工具 / 原神战绩”查看抽卡记录 | — | — | **未核实**（第三方攻略，2023 年前后）；没有长期保存或导出 |
| 官方：HoYoLAB | — | 没找到抽卡记录功能 | — | — | **未核实** |
| 第三方小程序：提瓦特小助手、非小酋 | 微信小程序 / 网页 | 米游社登录（stoken）或粘贴链接 | 闭源 | 服务器 | 被社区归为“stoken 获取”类 |

---

## 7. 建议（针对“隐私优先、可审计、本地存储”的新站）

### 7.1 默认与可选

1. **默认**：**方式 A（粘贴 authkey 链接）+ Worker 同源转发**。
   - 前端只接收 URL，在**浏览器里**解析，剥离多余参数，只把 `authkey/authkey_ver/sign_type/lang/game_biz` 和分页参数交给 Worker；
   - 记录写入 IndexedDB；authkey 只放内存，不持久化（24 小时后本来也没用）。
2. **获取链接的辅助**（按隐私从好到差）：
   - a. **在网页里选择 data_2 文件，浏览器本地解析**（无需执行任何脚本）。**[需实测]**：游戏运行时浏览器能否读到这个文件；webCaches 路径很深，需要给出路径说明。data_2 里还可能有其他敏感 URL（例如 csc 客服 authkey），**只在本地解析，只提取抽卡 URL**。
   - b. **提供可下载、固定版本、带 SHA-256、页面上展示全文的本地脚本**：只读、不联网、不请求管理员权限、只把 URL 放进剪贴板。**不推荐** `iex(irm …)`；如果一定要给一行命令，指向固定 commit 的 raw URL。
   - c. 手动在 data_2 里搜索（paimon.moe 的 pc5 方法）。
   - d. 云游戏用户：油猴脚本或开发者工具。
3. **可选**：**UIGF v4.2 导入/导出**（列为一等功能）。手机用户、主机用户可以先用其他工具（Snap.Hutao、Starward、HoYo.Gacha 等）拿到数据，再导入本站。UIGF 认证要求导入和导出都实现。
4. **高级 / 可选**：完全离线模式。提供开源本地脚本，直接拉取全部记录并输出 UIGF 文件，网站只负责导入 → authkey 不经过任何服务器。
5. **不建议**提供米游社 / HoYoLAB 登录（stoken、cookie_token_v2）：
   - 浏览器跨域限制 → 必须经 Worker，这会让**长期有效、接近账号完全控制的凭据**经过服务端；
   - 需要把逆向得到的 DS salt 放进可审计的代码里，并且要跟着米游社版本持续更新；
   - 有风控和极验，在网页里体验很差；
   - 有法律先例：模仿登录界面获取数据的工具被起诉；
   - 与 ArkRecord 的定位（token 只是请求时临时经过）冲突更大：authkey 是 24 小时只读，stoken 等于账号本身。
   - 如果确实需要支持手机端国服用户，建议引导他们用本地开源客户端（Snap.Hutao 分支、Starward），再导入 UIGF。

### 7.2 Worker 转发：与鹰角的异同与注意点

ArkRecord-Web 现有设计已经做到：浏览器→Worker 一律 POST，参数放在 body；`observability.enabled=false`；路由白名单；同源与自定义头校验；Cloudflare 限速；上游 `cache: 'no-store'`、`redirect: 'manual'`；错误信息里不带上游 URL。可直接复用。米哈游特有的注意点如下：
1. **authkey 必须出现在上游 URL 的查询参数里**（和鹰角一样）。所以要继续关闭 Workers Logs、Traces、Tail，不要 `console.log` 上游 URL 或异常的 `.message`；Logpush 也只会记录入站 URL，所以入站请求**不能**带 authkey（保持 POST body）。
2. **严格的上游白名单**：只允许
   - host：`public-operation-hk4e(-sg)`、`public-operation-hkrpg(-sg)`、`public-operation-nap(-sg)`；
   - path：`/gacha_info/api/getGachaLog`、`/gacha_info/api/getBeyondGachaLog`、`/common/{gacha_record|hkrpg_gacha_record}/api/{getGachaLog|getLdGachaLog}`。
   **不要**允许 `hk4e_self_help_query`、`ysulog` 等流水接口，以及 `api-takumi` 等账号接口，避免 Worker 被当成通用的“authkey 代理”。
3. **查询参数白名单**：authkey、authkey_ver(=1)、sign_type(=2)、lang（枚举）、game_biz（枚举）、gacha_type / real_gacha_type（数字白名单）、page、size(≤20，千星奇域 ≤5)、end_id（`^\d{1,19}$`）。丢弃 `ext`（坐标）、`device_type`、`game_version`、`timestamp`、`gacha_id`、`region` 等。
4. **authkey 编码**：用户粘贴的 authkey 往往已经 URL 编码（`%2B` `%2F`），也可能被二次编码，或者含原始的 `+`/`=`。参考 biuuu 的 `fixAuthkey` 和 genshin.py 的 `unquote`：**先解码一次，再由 URLSearchParams 统一编码**，否则 `+` 会被当成空格，导致 `authkey error`。长度约 1 KB，ArkRecord 现有的 `MAX_QUERY_VALUE=2048` 够用。
5. **限速**：米哈游的 `-110 visit too frequently` 阈值不明，可能按 IP 或 authkey 计，**[未知]**。Worker 的出口 IP 是 Cloudflare 共享池，多用户可能互相影响。前端应串行抓取、每页 300–600ms、遇 -110 退避；Worker 侧按客户端 IP 限速。一个账号满一年的记录约几十到上百页（每页 20 条）。
6. **缓存**：URL 里带 authkey，**绝不能**进 Cloudflare 边缘缓存或 Cache API（paimon.moe 的 `/corsreset` 暗示他们遇到过代理缓存的问题）。上游请求用 `cache:'no-store'`，响应加 `Cache-Control: no-store`。
7. **响应处理**：只透传 JSON；可以在 Worker 里校验 `retcode`，但不要记录 `list`（含 uid）。
8. **不要像 paimon.moe 那样默认上传统计**：如果要做全局统计，就照 ArkRecord 现有的匿名计数方式，并且默认关闭、明确告知用户。
9. **国服可达性**：paimon.moe、stardb 从境外服务器访问国服接口都能用 **[推测：所以 Cloudflare 也能用]**；国内用户访问 Cloudflare 的可达性与 ArkRecord 现状相同。
10. **数据正确性**：时区（原神按区服推断 -5/+1/+8；星铁、绝区零读 `region_time_zone`）；19 位 id 用字符串；原神 item_id 为空需要映射；原神 301 查询会混入 400 的记录；绝区零用 real_gacha_type；星铁联动池换 getLdGachaLog；千星奇域换接口和字段。

---

## 8. 未能完成或待实测的事项

- 亲自测 CORS 响应头（代理拦截了）。建议在本地浏览器开发者工具里用 `authkey=invalid` 实测一次：分别用 OPTIONS 和带 Origin 的 GET，观察 ACAO。
- 星铁、绝区零当前的官方保留期（6 个月？）；原神千星奇域的保留期。
- webview_gacha authkey 能否调用 csc 流水接口（预计不能，未实测）。
- 浏览器 `<input type=file>` 能否在游戏运行时读取 data_2。
- 绝区零 102/103 记录返回的 `gacha_type` 取值，以及 UIGF 的映射方式。
- `getBeyondGachaLog` 的 size 上限（5 还是 20）。
- starrailstation、zzz.rng.moe 的数据存放与隐私政策（站点被拦截）。
- 原 Snap.Hutao 仓库下线的原因。
- 米游社 App 和 HoYoLAB 是否提供官方抽卡记录入口。
