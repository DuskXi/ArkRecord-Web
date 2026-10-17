# 云同步（跨设备加密同步）设计草案

> 状态：**草案，尚未实现**。实现前需要确认第 15 节的几个决定，并完成第 14 节的实测。
>
> 命名：网站里的“同步”已经指“从鹰角拉取记录”，这个功能叫 **云同步**，避免混淆。

## 1. 目标与边界

目标：

- 同一个游戏账号（游戏 + UID）的记录，在多个浏览器、多台设备之间合并。
- 服务器（Cloudflare Worker + Durable Object）只存密文。**只知道 UID 的人拿不到任何东西，连密文也拿不到。**
- 两种模式：
  - **密码模式**（推荐）：端到端加密，只有知道密码的浏览器能解密；
  - **鹰角账号模式**（不推荐）：凭有效的鹰角 token 取回，服务器技术上能解密，只能依靠公开审计的代码。
- 本地仍然是主副本：云端出问题、忘记密码，都不影响本地数据。

不做的事：

- 不上传任何鹰角 token（账号 token、OAuth token、u8 token、角色 token 都不进云端）。
- 不同步本机设置：统计同意、反馈编号、快照、界面偏好。
- 不建立用户名、邮箱一类的账号体系。
- 密码模式不提供密码找回（设计如此）。

## 2. 设计前提（三个事实）

1. **UID 不是秘密。**游戏里能看到，分享图上也有，而且只有 9～10 位数字。对 UID 做哈希，几秒钟就能穷举反推回来。
   - 所以 UID 的哈希只能当“不直接写出 UID”的假名用，不能当秘密，更不能当加密密钥的来源。
2. **鹰角账号里没有“稳定、并且只有用户自己知道”的值。**
   - token 会失效、会变；UID、hgId 都不是秘密。
   - 鹰角接口的响应本来就经过我们的转发 Worker。
   - 所以只靠鹰角账号派生出来的密钥，服务器一定也算得出来，鹰角账号模式的保密性只能依靠服务器不作恶。这是它“不推荐”的根本原因（第 7 节）。
3. **每条记录都有幂等键**（寻访的 `key`、源石/充值的 `kind + key`）。合并就是取并集，重复合并没有副作用。
   - 所以云同步不需要处理冲突，也不需要加锁。
   - 合并逻辑直接复用导入文件的那一套（`importExportFile`）。

## 3. 原则：Worker 不信任客户端

Worker 把收到的一切都当作不可信的输入。能不能读数据、能不能写入、能不能删除，只取决于 **Worker 自己验证过的东西**，从不取决于客户端“声称”的内容。

### 3.1 每个输入怎么验证

| 客户端发来的 | Worker 怎么处理 |
|---|---|
| `game` | 白名单（`arknights` / `endfield`），其他值直接拒绝 |
| `uid` | 只出现在需要鹰角证明的请求里，只用来指明“要证明哪个角色”。Worker 必须在鹰角返回的绑定列表里找到它，否则 403。之后采用的是鹰角响应里的 uid |
| `locator` | 需要鹰角证明的请求：忽略客户端传的值，由 Worker 用核实过的 uid 自己计算。密码模式：只当查找键用，授权完全取决于 `authKey` 能否核对通过 |
| `authKey` | 和存储的 `verifier` 做常量时间比较 |
| 鹰角 token | Worker 自己调用鹰角接口核实（第 7.2 节），任何异常都按失败处理 |
| `ticket` | Worker 自己签发的 HMAC 票据：验签，用服务器时间检查是否过期，检查 `auth_epoch` 是否等于 DO 里的当前值 |
| 批次密文 | 密码模式下 Worker 解不开，只检查结构、大小、批次号格式和配额。内容是否完整由浏览器用 AES-GCM 校验 |
| `afterSeq`、`upToSeq` | 只接受 DO 当前范围内的值 |
| 时间 | 一律使用服务器时间，不采用客户端传来的时间 |

### 3.2 鹰角 token 一定会经过 Worker

