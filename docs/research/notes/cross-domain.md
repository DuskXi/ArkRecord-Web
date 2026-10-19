# ark / mhy / game 多站点数据互通调研笔记（2026-10-18）

> 范围：纯调研，不涉及实现、不改任何仓库。
> 标注约定：**【实验】** = 本机 Chromium 141 实测；**【源码】** = 读浏览器开源代码（WebKit / Firefox / Chromium 的 main 分支，2026-10-18 抓取）得出；**【文档】** = 官方文档 / MDN / 规范；**【推测】** = 推理，未验证。
> 实验代码与原始结果：调研时在临时环境里运行（本机 HTTPS 服务 + Playwright 驱动 Chromium 141），没有放进仓库；结果已写在下文各节。
> 抓取限制：本环境的 WebFetch 解析不了任何域名，curl 只能访问 developers.cloudflare.com 和 GitHub raw。MDN 用的是 GitHub 上的 mdn/content 源文件；webkit.org、privacysandbox.google.com 只能通过搜索摘要引用，所以关键结论另外用浏览器源码核对过。

---

## 0. 结论速览

1. **同站（*.kaltsit.dev）iframe 中转在 Safari 上不可用。** WebKit 按**顶层 origin**（不是 site）给存储分区，所以 `ark.kaltsit.dev` 里嵌入的 `game.kaltsit.dev` 拿到的是另一份 IndexedDB；它的 localStorage 只存在内存里，关掉页面就没了。iOS 上的所有浏览器都用 WebKit（欧盟用其他引擎的除外），同样受影响。【源码】【文档】
   Chrome / Edge 在同站时共享同一份存储【实验】，Firefox 同样共享【源码】。
2. **跨站（独立域名）时，所有浏览器都会给 iframe 分区。** 只有 Chrome 能用 `requestStorageAccess({indexedDB:true})` 拿回第一方 IndexedDB【实验】。Firefox 和 Safari 的 Storage Access API 只解锁 cookie【文档】。
3. **window.open 弹窗 + postMessage** 在同站和跨站下都能用，不受分区影响【实验：Chromium】。条件是用户点击，并且两边都不能设 `COOP: same-origin`【实验】。这条路完全不用改 ark 的安全响应头。
4. **端到端加密云同步**是唯一能做到下面这些的通道：跨设备、跨浏览器、穿透 Safari 分区、iOS PWA 的独立存储和 ITP 清理。它适合承担“同步”这个语义；本地通道（弹窗 / iframe）适合“快速导入”。
5. **部署隔离的最大坑在账号级免费额度。** Workers Free 的每日 10 万次 Worker 请求、DO 的每日额度都是按**整个账号**算的【文档】。mhy / game 把额度用完后，ark 走 Worker 的页面路由（`/`、`/history` 等）会返回 429，相当于 ark 首页挂掉【文档】。
6. 建议：**子域名**（mhy.kaltsit.dev、game.kaltsit.dev）、**三个独立 Worker**、**升级 Workers Paid 或者把账号拆开**。数据通道的顺序：云同步为主，弹窗为辅，同站 iframe 只作为 Chromium / Firefox 上的自动同步增强，文件导入导出兜底。

---

## 1. 同站不同源（ark / mhy / game 都在 kaltsit.dev 下）

前提：Public Suffix List 里只有 `dev`，没有 `kaltsit.dev`，所以三个子域的 site 都是 `https://kaltsit.dev`，属于同站【文档：PSL】。
注意：如果以后把 kaltsit.dev 提交进 PSL，各子域会立刻变成跨站。这一步不可逆，不要做。

### 1.1 嵌在 ark 里的 game iframe，存储和 game 顶层是不是同一份？

| 浏览器 | 存储键 | ark 里的 game iframe 和 game 顶层是同一份吗 | 依据 |
|---|---|---|---|
| Chrome / Edge（Chromium 115+） | StorageKey = (origin, top-level site, ancestor chain bit) | **是**。iframe 写入，game 顶层能读到；反过来也一样；mhy 嵌入时也是同一份 | 【实验 A1–A4】【文档】【源码 storage_key.cc】 |
| Chrome：A→B→A 嵌套（中间有跨站祖先） | ancestor bit = CrossSite | **否**，会被分区 | 【实验 C1】；全部同站嵌套时共享【实验 C2】 |
| Firefox（Total Cookie Protection / dFPI，103 起默认） | OriginAttributes.partitionKey = (scheme, 顶层 eTLD+1[, 外来祖先位]) | **是**。只有“第三方”上下文才分区，而“第三方”按 base domain（eTLD+1）判断，同站子域不算第三方，用的是未分区的第一方存储。有跨站祖先（ABA）时会带 foreignByAncestor 位，被分区 | 【源码】`StorageAccess.cpp` 的 `ShouldAllowAccessFor` 中 “Grant if it's not a 3rd party”；`ThirdPartyUtil::IsThirdPartyInternal` 比较 base domain；`OriginAttributes.cpp` 的 foreignByAncestorContext。【文档】MDN State Partitioning |
| Safari / 所有 WebKit（含 iOS 各浏览器、WKWebView） | ClientOrigin = (**顶层 origin**, 帧 origin) | **否**。iframe 的 IndexedDB 目录是 `hash(https://ark.kaltsit.dev)/hash(https://game.kaltsit.dev)`，和 game 顶层的 `hash(game)/hash(game)` 不是同一个；嵌在 mhy 里又是第三份。iframe 的 localStorage 用的是 `MemoryStorageArea`，只在内存里 | 【源码】见下方说明；【文档】WebKit “Updates to Storage Policy”：*“A cross-origin frame uses a different storage partition than the frame it is embedded in … quota is currently 10% of the main frame's origin quota”* |

**WebKit 源码要点**（github.com/WebKit/WebKit main）：

