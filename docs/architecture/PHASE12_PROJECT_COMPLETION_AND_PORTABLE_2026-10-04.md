# Phase12 — 正式完成入口与独立桌面包

更新时间：2026-10-04 03:48 CST。当前为 SOURCE/TEST/PACKAGED/第一方 activation PASS；完整网页 Project 验收仍 PENDING。

> **Phase13 supersession note（2026-10-04）：** 本文第45行所述“通用每请求文件 allowlist 尚未实现”已被后续 `PHASE13_PRODUCTIZATION_2026-10-04.md` 部分 supersede：现在已有 TaskRuntime 持久化的 per-input workspace path policy，并对 canonical file tools 的实际文件访问 fail-closed 强制；path-scoped IDE tools 也增加 target-path admission。**全 OS command sandbox 仍未实现/认证**，所以本文关于 OS sandbox 的发布边界继续有效。

## 验收范围

Human 明确选择“保留当前项目，另建独立验收项目”。原个人任务管理器 Project774ec5e8、root6882f1fc、Coordinator7fa7e64e、Practice9eb0182e及原三页/旧请求全部保留。本轮没有向原 Worker 发送目标、重放请求或结束原 Mission。03:33只读审计仍44执行/44投递、Attached41/Retired36；旧 UNKNOWN consumed-no-replay 不改写。

独立工作区：`C:\Users\devil\Documents\Nimora-Acceptance-20261004`。新建 SEED.txt 是验收方提供的输入 fixture，不是网页 AI 的交付产物；SHA256 612ff5c7e5d05b2dd42bfefbcebc81551a4fd0cee07e767079957685cbb90e09。尚未形成独立 canonical Project/Mission，也没有向网页发送验收目标。

## 正式完成入口

新增 Product Shell “审核并完成 Project” → `shuncode.nimora.reviewProjectCompletion`，接入已有 canonical composition。仅支持当前正式网页 Formation、单一 root、原规划连接健康、root/Coordinator唯一且idle的 Project；历史 adopted Project 的保留合同仍拦截完成。

- `MissionCoordinatorCompletionService.inspectReadiness` 只读观察既有机械谓词；不是完成授权。活动子 Mission、UNKNOWN/pending工作、依赖/Problem、无效 Handoff 等继续由原 owner 拦截。
- 只向独立 tools-free Web Cognition 提供有界 canonical criteria、实际execution/resultPayload、artifacts、relation/exchange和Worker身份；不把网页会话全文或UI100%作为完成事实。超限停止，不截断后宣称完整。
- Cognition 返回严格 ready/blocked JSON；ready的确切Project/root/Coordinator/completionKey必须匹配本轮。Human普通业务确认取消零发送；确认后重读全部证据，变化零发送。
- 完成inputId在首次副作用前写入workspace memento消费锁；保存失败零发送。该锁不是成功真值、队列或重放授权。生成本轮 canonical审核report artifact 后，将 Cognition 的 `completeManagedScope` 指令交给原application/live driver。
- 只有确切 `postTurnCompletion`、commandExecuted及root/Coordinator均archived才报告正式完成。没有结果、错误scope、partial或provider不确定均保留 consumed，不盲重试。
- 原domain仍要求Coordinator可信completed terminal后，执行Coord-first/root-second finalization、Handoff、Worker retirement、archive；没有直接改SQLite/journal或另建scheduler/brain。

回归：新增 ingress exact scope/extra fields/blocked/cancel/stale evidence/storage failure/single flight/UNKNOWN/no result/wrong returned scope/partial/no-replay PASS；实际生成Webview click forwarding PASS；原Coordinatorcompletion全套及新增只读零mutation PASS；typecheck、标准incremental compile、runtime hello/MCP search PASS。

## 桌面发行目录

目录：`C:\Users\devil\Documents\Ai\shuncode\VSCode-win32-x64`，由标准gulp桌面链生成，不修改Program Files。最终 `vscode-win32-x64-ci` 于03:38:05全流程PASS，包含确切返回scope/archived UI验证修正。source与packaged extension dist SHA256一致：67da8335c9fd4e4c8ba6d2a49d9aa69b5761d6954420d7e4d38c709caf7bfa82。