- 所有权必须由 Worker 自己核实，所以开通、忘记密码时重置、鹰角账号模式这三种场景，浏览器**一定要把鹰角 token 交给 Worker**。
- 传的是 OAuth token：由账号 token 经 grant 换来，是只给“鹰角用户中心”这一个应用的授权，用途比账号 token 窄。
- 但无论传账号 token 还是 OAuth token，Worker 都能看到一个有效的鹰角凭证。所以这部分代码必须放在仓库里显眼的位置，接受公开审计（3.3）。
- 密码模式的日常读写不需要鹰角 token：授权靠 `authKey`，同样由 Worker 自己核对。

### 3.3 审计：放在显眼的位置

- **云同步中读取鹰角 token 的代码只有一个文件**：`worker/hg-verify.ts`（放在 worker 目录顶层，文件名直接说明用途）。
  - 只导出一个函数：输入请求 body，输出“核实过的 game + uid”或拒绝。从 body 里取 token 也在这个文件里完成。
  - 只请求一个写死的地址（`binding_list`），客户端不能指定。
  - 请求失败、超时、`code` 不为 0、`appCode` 不匹配、响应格式不对，一律按验证失败处理（fail closed）。
  - token 不写入存储，不写日志，不放进返回值，也不放进错误信息。
- **仓库根目录新增 `SECURITY.md`**（GitHub 会在仓库首页和 Security 页显示）。它列出 Worker 里所有会接触鹰角 token 的地方，并链接到代码：
  1. 透明转发（`worker/proxy.ts`、`worker/upstreams.ts`）：拉取记录时，账号 token 经过这里原样转发，不解析；
  2. 所有权核实（`worker/hg-verify.ts`）：云同步时，OAuth token 经过这里，用来查询绑定列表，然后丢弃。
- README 的安全说明和网站的“关于”页都链接到 `SECURITY.md`。
- **CI 加一条检查**：worker 目录下除了 `hg-verify.ts`，任何文件都不允许出现 token 字段名（`oauthToken` 等）。这样以后改代码时，不会在别处悄悄用到 token。
- **线上代码可以对照**：
  - 生产环境只通过公开仓库的 GitHub Actions 部署，运行日志公开；
  - `/api/cloud/v1/info` 返回线上部署的 commit hash，任何人都可以和仓库对照。

## 4. 总体结构：信封加密

- 每个云端账号有一把随机的**数据密钥 DEK**（AES-256-GCM），在浏览器里生成。
- 所有记录都在浏览器里用 DEK 加密后再上传。
- 两种模式只差在“DEK 由谁、用什么包起来保管”：

| | DEK 用什么包裹 | 在哪里解开 |
|---|---|---|
| 密码模式 | 由密码派生的 `kek` | 只在浏览器 |
| 鹰角账号模式 | 服务器派生的 `KEK_hg`（第 7.3 节） | 浏览器；但服务器随时能算出 `KEK_hg` |

这样分层的好处：

- 改密码只需要重新包裹 DEK，不用重新上传数据。
- 换模式也是同样的操作。但从鹰角账号模式换到密码模式时**必须换一把新 DEK**，因为旧 DEK 服务器算得出来。

## 5. 账号标识

```
locator = base64url(SHA-256("arkrecord/cloud-sync/v1/locator" ‖ 0x00 ‖ game ‖ 0x00 ‖ uid))
```

- 每个 locator 对应一个 Durable Object（`idFromName(locator)`），里面存这个账号的全部云端数据。
- locator 只是假名：服务器能穷举反推出 UID（前提 1）。它的作用是：
  - 存储里不直接出现 UID；
  - 不同游戏、不同协议版本互不混淆。
- 日常读写只带 locator，不带 UID。
- 开通，以及鹰角账号模式的认证，需要验证鹰角 token。这时 Worker 会知道 UID，并且**由 Worker 根据验证结果自己计算 locator**，不信任客户端传来的 locator。

## 6. 密码模式（推荐）

### 6.1 密钥派生（全部在浏览器里完成）

