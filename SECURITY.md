# 安全说明

ArkRecord 的所有统计计算都在你的浏览器里完成。服务器（Cloudflare Worker）只做三件事：

- 转发鹰角接口的请求；
- 保存你主动提交的反馈；
- 保存你开启云同步后、在浏览器里加密好的密文。

这份文档列出服务器接触敏感信息的**全部**位置，方便任何人审计。

## 报告安全问题

请不要在公开的 Issue 里贴出漏洞细节。可以：

- 使用 GitHub 仓库的 Security → Report a vulnerability 私密报告；
- 或者通过网站的“反馈”页面提交，只写“有安全问题，请联系我”，并留下联系方式。

## Worker 接触鹰角 token 的全部位置

| 位置 | 什么时候 | 做什么 |
|---|---|---|
| [`worker/proxy.ts`](worker/proxy.ts)、[`worker/upstreams.ts`](worker/upstreams.ts) | 从鹰角同步记录时 | 浏览器不能直接请求鹰角接口（没有 CORS），所以经 Worker 转发。浏览器把参数（包括 token）放在请求体里，Worker 按白名单拼成上游请求，转给鹰角接口，**不记录、不存储** |
| [`worker/hg-verify.ts`](worker/hg-verify.ts) | 云同步：检测云端状态、开通 / 覆盖、忘记密码时删除、开关双重验证、开启双重验证的账号的每个请求、无密码模式的每个请求 | 用 OAuth token 查询鹰角的角色绑定列表，确认这个 UID 属于你；**核实完立即丢弃**，不写入存储、不写日志、不出现在返回值里 |

### token 只存在于 Worker 处理请求时的内存里

- **只放在请求体里。**浏览器发给 Worker 的请求，token 一律放在请求体里，不出现在网址和请求头里：Cloudflare 的统计、安全事件可能记录网址，实时日志（`wrangler tail`）会显示网址和请求头，但都不包含请求体。转发接口拒绝网址里带参数的请求（[`worker/proxy.ts`](worker/proxy.ts) 的 `ProxyEnvelope`）。
- **不留日志。**Worker 的日志功能（observability）是关闭的，见 [`wrangler.jsonc`](wrangler.jsonc)；Worker 代码里没有任何 `console` 输出（CI 检查）。
- **异常不带细节。**未预料的异常在入口（[`worker/index.ts`](worker/index.ts)）统一变成不带任何细节的 500，异常信息（可能含有带 token 的上游地址）不会交给平台；转发失败时也只返回 `upstream_unreachable`。
- **不写入存储。**云同步的存储（Durable Object）只收到按白名单重新组装的字段；测试（[`worker/hg-verify.test.ts`](worker/hg-verify.test.ts)）经过完整的 Worker，检查存储收到的请求、存储里的内容和返回给浏览器的响应里都没有 token。
- **只有一个文件读取 token。**云同步中读取鹰角 token 的代码只在 `worker/hg-verify.ts`。CI 检查（[`worker/token-fields.test.ts`](worker/token-fields.test.ts)）保证 `worker/`、`shared/` 目录里除了这个文件，任何地方都不出现 token 字段名。
- 唯一离开内存的地方是发给鹰角的请求本身：鹰角的接口要求 token 放在网址的查询参数里，这是 Worker 向鹰角发出的请求，不经过任何日志。

## 浏览器什么时候把鹰角 token 发给云同步

**不是你点击按钮、并在确认窗口里点了“确认发送”，鹰角 token 绝不发给云同步接口。**

- 确认窗口写明这次要做的事、发送什么、发给谁、做什么用、服务器怎么处理，并链接到核实代码。
- 需要确认的操作：检测云端状态、开通 / 覆盖、一键启用、切换模式、开关双重验证、没有钥匙时删除，以及开启了双重验证、或者用无密码模式的账号的每一次云同步。
- 从鹰角同步记录之后的“顺便云同步”只处理不需要 token 的账号；开启了双重验证、或者用无密码模式的账号只会提示你点击。
- 代码上的保证：云同步要用的 OAuth token 只能通过 [`src/lib/cloud/consent.ts`](src/lib/cloud/consent.ts) 换取，必须带着确认窗口创建的、几分钟内有效的“同意”；CI 检查（`src/lib/cloud/consent.test.ts`）保证云同步的其他代码不能直接换取 token，并且只有两个确认按钮能创建“同意”。

## 云同步

完整设计见 [`docs/rewrite/cloud-sync.md`](docs/rewrite/cloud-sync.md)。

两种模式，开通时选择，之后随时可以切换（切换就是用新钥匙覆盖云端）：

- **密码模式（推荐）**：数据在浏览器里用你的密码派生的钥匙加密后才上传，服务器解不开。
- **无密码模式（不推荐）**：不用记密码，每次云同步都用鹰角 token 证明账号是你的。**本站运营者和拿到你有效鹰角 token 的人技术上能读取你的云端记录**，见下面的“无密码模式”。

### 密码模式

