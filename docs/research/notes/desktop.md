# ArkRecord 桌面版调研笔记（2026-10-18）

> 纯调研，不含实现。以 2025–2026 现状为准。
> **[确认]** = 一手/权威来源或本次实测；**[二手]** = 第三方/社区来源；**[推测]** = 据资料推断，需实测。
> 本环境网络受限：developer.chrome.com / electronjs.org / learn.microsoft.com / github.blog 等直连被代理拒绝；相关内容取自搜索摘要，或这些站点在 GitHub 上的文档源码（raw.githubusercontent.com / git clone），均注明。

---

## 0. 背景核对（ArkRecord-Web 仓库）

- 现流程：登录鹰角通行证 → 打开 `web-api.hypergryph.com/account/info/hg` → 复制 `data.content`（账号 token）→ 网站经 Worker 转发 `as.hypergryph.com/user/oauth2/v2/grant` → `binding-api-account-prod.hypergryph.com` → `ak.hypergryph.com`（需 Cookie `ak-user-center`）/ `u8.hypergryph.com` / `ef-webview.hypergryph.com`。来源：仓库 `docs/rewrite/research.md`、`worker/upstreams.ts`。
- Worker 存在的唯一原因：上游不返回 CORS 头；浏览器 JS 不能设置 `Cookie`、读不到 `Set-Cookie`。**桌面版主进程（Node/Chromium 网络栈）无这两个限制**，`worker/upstreams.ts` 的白名单逻辑可几乎原样移植到主进程。
- 仓库 research.md 1.7 已记录**森空岛扫码登录**可直接换到鹰角账号 token（RIIC-Web、nonebot-plugin-skland）：`POST as.hypergryph.com/general/v1/gen_scan/login {appCode:"4ca99fa6b56cc2ba"}` → `GET /general/v1/scan_status` → `POST /user/auth/v1/token_by_scan_code`。对“傻瓜式添加账号”很关键。
- 路线图“电脑应用：离线查看本地记录”——仅离线查看 PWA 即可；真正需要壳的是“更傻瓜地取 token + 免 Worker 直连”。
- 云同步 Worker 只认同源请求；桌面版渲染进程 origin 是 `app://…`，云同步需走主进程转发或 Worker 加桌面识别 **[推测]**。

---

## 1. 取 token 的方式

### 1.1 结论先行
“让 Python 调试用户日常浏览器去取 token”这条路，技术上今天基本走不通，且会让一个高度重视安全/信誉的开源项目的行为在杀毒与用户眼里与窃密木马无法区分。**推荐改为：应用内嵌一个独立会话的登录窗口（Electron BrowserWindow + 独立 persistent partition），用户自己在官方登录页登录，应用再用该会话去请求 token。** 下面给依据。

### 1.2 调试“用户日常浏览器”不可行的硬性变化

**Chrome / Chromium 系 [确认]**
- Chrome 官方博客《Changes to remote debugging switches to improve security》（Will Harris, 2025-03-17）：自 Chrome 136 起，`--remote-debugging-port` / `--remote-debugging-pipe` 指向**默认用户数据目录**时不再生效；必须配 `--user-data-dir` 指向非默认目录（非默认目录用不同加密密钥）。动机原文：“Since App-Bound Encryption was enabled we've seen an increase in attackers using Chrome Remote Debugging to extract cookies.” 自动化推荐 Chrome for Testing。URL：developer.chrome.com/blog/remote-debugging-port（搜索摘要，多源一致）。
- 即：你无法附加到用户已登录的默认 profile——而那正是“省得用户再登一次”的全部价值所在。
- Edge：微软 Q&A 报告同样行为（默认 profile 端口不监听，自定义 `--user-data-dir` 可用），但无官方发行说明确认，视为 **[二手]**。learn.microsoft.com/answers/questions/5976829。Brave 等其它 Chromium 系同为上游行为，**[推测]** 跟进。
- Chrome 144+ 另加了一条“正规”路径：用户在 `chrome://inspect/#remote-debugging` 手动开启，每次外部连接 Chrome 弹窗要用户点 Allow（WebSocket-only，无 HTTP 发现接口）。但这要求用户装的是 Chrome 144+、手动开开关、每次授权，极不“傻瓜”，且仍是在操纵用户主浏览器。来源：developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session（搜索摘要），GitHub issue ChromeDevTools/chrome-devtools-mcp#914 等。

**Firefox [确认]**
- Remote Agent（WebDriver BiDi）只能由 `--remote-debugging-port` 命令行标志启动，仅接受 loopback 连接，无认证无加密；CDP 已于 Firefox 129 默认关闭、`remote.active-protocols` 偏好在 Firefox 141 移除，只剩 BiDi。来源：Firefox 源码 `remote/doc/Security.md`（raw.githubusercontent.com/mozilla-firefox/firefox/main/remote/doc/Security.md，本次已读全文），fxdx.dev 关于弃用 CDP 的文章。
- 文档明确“安全模型同 DevTools/Marionette：除命令行标志外无其它启用机制”，并把“能执行任意 shell 命令的攻击者”列为不在防护范围——等于说用这个取 token 就是在复刻攻击者手法。日常 profile 启动会显示“机器人/条纹地址栏”远程控制指示器。