```
salt    = SHA-256("arkrecord/cloud-sync/v1/salt" ‖ 0x00 ‖ game ‖ 0x00 ‖ uid)
master  = PBKDF2-HMAC-SHA256(password, salt, 600,000 次, 输出 256 位)    // 浏览器原生 WebCrypto；次数为 OWASP 建议值
authKey = HKDF-SHA256(master, info="arkrecord/cloud-sync/v1/auth", 256 位)  // 发给服务器，证明所有权
kek     = HKDF-SHA256(master, info="arkrecord/cloud-sync/v1/kek", 256 位)   // 只留在浏览器，用来包裹 DEK
```

- **salt 由 game + uid 确定，不向服务器索取。**向服务器要 salt，本身就会暴露“这个 UID 有没有开通云同步”。
- **KDF 参数写死在协议版本 v1 里**，同样不存服务器。以后要调高参数，就出新版本，在下一次输入密码时迁移。
- `authKey` 和 `kek` 由 HKDF 分开派生：服务器拿到 `authKey`，也推不出 `kek`。

**关于位数：**

- 所有密钥（`master`、`authKey`、`kek`、DEK）都是 256 位，已经是 AES 的上限。
- **PBKDF2 的输出不能超过 256 位**（SHA-256 的长度）。
  - 超过以后，PBKDF2 会按 256 位一段分段计算，每一段都要完整跑 60 万次。
  - 我们要多花几倍时间，攻击者却只需要算出第一段就能验证一次猜测。多出来的位数只拖慢自己，不拖慢攻击者。
  - 所以只取 256 位，再用 HKDF 分出两把钥匙。
- 被暴力破解的从来不是密钥，而是**密码**。PBKDF2 抗显卡破解比 Argon2id 弱，要靠**加长密码的位数**来弥补：
  - **默认生成同步密钥**：32 个 Base32 字符（160 位随机数），显示为 8 组、每组 4 个，可以复制或下载成文件。160 位随机数无论用什么 KDF 都不可能被穷举。
  - **自定义密码**：至少 16 位，并估算强度（例如 zxcvbn），强度不够不允许设置。界面上说明“生成的同步密钥更安全”。
- 备选方案是 Argon2id：抗显卡更强，但要引入 WASM，并且 CSP 要放开 `'wasm-unsafe-eval'`。用了 160 位的生成密钥之后，两者的差别只体现在自定义密码上，所以选浏览器原生的 PBKDF2。

### 6.2 服务器保存什么

| 字段 | 内容 |
|---|---|
| `verifier` | `HMAC-SHA256(SYNC_PEPPER, authKey)`，其中 `SYNC_PEPPER` 是 Worker secret |
| `wrapped_dek` | 用 `kek` 包裹的 DEK，外面再用 `HKDF(SYNC_PEPPER, locator)` 加密一层 |
| 批次 | 密文（第 8 节） |
| 失败计数 | 连续认证失败次数和退避截止时间 |

服务器不保存：密码、`authKey`、`kek`、DEK 明文。

外面那层服务器加密，是为了防“只拿到存储”的情况（例如数据被导出）。没有 `SYNC_PEPPER` 的话：

- `verifier` 不能用来验证密码猜测；
- `wrapped_dek` 也解不开。

所以只拿到存储的人连离线猜密码都做不到。

### 6.3 证明所有权

- 请求 body 里带 `{ locator, authKey }`。DO 计算 `HMAC(SYNC_PEPPER, authKey)`，和 `verifier` 做常量时间比较，通过才返回 `wrapped_dek` 和密文。
- **只知道 UID**：能算出 locator，但没有 `authKey`，什么都拿不到，连密文也没有。
- **locator 不存在**和**密码错误**返回完全相同的 401，耗时也尽量一致，不能用来判断某个 UID 有没有开通。
- `authKey` 只放在 POST body 里，不放 URL，也不放请求头。Worker 不记录日志（observability 已关闭）。
- `authKey` 只能用来证明身份、取回密文，不能解密。

### 6.4 防在线猜密码