已解决实际打包问题：

1. 原生addon由开发宿主持有：第一方esbuild支持 `SHUNCODE_BUILD_INCREMENTAL=1`，保留既有严格二进制哈希比较；默认clean不变。
2. Node原生fetch不使用Windows代理：Electron SHASUMS256下载实测UND_ERR_CONNECT_TIMEOUT。仅在构建进程设置HTTP(S)_PROXY和`--use-env-proxy`，下载与SHA256检查保持启用，未变系统代理。
3. 此OSS发行版不含Copilot扩展，local packager已返回空stream，但后续shim曾强制要求SDK。仅当发行目录没有Copilot manifest时跳过；存在manifest仍严格要求完整匹配SDK，不伪造扩展。
4. signtool在已安装Windows SDK里但未入构建PATH：仅当前构建进程加入SDK x64目录，未禁用签名检查或修改系统PATH。
5. Gateway生产staging执行锁文件 `npm ci --omit=dev --ignore-scripts`，95包，明确13个源码资产allowlist；不会打包浏览器profile、登录态、workspace或私有凭据。VSCE实际包含gateway-local依赖。
6. Gateway使用`process.execPath`及`ELECTRON_RUN_AS_NODE=1`，复用发行桌面自带Node，摆脱PATH node.exe依赖。

新增Start-Nimora.cmd与README-Nimora.txt，从canonical resources通过标准packager生成。用户启动器使用LOCALAPPDATA/Nimora独立profile，保留ShunCode内部兼容标识。

03:35真实portable smoke：发行exe的embedded Node启动发行目录Gateway，health integratedWebMcp=true/controlVersion2，SDK依赖和第一方rg/native addon均存在，PASS；source checkout不作为Gateway cwd，未调用网页或workspace工具。该smoke不等于网页AI/完成验收或安装器验收。实际源码Gateway-location启动回归/JS语法PASS。

## 未通过的独立验收门

最终发行包启动/第一方activation已PASS；独立网页登录共享、全新Formation→实际文件执行→语义review→真实Coordinator完成→Handoff/归档/完成UI仍需现场证据。原项目恢复/读写/Worker切换历史证据保留，但不能替代此项。Phase11核心CLOSED不变，Phase12 READY_FOR_USER_TRIAL / 正式OPEN。

全OS命令沙箱、通用每请求文件allowlist、任意provider/任意重启自动恢复仍未实现。登录、页面共享、工作区信任、应用安全授权由Human处理（computer-use mandatory deny）；普通业务输入/确认及验收由agent继续。


## 最终发行文件与实际启动

历史 ZIP：`.build/releases/Nimora-Beta-Windows-x64-20261004.zip`，368703311 bytes，SHA256 e8a5d5a7d88dfb2cc2ab5715f17517299bae5cb055f717162013c639cdce5f5d。**13:32 CST 后续审计发现该归档本身未包含 `resources/app/node_modules.asar.unpacked/@vscode/windows-ca-certs/build/Release/crypt32.node`，因此此前“该 ZIP 自身 portable smoke PASS”的表述被撤回。** 当时实际通过 native fix 的桌面目录仍保存在 `VSCode-win32-x64-nativefix-20261004`；后续修正发行见本文末尾。

独立窗口03:39启动；Human已信任并运行Nimora: Open，确认看到界面。03:42:09两项第一方extension激活，ShunCode.log实际loaded0Project/0Task，Bridge50322启动/shared0。验收profile为`.build/nimora-acceptance-20261004`，Gateway50321，未拷贝原profile登录态。

窗口自动化多次刷新返回同一窗口，但捕获报 `window id … no longer belongs to ShunCode.ShunCode; current owner is ShunCode.ShunCode`；使用返回id-only重绑定仍不能捕获，未向该窗口发送键盘输入。已请求Human从正式“+ 使用 DeepSeek 网页新建 Project”入口输入一次有界SEED读取→RESULT单次创建→完整复读目标，并完成网页安全授权。此时仍无新Project/Mission或provider请求；不可把待授权/待执行当作已验收。