**直接读浏览器 cookie 数据库——强烈不建议 [确认 + 二手]**
- Windows：Chrome 127 起 App-Bound Encryption（ABE），在 DPAPI 之上把密钥绑定到应用身份；普通应用解不开 cookie，必须提权或注入 Chrome 进程。Google 安全博客《Improving the security of Chrome cookies on Windows》（2024-07）。yt-dlp 的 `--cookies-from-browser chrome` 在 Windows 现在直接报“Failed to decrypt with DPAPI”并指向 issue #10927（本次读了 yt-dlp `cookies.py` 源码确认该错误行）。
- macOS：密钥在 Keychain（`Chrome Safe Storage`）；Linux：libsecret/gnome-keyring 或 KWallet（v11），无 keyring 时回退硬编码口令 `peanuts`（v10）。
- **行为与窃密木马（infostealer）高度相似**：EDR/杀软专门检测这类行为。Elastic 预置规则《Potential Cookies Theft via Browser Debugging》正是匹配“Chrome/Edge 进程带 `--remote-debugging-port=*` 且带 `--user-data-dir=*`”；读 Cookies DB + 调用 DPAPI、注入浏览器进程也都是常见检测点。SpecterOps 2025/2026 两篇（Revisiting Cookie Theft / Return of the Cookie Monster）即描述“绕过 Chrome 136 限制从进程内启用 CDP”这类手法并给出 Sysmon 检测。
- **对开源项目信誉的影响**：一个“不记录不存 token、每日公开核对”的项目，一旦其安装包里出现“读其它浏览器密钥库 / 启动带调试端口的浏览器”的代码，会被 VirusTotal/SmartScreen/EDR 误报，社区也会质疑；与项目的安全叙事直接冲突。**不该做。**

### 1.3 推荐方案 A：应用内嵌登录窗口（Electron BrowserWindow + 独立 partition）[确认可行]

- 做法：`new BrowserWindow({ webPreferences: { partition: 'persist:hglogin', contextIsolation: true, sandbox: true, nodeIntegration: false, preload: 无或极小 } })`，加载官方登录页 `https://user.hypergryph.com/`。用户在这个窗口里自己登录。
- 取 token 的几种受支持 API（均 Electron 官方文档，本次读了 `docs/api/session.md`、`docs/api/net.md`、`docs/api/cookies.md`、`docs/api/client-request.md` 源码）：
  - `ses = session.fromPartition('persist:hglogin')`；`ses.cookies.get({url})` 能读到该会话 cookie（含 HttpOnly），用于拿 `ak-user-center`。
  - `ses.fetch(url, {...})` / `net.request({session: ses, useSessionCookies:true})`：用该登录会话、带会话 cookie 直接发上游请求，Chromium 网络栈、无 CORS、可设任意请求头（`Host`/`Cookie` 等少数受限头除外）。这正好替代 Worker。
  - `ses.webRequest.onBeforeSendHeaders/onHeadersReceived`：可只读取特定响应（如登录完成后页面自身发出的 `account/info/hg`），无需向第三方页面注入脚本。
  - 登录完成后 `ses.clearStorageData()` / `ses.clearData({dataTypes:['cookies']})` 清会话。
- 安全边界（Electron 官方 Security checklist，`docs/tutorial/security.md`，本次读了清单 1–20 条）：`contextIsolation:true`（#3）、`sandbox:true`（#4）、不开 `nodeIntegration`（#2）、给登录窗口 `setPermissionRequestHandler` 一律拒绝相机/麦克风/地理位置等（#5）、限制导航与新窗口 `setWindowOpenHandler`（#13/#14）、不向第三方页面注入任何脚本（只用 webRequest 读取）、不 `shell.openExternal` 不受信内容（#15）。额外开 `cookieEncryption` fuse 让本地 cookie 落盘加密（`docs/tutorial/fuses.md`，macOS 需签名）。
- **极验/滑块验证**：鹰角通行证登录（`user.hypergryph.com`）/手机验证码登录确实接极验 Geetest。本次用 GitHub code search 确认：`as.hypergryph.com/general/v1/send_phone_code`（type=2 发短信码）、`as.hypergryph.com/user/auth/v2/token_by_phone_code`，且开源实现 baiqwerdvd/ArknightsUID 的 `login.py` 在 `send_phone_code` 里处理 `status==1` 时返回的 `captcha.gt/challenge`（极验）。
  - 内嵌 Chromium（Wry/Electron 的 Chromium）是**完整的真实 Chromium**，极验前端 JS/滑块在里面能正常跑；相较纯后端 HTTP 流程，这正是内嵌窗口的优势——把验证码交给官方页面自己处理，应用不碰验证码逻辑。**[推测，需实测]** 风险点：极验可能对 UA/webdriver 特征或自动化行为做风控，但只要用户是真人手动操作、不注入脚本，与真实浏览器几乎无差别。
  - 更“傻瓜”且无需处理极验的路径：**森空岛扫码登录**（见 §0），用户用森空岛 App 扫码即可，应用只轮询 scanId。建议作为首选登录方式之一。