- 攻击者每猜一次，都要先在本地跑一次 60 万次的 PBKDF2（大约 0.5～2 秒）。
- 同一个 locator 连续失败 5 次后开始指数退避：1、2、4……分钟，最长 1 小时；成功一次就清零。
- 另有按 IP 计数的 Cloudflare Rate Limiting（新增绑定 `RL_CLOUD_AUTH`）。
- 副作用：知道你 UID 的人可以故意输错，让你这个账号暂时只能慢速认证。不会永久锁定，本地数据也不受影响。
  - 可选的增强：认证过的设备持有一个“设备凭证”，不受退避限制。第一版可以不做。

### 6.5 防离线猜密码

- 同时拿到存储和 Worker secret 的人（本站运营者、Cloudflare，或者两者都泄露的情况），可以离线猜密码。
- 每猜一次要跑 60 万次 PBKDF2，但显卡可以大量并行，所以弱密码可能被猜中。
- 默认生成的 160 位同步密钥猜不出来；自定义密码靠第 6.1 节的长度和强度要求兜底。

### 6.6 在浏览器里保存

- 不保存密码原文。
- `authKey` 保存原始字节，因为要发给服务器。
- DEK 解开时设为**不可导出**的 `CryptoKey`，存进 IndexedDB。页面脚本可以用它加解密，但读不出它的原始字节。
- 可以选“不在这台设备保存”，每次云同步时再输入密码。
- 清除浏览器数据之后，需要重新输入密码。

### 6.7 改密码

- 先用旧 `authKey` 认证，再上传新的 `authKey` 和新的 `wrapped_dek`。DO 在一个事务里原子替换，并把 `auth_epoch` 加 1，旧票据立即失效。
- 不用重新上传数据。
- 其他设备下一次请求会收到 401，提示“密码已在别处修改，请重新输入”。
- 如果怀疑旧密码泄露，另外执行“更换数据密钥”：生成新 DEK → 解密全部数据并重新加密 → 上传快照 → 删除旧批次。

### 6.8 忘记密码

- 无法恢复，这是设计如此。
- 可以**重置云端**：
  1. 用该 UID 有效的鹰角 token 证明所有权（流程同第 7.2 节）；
  2. 删除云端数据；
  3. 用新密码从本地重新上传。
- 鹰角 token 在密码模式里**只能用来删除，不能用来读取**。
- 后果：偷到你鹰角 token 的人最多删掉云端副本，读不到内容，本地数据也不受影响。

### 6.9 开通需要鹰角 token

- 第一次开通（创建 locator）时，必须用该 UID 的有效鹰角 token 证明所有权。
- 原因：locator 可以由 UID 算出来。如果谁都能开通，知道你 UID 的人可以抢先用他自己的密码占住你的 locator（抢注）。
- 开通之后，日常读写只需要密码。
- 网站本来就要用鹰角 token 拉记录，开通时浏览器手里一般已经有 OAuth token。

## 7. 鹰角账号模式（不推荐）

### 7.1 保护范围（放在开启界面和文档最显眼的位置）

| 情况 | 结果 |
|---|---|
| 只知道 UID / hgId | ✓ 拿不到任何东西 |
| 只拿到存储（数据被导出），没有 Worker secret | ✓ 解不开 |
| 本站运营者（持有 Cloudflare 账号和 Worker secret） | ✗ 技术上可以解密，只能依靠公开代码和运营者不作恶 |
| Cloudflare | ✗ 技术上可以解密 |
| 任何人拿到你**有效**的鹰角 token（失效之前） | ✗ 能读取你的云端记录 |

原因见前提 2：不存在一种密钥，既能由鹰角账号派生，又是服务器算不出来的。

开启时要求用户逐条勾选确认上面三条 ✗。界面上默认推荐密码模式，鹰角账号模式放在“其他方式”里。

### 7.2 证明所有权：Worker 自己向鹰角核实