- `ScriptExecutionContext.h`：`storageTopOrigin() { return hasUnpartitionedStorageAccess() ? *securityOrigin() : topOrigin(); }`
  - `topOrigin()` 是顶层文档的 **origin**；
  - `hasUnpartitionedStorageAccess` 只在 Web 扩展放宽 cookie 的场景下为真（`WebPageProxy::unpartitionedStorageSiteForNavigation`）。
- `ScriptExecutionContext::canAccessResource`：在 `StorageBlockingPolicy::BlockThirdParty` 下，`!storageTopOrigin()->isSameOriginAs(*origin)` 就判为第三方。比较的是**同源**，不是同站。
- `UnifiedWebPreferences.yaml`：`StorageBlockingPolicy` 在 WebKit2 里默认就是 `BlockThirdParty`。
- `IDBFactory.cpp`：`IDBDatabaseIdentifier(name, origin, storageTopOrigin)`。
- `NetworkStorageManager.cpp`：`originDirectoryPath` = rootPath / hash(topOrigin) / hash(clientOrigin)。
- `StorageNamespaceProvider.cpp`：第三方 localStorage 走 `transientLocalStorageNamespace`；`LocalStorageManager.cpp` 里对应 `MemoryStorageArea`，只在内存里。
- `BroadcastChannel.cpp` 和 `SharedWorker.cpp` 同样按 (storageTopOrigin, origin) 分区。

**Edge**：使用 Chromium 的分区。微软给过企业策略 `ThirdPartyStoragePartitioningBlockedForOrigins` 用来对指定 origin 关闭分区，140 起弃用，146 起移除，官方建议改用 requestStorageAccess【文档：learn.microsoft.com 策略页（搜索摘要）】。

**踩坑记录**：Playwright 默认带 `--disable-features=ThirdPartyStoragePartitioning`（microsoft/playwright#32230）。第一次实验因此误以为跨站也共享存储（B1）。以后用 Playwright 写端到端测试时，要用 `ignoreDefaultArgs` 把这个开关去掉，否则结论是错的。

### 1.2 Safari ITP 的“7 天清空脚本可写存储”

- **官方说法**：在 Safari 使用了 7 天、期间没有在这个站点上发生过用户交互，就删除该站点全部脚本可写存储（IndexedDB、LocalStorage、SessionStorage、Service Worker 注册和缓存、JS 写的 cookie）。主屏幕 Web App “有自己的天数计数器”【文档：webkit.org/blog/10218（搜索摘录）；MDN 存储配额页的 Proactive eviction 一节】。
- **WebKit 源码细节**【源码】：
  - **交互记在顶层页面的 registrable domain（eTLD+1）上**。`WebResourceLoadObserver::logUserInteractionWithReducedTimeResolution` 取的是 `page->mainFrameURL()` 的 `RegistrableDomain`。所以在 iframe 里点击，算作对**顶层站点**的交互，不算对 iframe 站点的交互。
  - **删除也按 registrable domain 进行**（`registrableDomainsToDeleteOrRestrictWebsiteDataFor`）。
  - **豁免名单**：`m_standaloneApplicationDomain`（主屏幕 / Dock Web App 自己的域）、app-bound / managed domains、`m_persistedDomains`（由浏览器 App 通过 `setPersistedSiteURLs` 提供）、近期有 Web Push 交互的域。
  - **时间窗**：`shouldRemoveAllButCookiesFor` 在默认 `AllButCookies` 模式下使用 Long 窗口（30 个“使用日”）。只有被已归类的追踪域通过 link decoration 导流来的域，才使用 Short 窗口（7 个使用日）。也就是说，开源 WebKit 现在的默认值可能比“7 天”宽松。正式版 Safari 是否相同没有查证，**设计上按 7 天这个最坏情况考虑**。
- **对“主要被 iframe 嵌入、用户很少直接访问”的源的影响**：
  - **子域名方案**：ark、mhy、game 同属 kaltsit.dev，用户在其中任意一个站点上的顶层交互都会刷新整个 kaltsit.dev 的计时，game 的第一方数据不会被单独清掉【源码推论】。不过 Safari 下 iframe 本来就拿不到 game 的第一方数据（1.1），所以这一点主要保护的是用户直接打开 game 时的数据。
  - **独立域名方案**：用户只在 ark 里通过 iframe 用 game 时，game 那个域得不到任何第一方交互，它的第一方存储会在 N 个使用日后被清空。iframe 里的分区存储同样按顶层域计算，跟着 ark 的交互走。
  - **iframe 里的 localStorage**：Safari 下本来就只在内存里，和 ITP 无关。
- **安装成 PWA 的情况**：
  - iOS / iPadOS：主屏幕 Web App 的存储和 Safari 分开（iOS 6 起，来源是旧资料）；有自己的计数器；它自己的域被豁免（源码里的 `m_standaloneApplicationDomain`）。WebKit 工程师在 bug 211775 里说明：主屏幕 App 主域的 HTML storage 不应被删除。所以 game 装成 PWA 后，Safari 标签页里的 ark 无论用 iframe 还是弹窗，都碰不到 PWA 里的数据。**只有云同步能把两边接起来。**
  - macOS 的 Dock Web App：Apple 的说明是 Web App 不和 Safari 共享 cookie、website data、历史记录；创建时会拷一次 cookie【文档：support.apple.com/104996（搜索摘要）】。
  - Chrome / Edge 安装的 PWA 和浏览器 profile 共享同源存储，和普通标签页没有区别【常识，未逐一验证】。
  - **App 内浏览器**（微信、QQ 等）都有各自的存储容器，和系统浏览器不互通，只能靠云同步【推测】。
- `navigator.storage.persist()`：ArkRecord 已经在调用。WebKit 里 persistent 模式能避免存储压力下的淘汰【文档：Updates to Storage Policy】。至于它会不会被放进 ITP 的 `persistedDomains` 豁免名单，没有文档说明，**不要依赖**。