### 1.4 推荐方案 B 对比：系统浏览器 + 本地回环（OAuth 桌面应用式）——此路不通

- 标准 OAuth 桌面应用（RFC 8252）用系统浏览器 + loopback 回调（`http://127.0.0.1:<port>`）接收授权码。前提是**服务方开放了 OAuth / 注册了 redirect URI**。
- 鹰角没有面向第三方的公开 OAuth（现有的 `oauth2/v2/grant` 用的是写死的 `appCode`，并非第三方回调模式），用户在系统浏览器登录后，登录态只在系统浏览器的 cookie 里，应用无法回收（回到 §1.2 的读 cookie 难题）。**不可行。**

### 1.5 若坚持 CDP：独立临时 profile 启动用户装的 Chrome/Edge

- 做法：`chrome.exe --user-data-dir=<临时空目录> --remote-debugging-port=<随机>`，让用户在这个全新 profile 里登录，再通过 CDP 读。
- 可行性 **[确认]**：这正是 Chrome 136 文档留的口子（非默认目录），技术上能用。
- 劣势 vs 内嵌窗口：(1) 依赖用户机器装了 Chrome/Edge 且版本合适；(2) 临时 profile 是全新的，用户仍要**完整登录一次**（没省掉登录），体验不比内嵌窗口好；(3) 进程带 `--remote-debugging-port` + `--user-data-dir` 恰好命中 Elastic 等 EDR 规则，和窃密木马同形；(4) 要管理外部进程生命周期、端口、临时目录清理。
- 结论：相比内嵌 BrowserWindow 无任何优势，还更像恶意软件。**不推荐。** 内嵌窗口用的是应用自带 Chromium、独立 partition，不碰系统浏览器也不开调试端口。

---

## 2. Electron + Python 架构

### 2.1 Python 打包方案对比

| 方案 | 跨平台支持 | 交叉编译 | 体积 | 启动 | 杀软误报 | 维护状态 |
|---|---|---|---|---|---|---|
| **PyInstaller** | Win/Linux/mac，x64+arm64 | 否，每平台原生 runner（官方 `doc/usage.rst`“Supporting Multiple Operating Systems”明说必须在每个 OS 上各自打包） | 中 | onefile 稍慢（每次解压到临时目录；官方 `operating-mode.rst`） | **较高**，预编译 bootloader 被多家 AV 误报；官方建议可自行编译 bootloader 降误报（`doc/bootloader-building.rst`） | 活跃，6.22.x（2026-09） |
| **Nuitka** | 同上 | 否（`--target-arch` 只选 ISA，不是交叉编译；README 明说需目标架构的 Python） | 中大（真编译） | onefile 启动本身不慢 | 仍可能被误报，**去误报的实际支持与说明只在 Nuitka 商业版**（README “Windows Virus scanners” 段）；Linux 跨发行版兼容也要商业版容器构建 | 活跃，商业/开源双轨 |
| **python-build-standalone (+uv)** | Win/Linux/mac，x64+arm64；glibc ≥2.17（多数目标），另有 musl/静态 | n/a（是可移植解释器分发，不是打包器） | 取决于你怎么裹 | 快（原生解释器） | 低（就是官方 CPython） | 活跃，已由 **Astral 接手维护**（2024-12-17 起）；原作者 Szorc 退出 |
| **PyOxidizer** | — | — | 小 | 快 | 低 | **事实上停更**：作者 2024-03 博文宣布优先级转移，生态“zombie state”（Astral 博文 + Pants 社区转述）。**不建议新项目用** |
| **Briefcase (BeeWare)** | Win/Linux/mac/iOS/Android | 否（各平台原生；mac 支持 `universal_build` 合并 x64+arm64） | 中 | 中 | 中 | 活跃；Linux 走 Docker + manylinux 基础镜像（默认 manylinux2014，WebKit2 需 manylinux_2_28） |

来源：PyInstaller 官方文档（本次 clone 读 `doc/usage.rst`、`operating-mode.rst`、`bootloader-building.rst`、`feature-notes.rst`）；Nuitka README（raw 读全文）；astral.sh/blog/python-build-standalone；python-build-standalone `docs/running.rst`（glibc 2.17/musl/静态、install_only/stripped）；gregoryszorc.com 2024-03（搜索摘要）；Briefcase docs（clone）。

**关键事实**：**没有一个方案能跨平台交叉编译**——Win/Linux(RHEL系+Ubuntu系)/mac(x64+arm64) 都得各自原生 runner。这点对“要不要 Python”影响很大（见 2.3）。PyInstaller 的 AV 误报是开源项目的真实痛点，叠加“本地发 HTTP、读文件”的行为更容易被误判。

### 2.2 IPC：主进程 spawn Python 子进程