1. 浏览器：账号 token → grant 得到 OAuth token。这一步现在就有，经 `/api` 转发。
2. 浏览器向云同步接口发送 `{ game, uid, oauthToken }`。不发送账号 token 本身，但 OAuth token 同样是有效的鹰角凭证（见第 3.2 节）。
3. Worker 用 `oauthToken` 调 `binding_list?appCode={game}`（服务器到服务器，地址写死）。
4. 必须同时满足：HTTP 200、`code` 为 0、列表里对应项的 `appCode` 等于 `game`、绑定列表里有这个 uid（字符串完全相等）。任何一条不满足，或者请求失败、超时，都返回 403。
5. Worker 根据核实过的 uid 自己计算 locator。
6. `oauthToken` 用完即丢：不保存，不记录。

`oauthToken` 由账号 token 现场换取，只用于绑定接口，失效后就不能再用来证明所有权。它的有效期需要实测（第 14 节）。

### 7.3 密钥

```
KEK_hg = HMAC-SHA256(SYNC_HG_SECRET, "arkrecord/cloud-sync/v1/hg" ‖ 0x00 ‖ locator)
```

- 验证通过后，Worker 把 `KEK_hg` 返回给浏览器，浏览器用它解开 `wrapped_dek`。
- 加解密仍然在浏览器里进行，服务器平时只存密文。但服务器随时能算出 `KEK_hg`，所以它能解密。
- 为什么一定要掺入 `SYNC_HG_SECRET`：如果只用 uid 派生，任何知道 uid 的人都能算出密钥，保护就只剩下“不给你密文”这一道门。掺入之后，至少“只拿到存储”的情况是安全的。
- 密文头里带 `kid`，以后可以轮换 `SYNC_HG_SECRET`。

### 7.4 审计要求

- 核实鹰角 token 的代码按第 3.3 节放在 `worker/hg-verify.ts`，由 `SECURITY.md` 指向它。
- `worker/hg-verify.ts` 和 `SECURITY.md` 的开头写明鹰角账号模式的保护范围（7.1 的表格）。
- 说明局限：审计能证明仓库里的代码做了什么，但不能从密码学上保证线上运行的就是这份代码，因为持有 Cloudflare 账号的人可以绕过 Actions 部署。这是“不推荐”的第二个原因。

### 7.5 从鹰角账号模式升级到密码模式

1. 设置密码；
2. **生成新 DEK**（旧 DEK 服务器能算出来）；
3. 重新加密并上传快照；
4. 删除旧批次和旧的包裹。

反方向（从密码模式降级）也可以做，但要明确警告。

## 8. 数据格式

### 8.1 明文

沿用导出格式 v2 的结构，只包含一个账号：

```jsonc
{
  "format": "arkrecord-cloud", "v": 1,
  "game": "arknights", "uid": "…", "batchId": "…", "createdAt": 0,
  "account": { "nickName": "…", "channelName": "…", "isOfficial": true },
  "akPulls": [/* … */], "akLedger": [/* … */]       // 终末地为 efPulls、efPools
}
```

- 不包含任何 token、快照、kv 设置。
- 解密后检查明文里的 `game`、`uid`、`batchId`，和请求的不一致就丢弃。

### 8.2 加密

```
明文 → gzip（CompressionStream）→ 4 字节长度前缀 + 填充到 4 KiB 的整数倍
     → AES-256-GCM(DEK, 随机 96 位 IV, AAD = "arkrecord/cloud-sync/v1" ‖ locator ‖ kind ‖ batchId)
密文头：{ v, kid, iv }
```

- AAD 绑定了 locator 和 batchId：服务器不能把别的账号的密文、或者同一账号的另一批密文冒充成这一批。改动任何一位，解密都会失败。
- 填充到 4 KiB，让服务器只能看到大致大小。
- 服务器能做的坏事只有删除、扣留、回滚批次，结果是云端缺记录。它污染不了本地数据，因为本地只做并集。
  - 鹰角账号模式例外：服务器有密钥，理论上可以伪造批次。

### 8.3 存储（每个 locator 一个 Durable Object，SQLite）

```
meta(mode, verifier, wrapped_dek, kid, auth_epoch, created_at, last_access_at, fail_count, locked_until)
batches(seq INTEGER PRIMARY KEY AUTOINCREMENT, batch_id, kind 'delta'|'snapshot', size, created_at, blob)
```

限额：