### 1.3 postMessage 中转（hub iframe）的标准做法

**握手**

1. ark 只在用户打开“与 game 同步”界面时，才创建 `<iframe src="https://game.kaltsit.dev/bridge" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" hidden>`。
   - 不要用 `loading=lazy`。
   - sandbox 去掉了弹窗、顶层导航和表单，作为纵深防御；hub 要读写自己 origin 的存储，必须保留 `allow-same-origin`。
2. hub 加载后先执行 `parent.postMessage({v:1,type:'ready'}, ALLOWED_PARENT)`。
   - hub 读不到 parent 的 origin，可以先用 `document.referrer` 粗略判断，或者对允许名单里的每个 origin 各发一次，只有匹配的那个能收到。
3. ark 收到消息后校验 `e.origin === 'https://game.kaltsit.dev' && e.source === iframe.contentWindow`。
4. ark 新建 `MessageChannel`，执行 `iframe.contentWindow.postMessage({v:1,type:'connect',want:['arknights','endfield']}, 'https://game.kaltsit.dev', [port2])`。**targetOrigin 必须写死，不能用 `'*'`**【文档：MDN postMessage “Always provide a specific targetOrigin”】。
5. hub 校验：
   - `e.origin` 在允许名单里，并且 `e.source === parent`；
   - **按 origin 限定权限**：`{ 'https://ark.kaltsit.dev': ['arknights','endfield'], 'https://mhy.kaltsit.dev': ['hk4e','hkrpg','nap'] }`。
6. 之后只在这个 port 上通信。port 不能被第三方伪造，只有持有者能发。

**消息格式**

```
{ v: 1, id: <uuid>, type: 'pull'|'push'|'result'|'error'|'progress',
  game, accountId, since?: <cursor>, chunk?: {index,total}, payload? }
```

- 每条消息都要做 **schema 校验**：长度、类型、枚举、记录数上限。MDN 的原话是“验证 origin 之后仍要验证消息语法”。
- 带协议版本 `v`，遇到不认识的大版本直接拒绝。三个站点是独立部署的，版本错位是常态。

**传什么**

- 复用现有导出格式（`buildExport` / `importExportFile` 本来就不含 token）。米哈游系用 UIGF v4.2。
- **永远不要传**：鹰角 / 米哈游 token、云同步的 `authKey` / DEK、本机设置。

**大数据量（几 MB）**

【实验 I】60,000 条寻访记录，约 10.6 MB JSON：

| 方式 | 同站（同进程） | 跨站（OOPIF，跨进程） |
|---|---|---|
| 对象数组 structured clone | 序列化约 105 ms + 反序列化约 51 ms | 约 55 ms + 68 ms |
| JSON 字符串 | 约 45 ms | 约 11 ms + 7 ms |
| Uint8Array 拷贝 | 约 40 ms + 7 ms | 约 10 ms + 7 ms |
| Uint8Array **transfer** | 约 0 ms（零拷贝，发送后原 buffer 被 detach） | 发送 7 ms，送达约 54 ms（跨进程仍需复制） |

结论：
- 几 MB 不成问题。
- 建议编码成字节（复用云同步的列式编码，可以再加 `CompressionStream`），按 1–4 MB 分块，用 transfer 列表传 `ArrayBuffer`，避免主线程一次克隆几万个对象。
- 接收方在 Web Worker 里解码和校验。

**并发**：在 Chrome / Firefox 同站情况下，hub iframe 和用户打开的 game 标签页是同一个 IndexedDB。
- 用 Web Locks（同一存储键内共享）串行化合并；
- 用 BroadcastChannel 通知 game 标签页刷新【实验 D1：ark 里的 game iframe 发的消息，game 顶层标签页收到了；嵌在 other-site.example 里的 game iframe 发的没收到】；
- Dexie 要处理 `versionchange` / `blocked`（hub 来自新部署、game 标签页还是旧版本时会出现）。

**权限确认**

- 隐藏 iframe 里没有可见 UI，所以“同意”只能在 ark 页面上点。hub 无法分辨那次同意是不是 ark 被 XSS 后伪造的，因此 hub 侧必须做到：
  - 按 origin 限定可访问的游戏；
  - 不提供删除操作；
  - 限制大小和频率；
  - 入站记录按不可信输入校验（防止数据投毒）。
- 需要用户在 game 侧明确同意的操作（比如把 mhy 的数据给 ark 看），改用弹窗（1.6），在 game 自己的顶层页面里确认。

### 1.4 CSP / X-Frame-Options 怎么改

**ark（嵌入方）**

- 只在使用 iframe 方案时，CSP 加一项 `frame-src https://game.kaltsit.dev`。现有 CSP 没有 frame-src，会回退到 `default-src 'self'`，不加就会拦掉这个 iframe。
- `frame-ancestors 'none'`、`X-Frame-Options: DENY`、`connect-src 'self'` **全部保持不变**。postMessage 不受 connect-src 管。
- ark 自己的 `frame-ancestors 'none'` 还带来一个好处：ark 永远是顶层页面，hub 的祖先链里不会混进跨站帧（避免实验 C1 那种情况）。
- 弹窗方案和 service binding 云方案：**ark 的响应头一个都不用改**。

**game（被嵌方）**

- 主应用保持 `frame-ancestors 'none'` 加 XFO DENY。只有 `/bridge` 这一条路径单独放开：

  ```
  Content-Security-Policy: default-src 'none'; script-src 'self'; frame-ancestors https://ark.kaltsit.dev https://mhy.kaltsit.dev; base-uri 'none'; form-action 'none'
  ```