- **密码怎么变成钥匙**：Argon2id（32 MiB、3 遍），盐由游戏和 UID 算出，再用 HKDF 分成两把钥匙：
  - `authKey`：每次请求都发给服务器，用来证明所有权；
  - `kek`：只留在浏览器里，解开数据要用它。
- **服务器保存的东西**：
  - `HMAC(SYNC_PEPPER, authKey)`；
  - 用 `kek` 包裹、再用服务器密钥加密一层的数据钥匙；
  - 密文批次；
  - 失败次数。
- **服务器不保存的东西**：密码、`authKey`、`kek`、数据钥匙明文、UID（只有它的哈希）、IP、任何鹰角 token。
- **核对通过之前什么都不给**：只知道 UID 的人拿不到任何东西，连密文也拿不到。账号不存在和密码错误返回同样的结果。
- **防猜密码**：同一个账号连续失败 5 次后开始退避，最长每小时一次。退避按账号计算，与攻击者有多少 IP 无关。
- **可选的鹰角 token 双重验证**：开启后，没有有效鹰角 token 的请求连核对密码的机会都没有。
- **检测云端状态**：只有核实过鹰角 token、证明账号是你的，服务器才回答“开通了没有、是否开启了双重验证”，不返回任何数据；只知道 UID 的人查不到。
- **同步配置（可选）**：可以把云同步密码保存为同步配置，之后其他账号一键开通或启用。密码用一把不可导出的钥匙加密后存在你的浏览器里（不记住时只在内存里），只存在这台设备上：不上传、不导出，也不会同步到别的设备；不包含鹰角登录（token）。能在这台设备上打开本站的人可以使用它，所以公用电脑请不要保存。
- **最终防线**：Cloudflare 账号一旦被攻破，存储和服务器密钥会一起泄露。这时只剩 Argon2id、盐和你的密码强度在起作用，所以请使用足够长、不和别的网站共用的密码，或者直接用“生成”的密码。
- **忘记密码无法找回**：只能用数据最全的浏览器，凭鹰角 token 覆盖云端。本地数据始终不受影响。

### 无密码模式

鹰角账号里没有“只有你知道”的东西（token 会变，UID 不是秘密），所以由它派生的钥匙服务器一定也能算出来。这是它“不推荐”的根本原因。

- **钥匙**：`KEK_hg = HMAC-SHA256(SYNC_HG_SECRET, "arkrecord/cloud-sync/v1/hg" ‖ 0x00 ‖ locator)`，`SYNC_HG_SECRET` 是只写的 Worker secret。服务器不保存 `KEK_hg`，只在核实过鹰角 token 的请求里算出来交给浏览器（[`worker/cloud-vault.ts`](worker/cloud-vault.ts) 的 `HgKeys`）；加解密仍然在浏览器里进行，浏览器也不保存钥匙。
- **鹰角 token 的处理和密码模式一样**：只在服务器核实请求时存在于内存里，核实完立即丢弃，不写日志、不写入存储（见上面“token 只存在于 Worker 处理请求时的内存里”）。代码公开，接受审计。
- **每个请求都要核实鹰角 token**，没有会话、票据。没有核实通过的请求和密码错误返回同样的结果，不返回任何数据。
- **保护范围**：

| 情况 | 结果 |
|---|---|
| 只知道 UID | ✓ 拿不到任何东西 |
| 只拿到存储（数据被导出），没有 Worker secret | ✓ 解不开 |
| 本站运营者（持有 Cloudflare 账号和 Worker secret） | ✗ 技术上可以解密，只能依靠公开代码和运营者不作恶 |
| Cloudflare | ✗ 技术上可以解密 |
| 拿到你**有效**鹰角 token 的人（失效之前） | ✗ 能读取你的云端记录 |

- 开通、切换到无密码模式之前，网站会列出上表，并要求你勾选确认；旁边的审计链接指向线上部署的那个 commit 的 `worker/hg-verify.ts`。
- 从无密码模式切回密码模式时会换一把新的数据钥匙，旧的（服务器算得出来的）作废。

## 对照线上代码

审计源码只能说明仓库里的代码做了什么。为了让任何人都能确认**线上运行的就是这份代码**，每次部署都会留下公开、可以独立验证的记录，并且有定时任务持续核对。

### 每次部署留下什么

部署只通过本仓库公开的 GitHub Actions（[`deploy-production.yml`](.github/workflows/deploy-production.yml)、[`deploy-preview.yml`](.github/workflows/deploy-preview.yml)），运行日志公开。构建之后、部署之前：