- 单个批次的密文 ≤ 1 MiB（DO SQLite 单行上限是 2 MB）；第一次上传按 1 MiB 拆成多批。
- 每个账号总量 ≤ 16 MiB。
- 批次数超过 32 时，必须先合并才能继续上传。

## 9. 同步算法（客户端）

本地为每个开通了云同步的账号保存：

- `locator`、`mode`；
- `lastSeq`：已经下载到的最大批次号；
- `remoteKeys`：云端已有的记录键（只存键，不存内容）。

一次云同步的步骤：

1. **认证。**
   - 密码模式：发送 `authKey`；鹰角账号模式：发送 `oauthToken`。
   - 返回一张 10 分钟有效的票据，以及 `wrapped_dek`（鹰角账号模式还有 `KEK_hg`），浏览器解出 DEK。
2. **下载。**
   - 拉取 `seq > lastSeq` 的批次，逐批解密、校验。
   - 用现有的幂等合并写入本地，然后把这些记录的键加入 `remoteKeys`。
3. **上传。**
   - 待上传 = 本地键 − `remoteKeys`。
   - 按 ≤ 1 MiB 分成 delta 批次上传，成功后加入 `remoteKeys`。
4. **合并。**
   - 批次数超过 16 时，把本地全部记录打成一个 snapshot。此时本地已经包含云端的全部内容。
   - 上传时注明“覆盖到 seq N”。DO 在一个事务里写入 snapshot，并删除 seq ≤ N 的旧批次。
   - 期间其他设备上传的 seq > N 的批次不受影响。

各种情况：

- **两台设备同时云同步**：各自上传自己的 delta，互不冲突，下一次云同步时互相拉到。不需要锁。
- **新设备**：`lastSeq = 0`，先下载全部，再上传本地多出来的部分。
- **删除**：并集只增不减。本地删除账号不会删除云端；“删除云端数据”是单独的、需要认证的操作。
- **旧版导入的记录**：和接口记录对应的去重（±3 秒覆盖匹配）由现有导入逻辑处理，云同步不引入新的合并规则。

## 10. 接口草案

全部是 POST + JSON，沿用现有 `/api` 的同源检查、限速和 body 上限。

| 接口 | 请求 | 用途 |
|---|---|---|
| `/api/cloud/v1/register` | 鹰角证明 + 模式 +（密码模式：`authKey`）+ `wrapped_dek` | 开通 |
| `/api/cloud/v1/auth` | `{locator, authKey}` 或 `{game, uid, oauthToken}` | 换取票据、`wrapped_dek`、`KEK_hg`、`headSeq` |
| `/api/cloud/v1/pull` | `{ticket, afterSeq}` | 分页下载批次 |
| `/api/cloud/v1/push` | `{ticket, batchId, blob}` | 上传 delta，返回 `seq` |
| `/api/cloud/v1/compact` | `{ticket, upToSeq, batchId, blob}` | 合并 |
| `/api/cloud/v1/rekey` | `{ticket, newAuthKey?, newWrappedDek}` | 改密码、换模式、换 DEK |
| `/api/cloud/v1/delete` | `{ticket}` 或鹰角证明 | 删除云端；忘记密码时用鹰角证明 |
| `/api/cloud/v1/info` | — | 协议版本、部署的 commit hash |

票据：

```
ticket = locator ‖ exp ‖ auth_epoch ‖ HMAC(SYNC_TICKET_SECRET, …)
```

- 只绑定 locator、过期时间和 `auth_epoch`。
- 改密码后 `auth_epoch` 加 1，旧票据立即作废。
- 鹰角账号模式下，一次云同步只需要向鹰角核实一次。

## 11. 威胁模型汇总