- **stdio JSON-RPC vs 本地 HTTP**：首选 **stdio（换行分隔 JSON 或 LSP 式 Content-Length 帧）**。理由：无端口、无需认证、天然只有父子进程可见、不受 §2.2 的本地攻击面影响。Electron 官方有 `utilityProcess`（`docs/api/utility-process.md`）专门跑子进程并支持 `MessagePort` 通信；若 Python 常驻，用 `child_process.spawn` + stdio 管道即可。
- 若非要本地 HTTP：务必 (1) 绑 `127.0.0.1` 随机端口；(2) 每次启动生成随机 bearer token，主进程启动时经参数/stdin 传给渲染层；(3) **校验 `Host` 头**只允许 `127.0.0.1:<port>`/`localhost:<port>`（防 DNS rebinding——权威做法是服务端 Host 白名单，见 NCC Singularity、MCP SDK hostHeaderValidation）；(4) 校验 `Origin`/自定义头防 CSRF；(5) 注意 **Chrome 142+ Local Network Access**：公网站点访问 loopback 需用户授权（Chromium 142，2025-10-28 起；Chrome 145 拆成 loopback-network/local-network 两权限）——这降低了网页打本地服务的风险，但也说明“网页能打本地端口”是业界明确在收紧的攻击面。综合看 stdio 明显更省心。
- **子进程生命周期**：主进程退出/崩溃时必须回收 Python 子进程。注意 PyInstaller onefile 的清理陷阱（官方 `feature-notes.rst`）：父进程被 `TerminateProcess` 强杀时，临时解压目录 `_MEIxxxx` 来不及清理会残留；Windows 下还有“后台进程被无条件 TerminateProcess”。对策：优雅关闭信号 + 看门狗 + 启动时清理旧临时目录；Windows 可用 Job Object 绑定子进程随父死。

### 2.3 要不要 Python？——建议：**不要，纯 Electron（主进程 Node.js 直接做）**

- Electron 主进程本身就是 Node.js + Chromium 网络栈：
  - **无 CORS 直连上游**：`net.fetch` / `ses.fetch` 就是 Chromium 网络栈，`worker/upstreams.ts` 的转发白名单、同源检查、限速逻辑是现成 TypeScript，可几乎原样搬进主进程。
  - **读写文件、IndexedDB 导入导出**：Node fs + 渲染层现有 Dexie 逻辑即可。
  - 统计/保底计算（`src/lib/stats/`）、同步（`src/lib/sync/`）等已是 TS，复用零成本。
- 引入 Python 的收益：主要是“维护者熟悉 / 某些库生态”。但本项目的核心逻辑已全部是 TS，没有非 Python 不可的部分（抽卡记录是纯 HTTP + JSON + 统计）。截图识别（路线图）现在也是“浏览器里本地识别”，不是 Python。
- 引入 Python 的代价（都踩在这个项目的痛点上）：
  - **双运行时**：体积 +数十 MB（PyInstaller/解释器）。
  - **签名公证更复杂**：macOS 要对 Python 可执行文件及其所有 `.so`/`.dylib` 逐一签名 + hardened runtime + 公证；Windows 要对 Python exe/dll 一并签名。
  - **两套供应链审计**：npm + PyPI 两条依赖链都要进 SBOM/证明，与项目“可公开核对”的叙事相悖（越简单越好核对）。
  - **AV 误报叠加**：PyInstaller bootloader 本就易误报。
  - **跨平台构建更重**：Python 侧也要每平台原生 runner（2.1），CI 矩阵更复杂。
- **Tauri 对比**：体积/内存更优（安装包常 2–10MB vs Electron 80–200MB；内存某严谨测试 109MB vs 128MB，差距没传言大），但用系统 WebView（Win=WebView2、Linux=WebKitGTK、mac=WKWebView），**跨 WebView 兼容性与极验表现需逐平台测**，而本项目恰恰最依赖“内嵌一个行为与真浏览器一致的 Chromium 来过极验登录”。Tauri 也能用 Python sidecar（`externalBin` + target-triple 后缀 + PyInstaller），但那又把 Python 的代价搬回来。Tauri 2 新增 `Webview::cookies_for_url()`（PR #12665, 2025-03 合并）可读含 HttpOnly 的 cookie，但“统一版本/HttpOnly 在各后端的行为”仍需实测。
- **结论**：
  1. **首选：纯 Electron（TS/Node 主进程 + 复用现有 Vue 前端）**，登录用内嵌 BrowserWindow（§1.3）。架构最简单、与现有代码栈一致、签名/审计/体积负担最小，且内嵌 Chromium 对极验最稳。
  2. 若团队强烈倾向体积小且愿意承担逐平台 WebView 测试：Tauri 2（Rust 壳 + 现有前端），**不加 Python**。
  3. **不建议 Electron+Python 双运行时**——除非将来真有非 Python 不可的模块（目前没有）。

---

## 3. 打包与分发（electron-builder / electron-forge）

- 版本现状（本次查 npm dist-tags）：electron `44.9.0` latest（45 beta/alpha）；electron-builder `26.15.3` latest / `27.0.0-alpha.x` next；electron-updater `6.8.x` / `7.0.0-alpha`；@electron-forge/cli `8.0.1`。
- **目标格式**（electron-builder 文档，clone 自 electron-userland/electron-builder `website/docs/`）：
  - Windows：NSIS（默认，支持自动更新）、MSI、portable、AppX/MSIX（v27 加 MSIX beta）。
  - Linux：AppImage、deb（Ubuntu/Debian 系）、rpm（RHEL/Fedora/Rocky 系）、pacman、snap、**Flatpak**。四类 deb/rpm/AppImage/pacman 都可自动更新。
  - macOS：dmg + zip（zip 是 Squirrel.Mac 自动更新所需，默认 dmg+zip）。