- 【实验 E1–E6】：
  - 允许名单内的 ark 可以嵌入；
  - other-site.example 嵌入被拦；
  - ark → other-site → hub 也被拦，frame-ancestors 会检查**全部祖先**；
  - XFO DENY 和 frame-ancestors 允许名单同时存在时，Chromium **以 CSP 为准，可以嵌入**。CSP3 规范要求出现 frame-ancestors 时忽略 XFO，所以 bridge 路径保留 XFO DENY 对旧浏览器反而是“失败即拒绝”。但为了清晰，建议直接去掉。
  - 只有 XFO DENY、或者 `frame-ancestors 'none'` 时，即使同站也会被拦。
- **XFO 的 `ALLOW-FROM` 已废弃**，现代浏览器会忽略整条头；`frame-ancestors` 写在 `<meta>` 里无效，必须用 HTTP 头【文档：MDN】。
- **Cloudflare `_headers` 的坑**【文档】：
  - 同一个头被多条规则匹配时，值会用逗号拼接。CSP 拼接后等于两条策略同时生效，`/*` 里的 `frame-ancestors 'none'` 照样会拦。所以 bridge 路径必须先写 `! Content-Security-Policy`、`! X-Frame-Options` 摘掉，再设新值（同一块里先摘再设是否生效，要实测）。
  - 由 Worker 代码生成的响应不会应用 `_headers`（`env.ASSETS.fetch()` 返回的响应会应用，ArkRecord 现在就依赖这一点）。
  - 最稳的做法：bridge 走 Worker，在代码里显式设置响应头；再让现有的 `scripts/audit/verify-site.mjs` 检查线上实际的响应头。

**hub 防点击劫持**

- hub 页面不放任何可点击的 UI，没有东西可劫持；
- `frame-ancestors` 只允许自家两个 origin；
- 需要用户确认的操作一律放到顶层弹窗里做；
- 不在 hub 里调用 `requestStorageAccess`（同站不需要），也不在 hub 里调用 `window.open`。

### 1.5 其他机制

| 机制 | 能否跨源 | 说明 |
|---|---|---|
| BroadcastChannel | **不能**，只限同源 | 【文档：MDN】【实验 D2：ark 顶层页面监听同名频道，收不到 game 发的消息】。还会按存储键分区【实验 D1】。用途：在 game 这个 origin 内部，让 hub 通知 game 标签页 |
| SharedWorker | 不能，只限同源；Chrome / Firefox 按存储键分区，WebKit 按 (顶层 origin, origin) 分区 | 【文档：Chrome Storage Partitioning】【源码：WebKit SharedWorker.cpp】。同样只能在同一 origin 内部用 |
| `Domain=kaltsit.dev` 的 cookie | 能（同站各子域都能读写） | 【实验 G1】。每个 cookie 只有约 4 KB，而且每个请求都会带到所有子域的 Worker（包括 ark 的转发 Worker）。只适合放“已经关联 game”这类不敏感的标志位，最好不用。ArkRecord 的接口靠自定义头加 `Sec-Fetch-Site: same-origin` 做来源校验，不依赖 cookie，所以子域互相写 cookie（cookie tossing）影响很小 |
| Storage Access API（同站） | 不需要 | Chrome / Firefox 同站本来就是第一方【实验 F5 / S4】。Safari 里 rSA 只解锁 cookie，解决不了 IndexedDB 分区【源码 / BCD】。MDN：调用方和顶层同站时，“probably doesn't need to be called” |
| `document.domain` | 已废弃，没用 | Chrome 115 起默认使用 origin-keyed agent cluster，赋值不生效【实验 H1：赋值后仍是 game.kaltsit.dev，`originAgentCluster=true`】。而且它从来不会改变 localStorage、IndexedDB、BroadcastChannel、SharedWorker 使用的 origin【文档：MDN】 |

### 1.6 弹窗中转（同站和跨站通用）

流程：
1. 用户在 ark 点击按钮，执行 `window.open('https://game.kaltsit.dev/connect', 'kaltsit-connect', 'popup,width=480,height=640')`；
2. game 的 connect 页面是**顶层**页面，拿到的是第一方存储；
3. game 用 `opener.postMessage(hello, 'https://ark.kaltsit.dev')` 打招呼，只有 opener 确实是 ark 时才能送达；
4. 双方校验 `origin` 和 `source === opener`，之后改用 MessageChannel；
5. game 页面里显示“ark.kaltsit.dev 请求导入 / 同步……【允许】【拒绝】”，用户在 game 自己的顶层页面上确认。

实验结果：
- 【实验 P1 / P3】跨注册域名（ark.kaltsit.dev → game.kaltsit-games.net）下，弹窗读到了第一方 IndexedDB 并成功发回；第三方 cookie 允许或屏蔽都一样。
- 【实验 P2 / P4】opener 或弹窗任意一方设了 `Cross-Origin-Opener-Policy: same-origin`，引用就被切断，收不到消息。ark 如果将来要加 COOP，只能用 `same-origin-allow-popups`；game 的 connect 页面不能加 COOP。
- 无手势调用 `window.open` 在 headless 下没被拦。这不代表真实浏览器的行为，**未验证**。真实浏览器需要用户手势。

额外好处：
- 弹窗里的点击属于 game 的第一方交互，会刷新 Safari ITP 的计时；
- 不会被当成 bounce tracking（见 2.3）；
- game 的 connect 页面保持 `frame-ancestors 'none'`，没有点击劫持面。

Safari 下这条路在原理上可行（弹窗是顶层，用第一方存储），但**未实测**。iOS PWA（standalone）里调用 `window.open` 跨域时会在哪个存储容器里打开，**未验证**【推测：很可能是 App 内的 Safari 视图，存储和 PWA 不同】。

---

## 2. 完全不同的可注册域名（跨站）

### 2.1 iframe 能不能读到同一份存储？

