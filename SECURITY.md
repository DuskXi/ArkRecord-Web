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
| [`worker/proxy.ts`](worker/proxy.ts)、[`worker/upstreams.ts`](worker/upstreams.ts) | 从鹰角同步记录时 | 浏览器不能直接请求鹰角接口（没有 CORS），所以经 Worker 转发。账号 token 等原样转给白名单内的鹰角接口，**不解析、不记录、不存储** |
| [`worker/hg-verify.ts`](worker/hg-verify.ts) | 云同步：开通 / 覆盖、忘记密码时删除、开关双重验证、开启双重验证的账号的每个请求 | 用 OAuth token 查询鹰角的角色绑定列表，确认这个 UID 属于你；**核实完立即丢弃**，不写入存储、不写日志、不出现在返回值里 |

保证这一点的机制：

- **只有一个文件读取 token。**云同步中读取鹰角 token 的代码只在 `worker/hg-verify.ts`。CI 检查（[`worker/token-fields.test.ts`](worker/token-fields.test.ts)）保证 `worker/`、`shared/` 目录里除了这个文件，任何地方都不出现 token 字段名。
- **不留日志。**Worker 的日志功能（observability）是关闭的，见 [`wrangler.jsonc`](wrangler.jsonc)。

## 云同步

完整设计见 [`docs/rewrite/cloud-sync.md`](docs/rewrite/cloud-sync.md)。

**密码模式（目前唯一的模式）**：数据在浏览器里用你的密码派生的钥匙加密后才上传，服务器解不开。

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
- **最终防线**：Cloudflare 账号一旦被攻破，存储和服务器密钥会一起泄露。这时只剩 Argon2id、盐和你的密码强度在起作用，所以请使用足够长、不和别的网站共用的密码，或者直接用“生成”的密码。
- **忘记密码无法找回**：只能用数据最全的浏览器，凭鹰角 token 覆盖云端。本地数据始终不受影响。

## 对照线上代码

- 正式环境只通过本仓库公开的 GitHub Actions 部署，运行日志公开。
- `https://ark.kaltsit.dev/api/cloud/v1/info` 返回线上部署的 commit，可以和仓库对照。
- 局限：审计能证明仓库里的代码做了什么，但不能从密码学上保证线上运行的就是这份代码，因为持有 Cloudflare 账号的人可以绕过 Actions 部署。

## 网页端加密的共同局限

所有在网页里做的加密，都依赖网站下发的前端代码是诚实的。如果网站被篡改、下发了恶意脚本，脚本可以在你输入密码时把它偷走。

缓解办法：

- 前端开源，只从公开的 CI 构建；
- 严格的内容安全策略（CSP，见 [`public/_headers`](public/_headers)）；
- 以后的电脑应用可以用签名的安装包提供更强的保证（见 README 的路线图）。