- **AppImage / FUSE / 沙箱（Ubuntu 24.04+）**：electron-builder v27 默认用**静态 FUSE3 runtime**（无需宿主 FUSE2），`AppRun` 智能探测，仅当 user namespaces 不可用时才加 `--no-sandbox`（`website/docs/appimage.md`）。Ubuntu 24.04 起限制非特权 user namespaces（AppArmor），Electron/AppImage 可能需 `--no-sandbox` 或随 deb 装 AppArmor profile；electron-builder 有 `linux.appArmorProfile` 选项（`website/docs/linux.md` “AppArmor Profile (Ubuntu 24+)”）。打 deb/rpm 需在构建机装 `rpm`（deb 构建机 `sudo apt-get install rpm`）。是否上 Flatpak：Flathub 分发面广、沙箱好，但 v27 对 flatpak-builder 版本有要求且 CI 内构建需处理 FUSE/userns；**建议第一版先 AppImage + deb + rpm，Flatpak 作为后续**。
- **Linux glibc 兼容 [确认，本次实测]**：下载 Electron 44.9.0 linux-x64 二进制（校验通过），`objdump -T electron` 的最高 GLIBC 符号版本为 **GLIBC_2.25**（主二进制），NEEDED 动态库里需系统提供 libgtk-3、libnss3、libX11、libgbm、libasound2 等。含义：**在尽量老的发行版上构建**（经典做法：旧 Ubuntu/Debian 或 manylinux_2_28 容器，glibc 2.28 即覆盖 RHEL 8），产物才能跑在更老系统上（glibc 向后兼容只向新，不向旧）。RHEL 8 = glibc 2.28，满足 2.25，但要确保 GTK3/NSS 等运行库存在。electron-builder 官方 Docker 镜像（`electronuserland/builder:24`）即为统一构建环境。
- **macOS x64 vs arm64：universal vs 分架构**：electron-builder 支持 `arch: universal`（`@electron/universal` 合并，`mac.universal.mergeASARs` 等），也支持分别出 x64/arm64。官方建议**两个架构各自原生构建再合并**最可靠（`website/docs/mac.md`）。universal 包体积≈两倍；若在意下载体积可分架构发两个 dmg。
- **Wayland（Electron 38+）[确认]**：Electron 38.0.0 移除 `ELECTRON_OZONE_PLATFORM_HINT`，`--ozone-platform` 默认 `auto`，Wayland 会话下默认以原生 Wayland 运行（38.2+ 开箱即用）；可 `--ozone-platform=x11` 回退 Xwayland。注意 Wayland 下部分 API 行为与 X11 不同（窗口定位、屏幕捕获等），需测。来源：electronjs.org/blog/electron-38-0（搜索摘要）。
- **electron-builder v27 重要默认变化**（`website/docs/migration/whats-new-v27.md`）：要求 Node ≥22.12；**签名更新清单 updateManifest 默认必填**（见 §5）；macOS 默认 entitlements 收紧（只给 allow-jit）；`arch:"all"` 现在=x64+arm64（不含 ia32）；Electron 44 已移除 Win ia32 / Linux armv7l（需 electronVersion ≤43）。

---

## 4. 签名、公证与信任

### 4.1 macOS [确认]
- 要无告警，需 **Apple Developer Program（99 USD/年，Apple 官网 whats-included 确认）** → Developer ID Application 证书签名 + **公证（notarization）** + stapling。Electron Forge/Builder 内置 `@electron/osx-sign` + `@electron/notarize`。
- 不签名/不公证的后果：macOS 15 Sequoia 起**不能再用 Control-click 绕过 Gatekeeper**，用户得去“系统设置 → 隐私与安全性 → 仍要打开”，Apple Silicon 上还常见“已损坏，无法打开”（需 `xattr -cr` 去隔离属性）。对普通用户=劝退。来源：Apple/多家报道（搜索摘要），Electron `docs/tutorial/code-signing.md`。
- 无付费证书的替代：`mac.sign.identity:"-"` ad-hoc 签名只能在**构建那台机器**上跑，不适合分发（electron-builder `website/docs/mac.md`）。开源项目实际上**绕不开 99 USD/年**才能给 macOS 用户顺畅体验。