1. **构建清单** [`/build-manifest.json`](https://ark.kaltsit.dev/build-manifest.json)（[`scripts/audit/manifest.mjs`](scripts/audit/manifest.mjs)）：网站上每个文件的 SHA-256，以及 Cloudflare 为这个 Worker 版本保存的每个模块（Worker 代码 `index.js` 和响应头配置 `_headers`）的 SHA-256。随网站一起公开。
2. **构建证明**：清单和每个 Worker 模块由部署流程用 [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance) 签发，记录在 Sigstore 的公开透明日志里。证明写明是本仓库哪个流程、哪个 commit、哪次运行构建的；透明日志只能追加，事后删不掉、也改不了时间，连仓库管理员也不行。
3. Cloudflare 上的 Worker 版本标记为对应的 commit。

签发构建证明的任务单独运行：不检出代码、不安装任何依赖，只拿到构建清单和模块的哈希。安装依赖、构建、部署的任务都没有签发权限，所以即使某个 npm 依赖被投毒，也没法给别的代码伪造“本仓库构建”的证明。

构建是可复现的：同一个 commit 在另一台机器上构建，得到的 Worker 代码和网站文件逐字节相同（部署时从外部拉取的游戏数据和头像除外，它们由清单和构建证明覆盖）。

### 任何人都可以核对网站

网站文件（包括在浏览器里加密数据的代码）是公开的，任何人都能下载下来对比。需要 Node 20+；验证构建证明还需要 [GitHub CLI](https://cli.github.com/)（`gh auth login`）：

```sh
git clone https://github.com/DuskXi/ArkRecord-Web && cd ArkRecord-Web
node scripts/audit/verify-site.mjs            # 正式环境：验证清单的构建证明，核对代码文件和安全响应头
node scripts/audit/verify-site.mjs --all      # 核对全部文件（含图片、字体、文字识别模型）
```

也可以自己从源码构建，和线上的清单对比：

```sh
git checkout <线上的 commit> && npm ci
GITHUB_SHA=<线上的 commit> CLOUDFLARE_ENV=production npx vite build
node scripts/audit/manifest.mjs --compare https://ark.kaltsit.dev/build-manifest.json
```

只验证构建证明：`gh attestation verify build-manifest.json --repo DuskXi/ArkRecord-Web --signer-workflow DuskXi/ArkRecord-Web/.github/workflows/deploy-production.yml`。

### Worker 代码：公开的定时核对

Worker 代码只有 Cloudflare 账号持有者能取回，所以由仓库里公开的 [`audit-deployment.yml`](.github/workflows/audit-deployment.yml) 代为核对：每天一次，每次部署之后也立即运行一次，正式环境和测试环境都核对。

- [`verify-site.mjs`](scripts/audit/verify-site.mjs)：同上，验证网站上的文件、清单和构建证明。刚部署完的几十秒里，Cloudflare 的部分节点还在提供上一个版本的文件，所以第一次不一致的文件会隔 30 秒复查，最多 3 次；复查后一致的数量写在报告里，仍不一致的才算问题。
- [`verify-worker.mjs`](scripts/audit/verify-worker.mjs)：用 Cloudflare 接口取回**最近 72 小时内上传的每一个 Worker 版本**的代码（不论是谁上传、有没有部署），每个模块都必须有本仓库部署流程签发的构建证明，而且来自同一次构建（同一份构建证明里列出了这个版本的全部模块，拼凑不同构建的模块会被发现）。很少改动的模块（`_headers`）每次部署都会被签发一次，同样的内容可能有上百份证明，所以每个文件最多取 1000 份；某个模块自己没取到证明、但列在同一版本另一个模块的有效证明里时也算有证明（证明的签名覆盖它列出的全部文件）；正在运行的版本还必须和网站上的构建清单完全一致。按时间而不是按个数取版本，连续上传再多版本也挤不出核对范围；在网页后台修改密钥会产生新版本，但代码不变，所以同样能通过。
- 结果写在每次运行的摘要里（Actions 页面公开）；完整报告作为附件保留 90 天，并且同样签发构建证明，记录在透明日志里。核对失败时运行会标成失败。

核对流程不安装任何依赖（脚本只用 Node 自带模块）。Cloudflare 令牌只交给 `verify-worker.mjs`：它只发 GET 请求、只访问固定的几个 Worker 接口，不把令牌传给子进程；报告里只有版本号、时间、来源、哈希和构建来源，不包含账号 ID、邮箱、IP 和绑定的值。

### 仍然存在的局限

Cloudflare Workers 没有远程证明（可信执行环境）这类机制，所以这些措施让“绕过 Actions 部署别的代码”**会被发现、留下删不掉的记录**，但不能从密码学上阻止：

- 定时核对每天一次：临时换上别的网页文件、在下一次核对之前换回来，网站文件那部分可能发现不了；Worker 部分不会漏掉，因为每个上传过的版本都会在之后 72 小时内被核对至少两次，没有构建证明的版本一定会被发现。
- 只对个别用户返回不同的网页（例如按 IP），别人核对时看到的是正常文件。想确认自己拿到的文件，可以自己运行 `verify-site.mjs`。
- 定时核对用的 Cloudflare 令牌由运营者配置，理论上可以换成另一个账号的令牌。
- 运营者可以停用定时核对；停用后透明日志里就不再有新的核对记录，这本身是可见的。

## 网页端加密的共同局限

所有在网页里做的加密，都依赖网站下发的前端代码是诚实的。如果网站被篡改、下发了恶意脚本，脚本可以在你输入密码时把它偷走。

缓解办法：

- 前端开源，只从公开的 CI 构建；
- 严格的内容安全策略（CSP，见 [`public/_headers`](public/_headers)）；
- 以后的电脑应用可以用签名的安装包提供更强的保证（见 README 的路线图）。