## 04:00 最新网页准备故障

2026-10-04 04:00 CST：独立发行版第一方 activation/PACKAGED PASS；最新网页建项准备停于1/3健康、2共享候选。实际Bridge日志：c6e2dd9e ready=true/composer=true；342b0cd3 ready=false/composer=false/auth=false/compatible=true。后者未观测到聊天输入框，登录/加载/站点识别具体根因未证明；prepareNimoraWebAi顺序等待第2个健康页，因此本次尚未继续开第3页。新profile canonical Project/Task/Collaboration存储目录仍为空，未形成Project。日志存在其他准备尝试和一次planning Worker connected，不能声称所有历史尝试均零provider send；本次awaiting-share分支在规划之前退出。UI捕获owner mismatch仍存在，需Human在第2页核对正常输入框和共享；不重放旧规划/工具。Phase11核心CLOSED不变；Phase12正式OPEN。

本轮只读取日志、只读SQLite key和canonical目录；没有UI输入、provider send、Workspace工具执行、runtimeDB/journal修改或重启。原Nimora-Test保留。修复前需要观察342b0cd3实际网页，auth=false不能证明已登录，也不能把composer=false直接归因为CloudflareURL或网关。

## 13:32 P2–P5 修正发行

本轮标准 `vscode-win32-x64-ci` 先完成 native extension compile/typecheck，随后因当前独立验收窗口正占用 `VSCode-win32-x64`，clean 目录时得到 Windows `EBUSY`。没有强杀用户正在运行的验收窗口。此前默认 `compile-shuncode` 也因开发宿主持有 `shuncode_process_metadata.node` 得到 `EPERM`；按已有正式开发规则设置 `SHUNCODE_BUILD_INCREMENTAL=1` 后 compile PASS，严格 native hash 检查未关闭。

保留的 `VSCode-win32-x64-nativefix-20261004` 具有 ShunCode.exe SHA256 `2645a9f39d732959f1a876b5238c8a5510b2fdaf05150fcab7deef6c886e5433`、旧 extension SHA256 `67da8335c9fd4e4c8ba6d2a49d9aa69b5761d6954420d7e4d38c709caf7bfa82`，与03:38记录一致，并包含 144896-byte `crypt32.node`（SHA256 `1e602c8fd94a3a08949292c4fd0b3e83e813f38161812d15f38e6a067a4c33a`），因此作为已知 canonical desktop base。覆盖本轮 freshly compiled `extensions/shuncode` 与 production-staged `extensions/shuncode-webmcp` 后，source/package extension SHA256 均为 `99f90af903826421c3d05c3d1ed3e1280e1b7a5da280b4b14b871b664de83d8`。

新归档：`.build/releases/Nimora-Beta-Windows-x64-20261004-P2-P5.zip`，361959813 bytes，SHA256 `88ef6e1e8bec6b6a66a6b6ec77595ed23d05f0bd8eb2e51984b8689bf4aa468`。归档列表明确包含 `crypt32.node` 与当前 `extension.js`；从 ZIP 完整回解到新目录后 `scripts/nimora-portable-smoke.mjs` PASS：packaged Electron Node 启动 Gateway、gateway deps、first-party native assets、Windows certificate native load、source-checkout isolation 均通过，且回解 extension hash 与 source 一致。归档名称扫描对 Cookies、Login Data、`state.vscdb`、browser-profile、私有 `.env` 为0命中。**providerAcceptance 仍为 NOT_TESTED。**

13:32 只读检查当前两个实际 Gateway：开发实例 `48321` 与独立验收实例 `50321` 均返回 `browserRunning=false`、`personalEdge.connected=false/shared=false`。当前没有可复用的已共享页面；网页登录和原生页面 Share 是 Human-only 安全边界，agent 未代点。因此当前发行工程与 archive acceptance 已完成，但真实 DeepSeek 新目标仍要在 Human 重新共享页面后单独取得 Provider ACK / Mission E2E 证据。