### 4.2 Windows [确认]
- **EV 证书自 2024 起不再即时给 SmartScreen 信誉**（微软 Trusted Root Program 2024 变更），OV 与 EV 现在都要靠下载量/时间积累信誉。来源：微软 `windows-dev-docs` 的 `smartscreen-reputation.md`、`code-signing-options.md`（本次读 raw 源码）、DigiCert KB。
- 选项与价格（微软 `code-signing-options.md`，ms.date 2026-04）：
  - **Microsoft Store（MSIX）**：免费，微软重签，**无 SmartScreen 告警**。个人开发者 2025 起**免注册费**（原 ~19 USD 取消；blogs.windows.com 2025-05、Learn FAQ）。对免信任门槛最省事。
  - **Azure Artifact Signing（原 Trusted Signing）**：约 **9.99 USD/月**（Basic），但**个人开发者仅限美国/加拿大**，组织限 US/CA/EU/UK 等（微软 `azure-docs` quickstart 确认地理限制）。中国个人开发者**用不了**。有第三方称个人入驻 2026-03 暂停，**[二手]** 需核。
  - **OV 证书**（DigiCert/Sectigo/Certum 等）：约 150–300 USD/年（Certum 开源/云版更便宜，~€49 起 **[二手]**）。全球可买。SmartScreen 与 Azure 一样要积累信誉。
  - **EV**：400+ USD/年，**不再值得**仅为绕 SmartScreen 买。
- **开源项目常见做法**：
  - **SignPath Foundation** 为合格开源项目提供**免费 OV 级签名**（托管流水线 + origin verification，要求 OSI 许可、无专有代码、构建全自动从公开仓库出二进制）。signpath.org/terms（搜索摘要）。**对本项目很合适**——本就是全自动 GitHub Actions 构建 + 公开可核对，满足 origin verification 要求。
  - 或走 **Microsoft Store MSIX**（免费、免告警）作为 Windows 主分发渠道，GitHub Releases 作为副本。
  - Windows 11 **Smart App Control** 对未签名/低信誉可执行文件直接拦且无简单绕过（仅 RSA 证书算数，不支持 ECC），进一步说明签名近乎必需。微软 `smart-app-control/code-signing-for-smart-app-control.md`。
- **Linux**：一般不需要代码签名；可给 deb/rpm 加 GPG 签名、给仓库签名；AppImage 可带 GPG 签名（`appimagetool --sign`）。

### 4.3 小结
- 最省钱且契合信誉叙事：**Windows 走 SignPath Foundation（免费 OV）或 Microsoft Store MSIX；macOS 认 99 USD/年 Apple 会员（无替代）；Linux GPG 即可。**

---

## 5. 自动更新与可审计性

- **electron-updater + GitHub Releases**：可自动更新的目标 = macOS dmg/zip、Linux AppImage/deb/rpm/pacman、Windows NSIS（`website/docs/features/auto-update.md`）。macOS 自动更新**必须签名**。
- **electron-builder v27 新增“签名更新清单”**（`website/docs/features/signed-update-manifests.md`）：`latest*.yml` 用 Ed25519 在发布时签名，客户端用内置公钥在**下载前**验证（fail-closed），`electron-builder create-update-key` 生成、经 `ELECTRON_BUILDER_UPDATE_SIGN_KEY` 注入。v27 默认**必填**（`updateManifest:false` 才关）。这堵住了“更新清单只靠 HTTPS 保护”的缺口——与本项目安全取向高度契合，**建议开启**。另有 `allowUnverifiedLinuxPackages`（默认 true，可强制 deb/rpm GPG 校验）。
- **把现有 Sigstore 构建证明延伸到安装包**（本次读 GitHub 文档）：
  - 用 `actions/attest-build-provenance@v2`（v4 起是 `actions/attest` 的包装），对每个安装包产物签发 SLSA provenance，公共仓库用 public-good Sigstore，证明存 GH attestations API。权限需 `id-token:write / attestations:write / contents:read`。README：github.com/actions/attest-build-provenance。
  - 用户用 `gh attestation verify <artifact> --repo DuskXi/ArkRecord-Web` 核对（docs.github.com use-artifact-attestations）。
  - 可对每个 dmg/exe/AppImage/deb/rpm 都 `subject-path` 签发；也可同时签 SBOM。
  - **GitHub 不可变发布（Immutable releases）**：开启后发布资产与 tag 锁定、自动生成 release attestation，用户 `gh release verify` / `gh release verify-asset` 核对（docs.github.com verifying-the-integrity-of-a-release）。建议一并启用。
- **Electron 可复现构建的难点 [确认+二手]**：
  - Electron 二进制本身由 Electron 团队构建，你的可复现性只覆盖“你的应用层”（asar + 安装器封装）。
  - 时间戳：需尊重 `SOURCE_DATE_EPOCH`（reproducible-builds 规范），但 electron-builder 对 NSIS/dmg 内嵌时间戳是否完全确定**无官方保证**，实践需 `diffoscope` 比对两次 clean build。
  - 代码签名会改变产物字节——可复现校验通常针对**签名前**的中间产物，或像 Signal 那样**只对 Linux deb 做可复现**（Signal `reproducible-builds/README.md` 明说 Win/mac 尚不可复现，Linux 走 Docker 固定环境 `./build.sh` + `sha256sum` 比对）。
  - asar 顺序：electron-builder v27 修了 `asar.ordering` 并加 `contentAlignment`（利于差分更新与确定性）。
  - **现实建议**：对**安装包签发 Sigstore 构建证明 + 不可变发布**是最可落地、用户可核对的方案；“字节级可复现”对 Electron（尤其 Win/mac 签名后）成本高，可像 Signal 一样先只保证 Linux，或退而用“GitHub Actions 公开构建日志 + 构建证明 + 每日 audit”这套（项目已有 audit-deployment.yml 的思路可复用）。