| 浏览器 | 默认 | 用 Storage Access API 之后 |
|---|---|---|
| Chrome（125+） | 分区【实验 B1 / B3：ls 和 idb 都是 null】 | `document.requestStorageAccess({indexedDB:true, localStorage:true})` 返回 `StorageAccessHandle`，**`handle.indexedDB` 就是第一方 IndexedDB**【实验 F1 / S2】。<br>• **第三方 cookie 允许时**（2025 年后 Chrome 普通窗口的默认状态）：立即 resolve，不弹提示，**不需要用户手势也成功**【实验 S1】；<br>• **第三方 cookie 被屏蔽时**（无痕模式默认、或用户自己关闭）：Promise 一直挂起等待权限提示（headless 下没有 UI）【实验 S1 / S2，block3pc】。真实浏览器会弹窗，要求用户手势，并且用户近期在该站点有过顶层交互【文档：MDN SAA 安全要求】；<br>• 用 CDP `Browser.setPermission` 模拟授权在 headless 下没有生效，**授权后的行为未能实测**；<br>• 注意：跨站 iframe 里 `hasStorageAccess()` 返回 true，但 IndexedDB 仍然是分区的【实验 B1 / S0】。它只反映 cookie 能不能访问，不能拿来判断存储 |
| Edge | 分区（同 Chromium） | BCD 记为不支持 `StorageAccessHandle`。微软在移除分区豁免策略时建议改用 rSA，结论有冲突，**需要实测** |
| Firefox | 分区（dFPI） | rSA **只解锁 cookie**。MDN State Partitioning 里 “Dynamically-partitioned APIs” 只列了 Cookies；BCD 记为不支持 `types` 参数。IndexedDB 仍然分区 |
| Safari | 分区（按顶层 origin） | rSA 只解锁 cookie，而且按页面授权、必定弹窗，要求过去 30 天内有过第一方交互；BCD 记为不支持 `types` 参数 |

**Storage Access API 的现状**【文档】：
- Chrome 119 起支持 rSA，125 起支持非 cookie 的 `types` 参数；
- 141 起改为严格同源语义（BCD `strict_same_origin_policy`），Firefox 140 起同样如此；
- 需要安全上下文，iframe 有 sandbox 时要加 `allow-storage-access-by-user-activation`，还可能被 `Permissions-Policy: storage-access` 禁用。

**CHIPS / Related Website Sets**：
- 2025-10-17 Google 宣布退役大部分 Privacy Sandbox 技术，其中 **Related Website Sets（包括 `requestStorageAccessFor` 和 Related Website Partition）在列**；CHIPS、FedCM、Private State Tokens 继续支持【文档：privacysandbox.google.com 博客（搜索摘要）】。MDN 已把 `requestStorageAccessFor` 标为 deprecated。
- 有二手资料说 Chrome 144 开始弃用、150 移除，**未核实**。
- CHIPS 本身就是“按顶层站点分区的 cookie”，解决不了跨站共享。
- 2025-04 Google 决定保留第三方 cookie 的现有选择方式，不再推出单独的提示；无痕模式默认屏蔽第三方 cookie【文档】。

**结论**：跨站 iframe 方案只在 Chrome 上靠 rSA 勉强可用，而且依赖用户的第三方 cookie 设置；Firefox 和 Safari 都不行。**不能作为主方案。**

### 2.2 替代方案

1. **window.open 弹窗 + postMessage**：已在 Chromium 跨站实测可用（1.6）。需要点击；不能设 COOP same-origin；适合“一次性导出 / 导入”或手动同步。
2. **端到端加密云同步做中转**：和浏览器的分区策略完全无关（详见第 3 节）。
3. **文件导出 / 导入**：现有功能。鹰角系用 ArkRecord 导出格式，米哈游系用 UIGF v4.2（hk4e / hkrpg / nap / hk4e_ugc）。

### 2.3 跨站时额外要注意的点

- **Bounce tracking**：如果用“ark → game → ark”这种无交互的跳转来交接数据，在屏蔽第三方 cookie 的 Chrome（116 起）和严格模式的 Firefox 里，game 可能被认定为 bounce tracker。45 天内没有交互就会被清空存储【文档：MDN Bounce tracking mitigations】。同站跳转不算 bounce。**一律用弹窗加用户点击。**
- **Safari ITP**：独立域名的 game 需要用户直接访问并交互才能保住数据（1.2）。

---

## 3. 数据层设计

**现状**（ArkRecord 仓库）：
- 每条记录都有幂等键：寻访是 `key`，源石 / 充值是 `kind+key`。
- 合并时在一个全序上取最大值，满足幂等、交换、结合律，唯一的删除是“旧版记录被接口记录覆盖”。
- 账号 id 是 `${game}:${uid}`。导出格式不含 token。
- 云同步按 (game, uid) 分账号，locator 和盐由 game+uid 推导，**里面不含站点 origin**。

**多站合并**：
- 这套规则本身就是 join-semilattice（类似 G-Set 加确定性的取大），**合并顺序和拓扑无关**。ark ⇄ game ⇄ mhy 任意次、任意方向合并，最终都会收敛。
- 前提是三个站点**用同一份合并实现和全序定义**：抽成共享包，在三个 app 里跑同一套属性测试（现有的 `merge.test.ts` 和 `idempotency.test.ts`）。

**作用域**：
- ark ⇄ game 只同步 arknights / endfield；mhy ⇄ game 只同步 hk4e / hkrpg / nap；
- token、云同步钥匙、同步配置、本机设置一律不同步。

**删除**：
- 并集只会增加，在某个站点删除账号不会传播到其他站点，这和现有的云同步语义一致，要在界面上写明。
- 如果将来要做跨站删除，需要引入 tombstone，复杂度会明显上升，**不建议做**。

**单向导入 vs 双向同步**：
- **第一阶段：单向**。game 从 ark / mhy 拉取，ark / mhy 只导出。ark 的数据库永远不接收外来写入，最符合“不影响 ark”。
- **第二阶段：双向**。game 把 arknights / endfield 记录推回 ark。语义上是安全的（并集），风险在于版本错位和数据投毒。ark 必须把入站数据当作不可信导入文件处理：走 `importExportFile` 的校验，再经用户确认。
- 版本错位的处理：交换格式带版本号；遇到更高的大版本直接拒绝，不能丢字段后照样合并；字段来源（`source`）的优先级在共享包里统一定义。