| 攻击者 | 密码模式 | 鹰角账号模式 |
|---|---|---|
| 只知道 UID | 拿不到任何东西 | 拿不到任何东西 |
| 知道 UID，在线猜密码 | 每次猜测要本地 60 万次 PBKDF2，服务端还会退避 | — |
| 偷到有效的鹰角 token | 只能删除云端副本，读不到 | **能读取** |
| 偷到这台设备上保存的 `authKey` | 只能下载密文，解不开 | — |
| 只拿到存储（数据被导出） | 无用（还缺 `SYNC_PEPPER`） | 无用（还缺 `SYNC_HG_SECRET`） |
| 运营者 / Cloudflare（存储和 secret 都有） | 看不到明文；可以离线猜弱密码 | **能解密** |
| 网络中间人 | TLS | TLS |
| 服务器篡改、调换密文 | AES-GCM + AAD 能检测；只能删除、回滚 | 能伪造 |

**网页应用的共同局限：**两种模式都依赖网站下发的前端代码是诚实的。如果网站被篡改、下发了恶意脚本，脚本可以在你输入密码时把它偷走。这是所有网页端加密的通病。缓解办法：

- 前端开源，只从公开的 CI 构建；
- 严格的 CSP；
- 以后的电脑应用（路线图）可以用签名的安装包提供更强的保证。

## 12. 服务器能看到的元数据

- locator（可以反推出 UID），也就是“哪些 UID 开通了云同步”。
- 模式、批次的数量和大小（4 KiB 粒度）、上传下载的时间。
- 请求 IP：Worker 不保存，但 Cloudflare 网络层能看到。
- 开通，以及鹰角账号模式的每次认证：Worker 会看到 UID 和一次性的 OAuth token，不保存。

## 13. 数据保留

- 超过 1 年没有任何访问的云端账号自动删除（DO alarm），网页上提前说明。
- 用户可以随时删除。

## 14. 实现前需要实测

- grant 得到的 OAuth token 多久失效，Worker 直接调用 `binding_list` 是否正常。现有转发就是这样调用的，预计没有问题。
- 终末地 `binding_list?appCode=endfield` 返回的 uid，是否和本地账号 id 里的一致。
- 60 万次 PBKDF2 在中低端手机上的耗时。次数写死在协议版本里，只会往上调，不往下调。
- 记录最多的账号，gzip 之后有多大。

## 15. 待确认的决定

1. **KDF**：PBKDF2-HMAC-SHA256 60 万次，输出 256 位，再用 HKDF 分出两把钥匙（第 6.1 节）。
2. **密码规则**：默认生成 160 位的同步密钥；自定义密码至少 16 位，并估算强度。
3. **密码模式日常读写要不要也带鹰角 token（双重验证）**：默认不要，因为授权已经由 Worker 核对 `authKey`。如果要，代价是没有保存登录的用户每次云同步都要重新粘贴 token。
4. **开通必须验证鹰角 token**（防抢注）。推荐。
5. **忘记密码时可以用鹰角 token 删除云端**（不能读取）。推荐。
6. **鹰角账号模式要不要做**。建议做在第二阶段，默认隐藏在“其他方式”里，开启时逐条勾选确认风险。
7. 不活跃 1 年自动删除；每个账号 16 MiB 上限。

## 16. 部署需要新增的配置（实现时再加）

- Worker secrets：`SYNC_PEPPER`、`SYNC_TICKET_SECRET`、`SYNC_HG_SECRET`。
  - 预览和生产各一套，各自是 32 字节随机数。
  - 直接在 Cloudflare 后台设置为 Secret 类型，不经过 GitHub。`wrangler deploy` 不会覆盖已有的 secret。
- Durable Object：绑定 `CLOUD` → 类 `CloudVault`，迁移 `v3`（`new_sqlite_classes`）。
- Rate Limiting：`RL_CLOUD_AUTH`（每 IP 每分钟 10 次）、`RL_CLOUD_DATA`（每 IP 每分钟 60 次）。
- 仓库根目录的 `SECURITY.md`，以及 CI 里的 token 字段检查（第 3.3 节）。

## 17. 分阶段

1. **第一阶段：密码模式。**开通（鹰角证明）、认证、上传下载、合并、改密码、删除和重置。
2. **第二阶段：鹰角账号模式。**单独文件，单独审计说明，以及从鹰角账号模式升级到密码模式。
3. 以后：设备凭证（不受退避限制）、定期自动云同步。