---

## 6. CI 矩阵（GitHub Actions runner 现状）

本次读 actions/runner-images README + docs.github.com GitHub-hosted runners reference（抓取成功）：

- **公共仓库免费且不限量**（“Use of the standard GitHub-hosted runners is free and unlimited on public repositories”）。ArkRecord-Web 是公开仓库，全部平台免费。
- 标准 runner 标签（公共仓库规格）：
  - Linux x64：`ubuntu-latest`=`ubuntu-24.04`（也有 22.04、26.04）——4 vCPU / 16GB / 14GB SSD。
  - **Linux arm64：`ubuntu-24.04-arm`（也有 22.04-arm、26.04-arm）**——4 vCPU / 16GB。公共仓库可用。
  - Windows x64：`windows-latest`=`windows-2025`（也有 2022）——4 vCPU / 16GB。
  - **Windows arm64：`windows-11-arm`**——可用（4 vCPU / 16GB）。
  - macOS arm64：`macos-latest`=`macos-26`（也有 14/15）——M 系，3 vCPU / 7GB。
  - **macOS Intel（x64）**：`macos-15-intel` / `macos-26-intel`——4 vCPU / 14GB。
- **macOS 13 已下线**：GitHub 2025-09 公告 macos-13 于 **2025-12-04 退役**（github.blog changelog）。Intel 迁到 `macos-15-intel`；**Apple 已停 x86_64，GitHub 将在 macOS 15 runner 于 2027 秋退役后不再支持 Intel**。即：Intel mac 构建还能用到 ~2027 秋，之后 x64 mac 需自建/Tahoe Rosetta 或放弃。
- 典型构建时间/体积量级 **[推测，按经验]**：每平台 Electron 应用构建约 5–15 分钟（装依赖 + electron-builder 下 Electron 二进制 + 打包/签名）；产物体积：Win NSIS ~70–110MB、mac dmg ~90–140MB（universal 更大）、Linux AppImage ~90–130MB、deb/rpm 相近。Electron 44 linux-x64 解包后 ~222MB（本次实测），压缩进安装器后显著减小。
- 建议矩阵：`{windows-latest, ubuntu-24.04, ubuntu-24.04-arm, macos-15-intel(x64), macos-latest(arm64)}`；各自跑 electron-builder，attest + 上传到同一 GitHub Release。

---

## 7. 结论建议

### 7.1 推荐技术栈
- **纯 Electron（TypeScript 主进程 + 复用现有 Vue3/Vite 前端），不引入 Python。** 理由：核心逻辑已全是 TS；主进程 `net.fetch`/`ses.fetch` 就是 Chromium 网络栈，无 CORS，可把 `worker/upstreams.ts` 的转发白名单原样搬进来、免掉 Worker；内嵌 Chromium 对极验登录最稳；签名/公证/供应链审计/体积负担最小，契合项目“简单、可公开核对”的叙事。
- 次选（若强求小体积且愿逐平台测 WebView）：Tauri 2 + 现有前端，仍**不加 Python**。
- Electron 版本锁 44.x LTS 窗口内的稳定版；electron-builder 用稳定的 26.x（v27 稳定后再上，可享签名更新清单；现在 v27 还是 alpha）。

### 7.2 取 token 的推荐方式
1. **应用内嵌独立会话登录窗口**（BrowserWindow + `persist:` 独立 partition + contextIsolation/sandbox/无 nodeIntegration），用户在官方 `user.hypergryph.com` 自己登录；应用用该 session 的 `ses.fetch`/`ses.cookies` 走完 §0 的 token 链；登录后可清会话。极验由官方页面在真实 Chromium 内自行处理。
2. **并列提供森空岛扫码登录**（§0，免处理极验，最傻瓜）。
3. **保留手动粘贴 `account/info/hg`** 作为兜底。
4. **明确不做**：读其它浏览器 cookie 库 / 调试用户日常浏览器 / 带调试端口启动系统浏览器——不可行（Chrome 136+ 默认 profile 封禁）、与窃密木马同形、触发 EDR 误报、损害项目信誉。

### 7.3 MVP 范围
- 平台：先 Windows（NSIS）+ macOS（dmg，arm64 优先、x64 其次）+ Linux（AppImage + deb + rpm）。
- 功能：内嵌登录取 token（内嵌窗口 + 森空岛扫码 + 手动兜底）→ 主进程直连鹰角接口（移植 Worker 白名单）→ 复用现有前端做本地 IndexedDB 存储与统计 → 自动更新（electron-updater + GitHub Releases）。
- 云同步、Flatpak、米哈游系游戏支持放到 MVP 之后。
- 签名：Windows 申请 SignPath Foundation 免费 OV（或先 Store MSIX）；macOS 认 99 USD/年 Apple 会员；Linux GPG。
- 可审计：每个安装包 `actions/attest-build-provenance` 签发构建证明 + 开启不可变发布 + 签名更新清单。