**云同步作为跨站桥梁，是否比 iframe 更稳？**

| | 本地 iframe / 弹窗 | 端到端加密云同步 |
|---|---|---|
| Safari / iOS / PWA / App 内浏览器 | iframe 不可用，弹窗可用但只限同一个存储容器 | 都可以 |
| 跨设备 | 不能 | 能 |
| 是否依赖浏览器分区和 ITP 政策 | 强依赖，而且这些政策还在变 | 不依赖 |
| 门槛 | 零配置（弹窗需要点击） | 每个游戏账号设密码。ArkRecord 已有“同步配置”，可以一键启用多个账号 |
| 服务器 | 不需要 | 消耗 DO 请求和写入行数等额度；每个账号上限 4 MiB；服务器能看到元数据（locator、大小、时间），见 cloud-sync.md §14 |
| 隐私 | 数据不出浏览器 | 只上传密文 |

结论：**云同步更稳，应该承担“同步”**。本地通道只负责“同一浏览器里的快速导入”。ITP 清空本地数据后，也能从云端恢复。

**game 怎么接入 ark 现有的云同步（不破坏 ark）**：
- **推荐**：在 ark 的 Worker 里新增一个**只能通过 service binding 调用的 RPC 入口**（WorkerEntrypoint），复用现有的校验、限速和 CloudVault 逻辑。game 的 Worker 通过 `services` binding 调用它，game 前端照常请求同源的 `/api/cloud/v1/*`（game 的 `connect-src 'self'` 不用改）。ark 仍然是唯一能碰 ark 的 DO 和 `SYNC_PEPPER` 的代码。
  - 需要处理的细节：
    - 限速用的客户端 IP 由 game 作为参数传入；
    - RPC 入口外网访问不到；
    - ark 原有的 `checkSameOrigin` 不适用于 RPC 路径，要单独写一套校验。
- **不推荐**：
  - game 的 Worker 直接用 `script_name` 绑定 ark 的 DO 类：game 的代码可以绕过 ark 的校验直接写 ark 用户的密文，而且 pepper 也要交给 game；
  - 给 ark 的 `/api/cloud` 开 CORS：会扩大 ark 对公网的攻击面，还要改 `checkSameOrigin`（现在要求 `Sec-Fetch-Site: same-origin`，同站的 game 发来的请求是 `same-site`，会被拒）。
- 米哈游系的云账号放在 mhy 自己的 Worker 和 DO 里，game 同样用 service binding 访问。
  - 这样每个游戏的数据只归一个“所有者站点”，game 只是客户端，挂了也不会影响上游。
  - 协议的 `GAMES` 和 UID 规则要扩展；无密码模式依赖鹰角 token 验证，米哈游系需要另外设计，或者只提供密码模式。

---

## 4. 部署与隔离（Cloudflare）

**推荐：三个独立的 Worker**（各自的 `name`、`wrangler.jsonc`、Custom Domain、静态资源、DO 类和 migrations、secrets、ratelimit `namespace_id`），不要一个 Worker 挂多个路由。
- 一个 Worker 意味着共享代码包、部署单元和 CPU / 内存限制。mhy 的一次部署或依赖被投毒，会直接改动 ark 线上运行的代码。
- **限速命名空间**：`namespace_id` 在整个账号内唯一，**不同 Worker 用同一个 id 会共享计数器**【文档】。ark 现在是 21xxx / 211xx，mhy / game 要另起号段，例如 22xxx / 23xxx。
- **DO**：每个 Worker 定义自己的类。跨 Worker 访问 DO 要显式写 `script_name`，默认就是隔离的【文档】。
- **跨 Worker 调用**：
  - 同一个 zone 里，Worker 可以 `fetch()` 另一个挂在 Custom Domain 上的 Worker；挂在 Routes 上的不行，只能用 service binding【文档】；
  - 更推荐 service binding 加 RPC，不经过公网。
- **CI / 凭据**：
  - Cloudflare 现在支持把 API token **限定到单个 Worker**（Editor scoped to that Worker）【文档：workers/authorization】。三个站点用三个 token、三个 GitHub Environment（可以要求审批）。
  - 每个站点各自生成构建清单，各自用 `actions/attest-build-provenance` 签发证明，审计页面也各自独立。ark 现有的 `attest` job 可以原样复制给另外两个站点。
- **账号级共享额度（最关键）**【文档】：
  - Workers Free 每天 **10 万次 Worker 请求按账号计算**，超出后 1027 / 429；
  - 用了 `run_worker_first` 的路径超额后会**直接返回 429，不会退回静态资源**，而 ark 的 `/`、`/history` 等页面路由都在 `run_worker_first` 里；
  - DO 的免费额度也按账号计：每天 10 万次请求、13,000 GB-s、写入 10 万行，存储共 5 GB；
  - 静态资源请求免费，不计数。
  - 应对办法：
    - ① 升级 Workers Paid，没有每日硬上限，风险从“停服”变成“多花钱”；
    - ② mhy / game 放到另一个 Cloudflare 账号。独立域名很容易做到；子域名的问题在于 Custom Domain 要求 zone 和 Worker 在同一个账号，Subdomain zone 又只有 Enterprise 能用，只能走 Cloudflare for SaaS 的 custom hostname（Free 计划含 100 个），配置复杂，**需要实测**；
    - ③ mhy / game 的页面不用 `run_worker_first`，尽量减少 Worker 调用。

**Monorepo 结构**（pnpm workspaces；npm workspaces 也可以，pnpm 更严格，不会有幽灵依赖）：

```
apps/ark   apps/mhy   apps/game        # 每个都有自己的 vite.config 和 wrangler.jsonc
packages/ui                             # Vue 组件、主题
packages/stats                          # 保底 / 概率统计（纯 TS）
packages/merge                          # 记录全序、合并、属性测试
packages/cloud-protocol                 # 现在的 shared/cloud-protocol.ts
packages/bridge-protocol                # postMessage 消息 schema 和校验
packages/game-arknights  packages/game-endfield  packages/game-genshin  packages/game-hsr  packages/game-zzz
packages/worker-common                  # security.ts、限速工具
```

- 每个 app 只**静态 import** 自己需要的 game 包；不要用一个总入口（barrel）导出全部游戏；包里声明 `"sideEffects": false`。最后用构建清单或 visualizer 确认 ark 的产物里没有米哈游的代码。
- Workers Builds 官方支持 monorepo：每个 Worker 设自己的 root directory 和 build watch paths【文档】。用 GitHub Actions 的话就按路径过滤。
- 风险：改了共享包会触发 ark 重新部署。可以考虑：
  - ① 第一阶段 ark 仓库不动，mhy / game 新开 monorepo，把 ark 的代码复制或抽成包；等稳定之后再把 ark 迁进去；
  - ② ark 依赖共享包的固定版本（changesets），而不是 `workspace:*` 跟随最新。
  - 迁移时要保证 ark “同一个 commit 构建结果逐字节相同”的可复现性。

---

## 5. 结论与建议

**子域名 vs 独立域名：推荐子域名（mhy.kaltsit.dev、game.kaltsit.dev）**

- 子域名的好处：
  - 同站，iframe 中转在 Chrome / Edge / Firefox 上可用；
  - Safari ITP 的交互按 kaltsit.dev 整体计算；
  - 不会被当成 bounce tracking；
  - 同一个 zone 下配置 Custom Domain、service binding 都简单；
  - `.dev` 在 HSTS preload 列表里，自动全站 HTTPS。
- 子域名的代价：
  - 和 ark 共用一个 Cloudflare 账号的额度和权限面。用 Workers Paid、限定到单个 Worker 的 token、独立的限速和 DO 解决；
  - 子域之间同站，SameSite cookie 不再隔离。ArkRecord 的接口按 origin（同源）校验，不受影响，以后也要坚持按同源校验。
- 独立域名的唯一明显好处是能彻底拆账号，但换来的是：iframe 在 Firefox 和 Safari 上完全不可用，Chrome 上依赖用户的第三方 cookie 设置。只有当“账号级隔离”比“本地互通”更重要时，才选独立域名。

**跨站数据通道**

| 优先级 | 通道 | 适用 | 风险 | 对安全头的改动 |
|---|---|---|---|---|
| 首选（同步） | 端到端加密云同步。game 通过 service binding 调用 ark / mhy 各自 Worker 的 RPC 入口，读写对应的 CloudVault | 所有浏览器、PWA、跨设备 | 需要设密码；消耗服务器额度；ark 的 Worker 要加一个 RPC 入口（新增代码路径，要审计）；版本错位 | ark / game 的 CSP 都不用改 |
| 首选（本地） | 弹窗 + MessageChannel，game 顶层页面里做用户确认 | 同一浏览器，同站和跨站都可以，包括 Safari（原理上） | 需要点击；COOP 不能设 same-origin；iOS PWA 的行为待测 | 都不用改，game 的 connect 页面保持 `frame-ancestors 'none'` |
| 增强 | 同站隐藏 iframe hub，用来自动同步 | 仅 Chrome / Edge / Firefox（Safari 检测到分区就退回弹窗） | 实现复杂（并发、版本错位）；hub 是所有数据的集中点，game 出现 XSS 影响最大；Safari 会静默失败 | ark：CSP 加 `frame-src https://game.kaltsit.dev`；game：只对 `/bridge` 单独设置 `frame-ancestors`（ark、mhy）并摘掉 XFO，其余路径保持 `'none'` |
| 兜底 | 文件导出 / 导入（ArkRecord 格式、UIGF v4.2） | 所有场景 | 手动操作 | 无 |

**待实测**：
- 真实 Safari / iOS 上的同站 iframe 分区（源码结论）、弹窗流程、PWA 下 `window.open` 的行为；
- Firefox 同站 iframe 是否共享存储（源码结论）；
- Edge 的 `StorageAccessHandle`；
- Chrome 屏蔽第三方 cookie 时真实提示的流程；
- Cloudflare `_headers` 在同一块里先摘后设的效果；
- Cloudflare for SaaS 跨账号挂子域名的可行性。

---

## 6. 实验记录（Chromium 141.0.7390.37，Playwright 1.56.1，headless）

**环境**：
- 本地 HTTPS 服务（自签证书，SAN 包含测试用的主机名）；
- 用 `--host-resolver-rules` 把 `*.kaltsit.dev`、`other-site.example`、`*.kaltsit-games.net` 解析到 127.0.0.1:8443，没有任何流量出本机；
- 带 `--no-proxy-server`；
- 去掉了 Playwright 默认的 `ThirdPartyStoragePartitioning` 禁用开关。