### 7.4 主要风险清单
1. **极验/风控**：内嵌 Chromium 登录能否稳定过极验、鹰角是否对自动化/UA 做风控——**需尽早在真机实测**（最高优先级未知项）。森空岛扫码可作为规避极验的保底路径。
2. **macOS 签名成本**：绕不开 99 USD/年；否则用户遇 Gatekeeper “已损坏”，体验崩。
3. **Windows 信誉冷启动**：OV/EV 都要积累 SmartScreen 信誉，前几周会有“无法识别的应用”告警；Smart App Control 可能直接拦未签名。MSIX/Store 可规避。
4. **AV 误报**：即便纯 Electron，“本地应用自动发请求到鹰角 + 内嵌登录窗口”也可能被个别 AV 误判；务必签名 + 提交厂商白名单 + 不碰任何类窃密行为（这也是弃用“调试浏览器取 token”的硬理由）。
5. **跨平台构建**：无交叉编译，CI 必须多平台 runner；macOS Intel 2027 秋后 runner 消失的长期问题。
6. **云同步同源模型**：桌面版 origin 非 `ark.kaltsit.dev`，需改造 Worker 的同源校验或改走主进程转发（token 不上云的约束要保持）。
7. **Electron 体积/更新带宽**：安装包近百 MB，自动更新建议上差分（NSIS differentialPackage / blockmap）。
8. **可复现构建**：Electron（尤其签名后的 Win/mac）字节级可复现难；建议以“构建证明 + 不可变发布 + 公开 CI”替代，Linux 可追求可复现。
9. **供应链**：若真加 Python，npm+PyPI 双链审计与 PyInstaller 误报会显著加重——再次支持“不加 Python”。

---

## 附：关键来源 URL
- Chrome 远程调试变更：https://developer.chrome.com/blog/remote-debugging-port
- Chrome cookie ABE：https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html
- Chrome DevTools MCP / chrome://inspect：https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session
- Firefox Remote Agent 安全：https://raw.githubusercontent.com/mozilla-firefox/firefox/main/remote/doc/Security.md ；CDP 弃用：https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/
- Elastic cookie-theft 规则：https://www.elastic.co/guide/en/security/current/potential-cookies-theft-via-browser-debugging.html
- SpecterOps：https://specterops.io/blog/2025/08/27/dough-no-revisiting-cookie-theft/ ，https://specterops.io/blog/2026/08/13/chrome-devtools-protocol-cookie-theft/
- Electron 安全/会话/net/fuses/签名：https://www.electronjs.org/docs/latest/tutorial/security ，/api/session ，/api/net ，/tutorial/fuses ，/tutorial/code-signing （本次读 GitHub 源码 electron/electron docs/）
- Electron 38 Wayland：https://www.electronjs.org/blog/electron-38-0
- electron-builder 文档：https://www.electron.build/ （本次 clone electron-userland/electron-builder website/docs/：multi-platform-build、auto-update、signed-update-manifests、appimage、linux、mac、whats-new-v27）
- Electron Forge：https://www.electronforge.io/ （clone electron-forge/electron-forge-docs）
- PyInstaller：https://pyinstaller.org/en/stable/ （clone 读 doc/）
- Nuitka：https://nuitka.net/doc/commercial.html （README raw）
- python-build-standalone / Astral：https://astral.sh/blog/python-build-standalone ；docs running.rst
- PyOxidizer 停更：https://gregoryszorc.com/ (2024-03)
- Briefcase：https://briefcase.readthedocs.io/ （clone beeware/briefcase docs）
- Tauri sidecar / cookies_for_url：https://v2.tauri.app/develop/sidecar/ ，https://github.com/tauri-apps/tauri/pull/12665
- GitHub runners：https://github.com/actions/runner-images ，https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- macos-13 退役：https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/
- 构建证明：https://github.com/actions/attest-build-provenance ，https://docs.github.com/en/actions/.../use-artifact-attestations ；不可变发布：https://docs.github.com/en/code-security/.../immutable-releases ，.../verifying-the-integrity-of-a-release
- Windows 签名：https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options ，/smartscreen-reputation ；Azure Artifact Signing：https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart ；SignPath：https://signpath.org/terms ；Smart App Control：https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control
- macOS：Apple Developer 99 USD：https://developer.apple.com/programs/whats-included/ ；Store 免费注册：https://blogs.windows.com/windowsdeveloper/2025/05/19/...
- 鹰角登录接口（GitHub code search）：as.hypergryph.com/general/v1/send_phone_code、/user/auth/v2/token_by_phone_code；极验处理：github.com/baiqwerdvd/ArknightsUID login.py
- yt-dlp DPAPI：https://github.com/yt-dlp/yt-dlp/issues/10927 （cookies.py 源码确认报错）
- 本地服务防护：NCC Singularity（DNS rebinding）、MCP SDK hostHeaderValidation；Chrome 142 LNA（搜索摘要）
- Signal 可复现构建：https://github.com/signalapp/Signal-Desktop/blob/main/reproducible-builds/README.md