| 编号 | 场景 | 结果 |
|---|---|---|
| A1–A3 | game 顶层写入 → ark 嵌入 game 读取；hub 写入 → game 顶层读取 | 同一份（localStorage 和 IndexedDB 都是） |
| A4 | mhy 嵌入 game | 同一份 |
| B1 | other-site.example 嵌入 game.kaltsit.dev | 分区（null） |
| B3 | ark 嵌入 game.kaltsit-games.net（独立域名） | 分区（null） |
| C1 | ark → other-site → game | 分区（ancestor bit） |
| C2 | ark → mhy → game | 共享 |
| D1 / D2 | BroadcastChannel | game 顶层标签页收到了同站嵌入的 game iframe 发的消息，收不到跨站嵌入的；其他 origin 的同名频道收不到 |
| E1–E6 | 嵌入控制 | allow-list LOADED；other-site BLOCKED；XFO DENY + allow-list LOADED；只有 XFO DENY 时 BLOCKED；`'none'` BLOCKED；中间夹跨站祖先时 BLOCKED |
| F1 / S1 / S2 | 跨站 iframe 调 rSA({localStorage, indexedDB})，第三方 cookie 允许 | 授予，handle 能读到第一方数据，不需要手势 |
| S0–S3（block3pc） | 第三方 cookie 屏蔽 | `hasStorageAccess=false`，rSA 一直挂起（等待提示）；CDP 授权未生效 |
| S4 / F5 | 同站 iframe，第三方 cookie 允许和屏蔽两种情况 | 第一方数据，`hasStorageAccess=true` |
| G1 | `Domain=kaltsit.dev` cookie | mhy 能读到 |
| H1 | `document.domain='kaltsit.dev'` | 无效，`originAgentCluster=true` |
| I | 10.6 MB 载荷 postMessage | 见 1.3 的表 |
| P1–P4 | 跨注册域名弹窗 | 可以读到第一方数据并发回；opener 或弹窗任一方设了 COOP same-origin 就失败 |

---

## 7. 出处

**MDN**（源文件为 github.com/mdn/content）
- State Partitioning：https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/State_Partitioning
- Storage Access API：https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API
- requestStorageAccess：https://developer.mozilla.org/en-US/docs/Web/API/Document/requestStorageAccess
- BroadcastChannel：https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
- document.domain：https://developer.mozilla.org/en-US/docs/Web/API/Document/domain
- postMessage：https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
- frame-ancestors：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors
- X-Frame-Options：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options
- COOP：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy
- 存储配额与淘汰：https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- Bounce tracking：https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Bounce_tracking_mitigations
- BCD（api/StorageAccessHandle.json、api/Document.json）：https://github.com/mdn/browser-compat-data

**规范**
- CSP3 frame-ancestors 与 X-Frame-Options：https://w3c.github.io/webappsec-csp/#frame-ancestors-and-frame-options
- SAA non-cookie storage 提案：https://github.com/privacycg/saa-non-cookie-storage

**Chrome**
- Storage Partitioning：https://privacysandbox.google.com/cookies/storage-partitioning ；https://developer.chrome.com/docs/privacy-sandbox/storage-partitioning （“The feature has shipped in Chrome 115”）
- storage_key.cc：https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/common/storage_key/storage_key.cc
- Intent to Ship（SAA non-cookie）：https://groups.google.com/a/chromium.org/g/blink-dev/c/F5EV8I-j7Eg/m/OAi7lcykAAAJ
- Privacy Sandbox 退役（2025-10-17）：https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies
- 保留第三方 cookie 选择（2025-04）：https://privacysandbox.google.com/blog/privacy-sandbox-next-steps

**Playwright**
- 默认禁用分区：https://github.com/microsoft/playwright/issues/32230

**Edge**
- https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/thirdpartystoragepartitioningblockedfororigins

**WebKit**
- Updates to Storage Policy：https://webkit.org/blog/14403/updates-to-storage-policy/
- Full Third-Party Cookie Blocking and More：https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- Tracking Prevention：https://webkit.org/tracking-prevention/
- bug 211775：https://bugs.webkit.org/show_bug.cgi?id=211775
- 源码（https://github.com/WebKit/WebKit ，main 分支）：
  - Source/WebCore/dom/ScriptExecutionContext.{h,cpp}
  - Source/WebCore/Modules/indexeddb/IDBFactory.cpp
  - Source/WebCore/storage/StorageNamespaceProvider.cpp
  - Source/WebKit/NetworkProcess/storage/{NetworkStorageManager,LocalStorageManager}.cpp
  - Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml
  - Source/WebCore/dom/BroadcastChannel.cpp
  - Source/WebCore/workers/shared/SharedWorker.cpp
  - Source/WebKit/WebProcess/WebCoreSupport/WebResourceLoadObserver.cpp
  - Source/WebKit/NetworkProcess/Classifier/ResourceLoadStatisticsStore.cpp
  - Source/WebKit/UIProcess/WebsiteData/WebsiteDataStore.cpp

**Apple**
- Mac 上的 Web App：https://support.apple.com/en-us/104996
- iOS 6 起主屏幕 App 存储分离（旧资料）：https://blog.appstudio.dev/2012/09/important-io6-and-data-storage/

**Firefox 源码**（https://github.com/mozilla-firefox/firefox）
- toolkit/components/antitracking/{StorageAccess,StoragePrincipalHelper}.cpp
- dom/base/ThirdPartyUtil.cpp
- caps/OriginAttributes.cpp

**Cloudflare**
- `_headers`：https://developers.cloudflare.com/workers/static-assets/headers/
- Custom Domains（Worker 之间的调用）：https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Service bindings：https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- Rate limiting：https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- 平台限制：https://developers.cloudflare.com/workers/platform/limits/
- 静态资源计费：https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- DO 价格：https://developers.cloudflare.com/durable-objects/platform/pricing/
- wrangler 配置（`script_name`）：https://developers.cloudflare.com/workers/wrangler/configuration/
- 授权（限定到单个 Worker 的 token）：https://developers.cloudflare.com/workers/authorization/
- Monorepo：https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/
- Subdomain setup（仅 Enterprise）：https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/
- Cloudflare for SaaS 计划：https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/

**其他**
- UIGF v4.2：https://uigf.org/zh/standards/uigf.html （源文件为 github.com/UIGF-org/UIGF-org.github.io）
- Public Suffix List：https://publicsuffix.org/list/public_suffix_list.dat
- ArkRecord-Web（只读克隆）：`wrangler.jsonc`、`public/_headers`、`worker/security.ts`、`shared/cloud-protocol.ts`、`docs/rewrite/cloud-sync.md`、`src/lib/archive.ts`、`src/lib/db.ts`
