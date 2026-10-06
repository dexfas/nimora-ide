# Nimora Phase 11 / Phase 12 接手交接 — 2026-09-30

## 0. 停止点与用户指令

用户明确要求当前对话停止工作、总结后交给下一位对话。已停止验收和运行链路修改，仅保存交接。下一位收到用户继续指令后再工作。

用户此前已授权：接替已停止的 AI；完成 Phase11，包括 WO2/WO3；只读独立子 agent 验证；电脑重启后更换失效 URL。用户最新优先级是 Phase12 真正可用，不影响落地的项目暂缓。用户打算让其他对话开发 Phase12；没有授权当前对话主动给那个对话发消息。

**Phase11 尚未 CLOSED。** 不要把源码测试、host MCP metadata 成功或模型自报成功写成真实 provider 验收。Phase12 可以并行隔离开发；不能因 Phase11 尚未关闭而无限推迟产品工作。

## 1. 先读与工作边界

- 父目录：`C:/Users/devil/Documents/Ai/shuncode`。
- 主源码：`C:/Users/devil/Documents/Ai/shuncode/shuncode开源`。
- 必读父目录 `SHUNCODE_AI_HANDOFF.md`、主仓库 `AGENTS.md`、`docs/architecture/README.md`、`AI_DEVELOPMENT.md`、本文件、`PHASE11_WO2_WO3_IMPLEMENTATION.md`、`PHASE12_PRODUCT_SHELL.md`。
- 父交接文件部分历史中文已有乱码；保留编码和原文，不进行全文件重编码修复。
- 工作树有大量累积修改/未跟踪文件，包含别的对话的 Phase12 源码；不 reset、clean、stash 或覆盖它们。本对话未提交代码。
- `C:/Program Files/ShunCode` 只读；只使用 repo `.build/shuncode-dev-*` 的隔离开发实例。
- 禁止通过 debugger/CDP 的 `Runtime.evaluate`、`_VSCODE_IMPORT` 或 `require(vscode)` 注入执行隐藏宿主命令。历史 `.build` 脚本有这种做法，使用前必须审查。
- 正常用户 UI 命令和已开放浏览器 builtin 工具可用。只读 Debugger.getScriptSource 可核对 loaded source hash。
- 用户的页面共享、登录/网站验证、MCP 安装与授权、原生权限批准由用户本人完成。阅读 computer-use skill 后再操作 UI。

## 2. 本轮已经完成的代码工作

### 2.1 WO1 composer 修复

`extensions/shuncode-webmcp/chatgpt-worker-controller.js` 支持有界组合：一个 app 前导分隔符、与 expected text 对应的 P/NBSP 缩进、一个末尾空 P；最终必须整段严格相等，不用模糊 trim/PRE 改写。新增正例组合与最后字符不匹配拒绝提交回归。

源码 SHA256：`61FCB1CEB99D41DE4C4E74DF102E49A0D7BDB443CC95BBE6E55675AB47575A0A`。重启后通过只读 loaded script 检查确认当前实例已加载这个 hash。不能声称重构了旧 061 的缺失 DOM，也没有新的真实 RWV PASS。

保留接手前已有 `src/mission-coordinator-live-driver.ts` 的重复 exact-empty invocation **result-only** 返回：不重新执行语义操作。局部回归 PASS，实际 provider 接受尚未证明。

### 2.2 WO2 / WO3 主分支集成与后续修复

已把隔离 WO2/WO3 16 文件交付集成到主源码，保留较新的 Coordinator 修复。集成备份：`.build/phase11-takeover-integration-backup/manifest.json`。

主要新增/修改：

- `src/mission-worker-selection-application.ts`：先验证再改变所有权；known-settled 同 Mission 替换；`recoverAfterRestart` 走 canonical machine-proof orphan recovery；无旧 send 重放。
- `extensions/shuncode/src/mission-native-mcp-connection.ts`：公开 `Nimora: Connect Mission Native MCP`，选择精确当前 ChatGPT Target，显示读/读写/读写终端范围，准备 native route；它不授予权限、不发送任务。
- `src/mission-user-entry-application.ts`：初始 Formation 输出和后续普通请求显式声明 `requiredCapabilityIds`，按 canonical catalog 严格验证；缺 route 在 Target send 前拒绝。
- `continueWithCognition`：用已选 native API/Codex substrate 做 tools-free、有界的新请求解释，只输出 instruction/capability IDs，复用原 Project/Mission，不重做 Formation 或重放旧请求。
- 直接 `continue` 必须给显式 materialization，不能静默读权限默认值。
- `extensions/shuncode/src/mission-user-entry.ts` 接上述路径，Worker QuickPick 设置 ignoreFocusOut。
- `scripts/shuncode-mission-user-entry-smoke.mts` 覆盖 missing declaration/route、continuation 不重建 Project、restart recovery、公开 MCP setup scope/身份约束。
- `product.json` 增加 `shuncode.shuncode` 的 `chatSessionsProvider` proposed API，与扩展声明一致；源码检查一致，不代表安装版已验证。

这里 API/Codex 是请求 Cognition substrate，**不是自动注册成 production Mission Worker pool**。普通入口当前主要执行一轮 `deliverExplicitMissionInput`；自动 Evidence/Problem/Answer、独立 Verification、root completion 闭环尚未完整接线。

## 3. 验证结果与具体限制

- continuation 回归 PASS：`.build/phase11-continuation-capabilities-regression.log`。
- 重启后 `typecheck-shuncode` PASS：`.build/phase11-post-reboot-typecheck.log`。
- 重启后 `compile-shuncode` PASS：`.build/phase11-post-reboot-compile.log`。
- 之前 composer / replacement / user entry / Coordinator / native MCP / runtime 相关回归 PASS，见既有实现文档和日志。
- 用户授权的只读 reviewer `/root/phase11_independent_verification` 已完成，13:01–13:02 Asia/Shanghai 结论：**完整 Phase11 FAIL/PENDING**。
- reviewer 独立执行六项 deterministic PASS：mission-user-entry、worker-replacement、phase11-native-mcp、phase11-production-routing、mission-finalization、mission-coordinator-completion。这些采用模拟 adapter/commands，不能叫真实服务 PASS。
- reviewer 的 ChatGPT synthetic smoke 被电脑重启打断，没有新结果，不能补写 PASS。
- WO1：真实 read → apply_patch → read-after 待验。
- WO2：源码/模拟 PASS，真实跨 provider 执行与接班验收待完成。此次实际 machine-proof recovery 及新 Target 挂接已成功，不等于完成全部 WO2。
- WO3：源码/模拟 PASS，真实普通入口、当前 app 自动衔接仍待验。
- WO4：实际可打开产物 + feedback + Verification + root completion 尚未完成。一个 provider turn 完成不等于 Mission 完成。

### 重启/构建事故

本轮误启动 root `npm run compile`（应为 `compile-shuncode`）。用户整机重启中断它，使 out 缺文件。已用 canonical `npm run transpile-client` 重建输出，再启动原隔离 profile，后续正确 typecheck/compile PASS。

证据：`.build/phase11-post-reboot-transpile.log`、`.build/phase11-post-reboot-restored-launch.out.log` / `.err.log`。重启前 continuation typecheck/compile 日志含 NUL，不能当新 PASS。不要为了第一方修改再次运行完整 root compile。

## 4. 当前精确 scope、进程与浏览器

这些是交接时的观测，接手后先复核 liveness，不能仅凭历史 PID 判活：

| 对象 | 当前值 |
| --- | --- |
| Project | e99a2c78-5c0c-4960-902e-1db309f10068 |
| root / Target Mission（cognition plane） | ba166044-c0b9-4017-8c02-508769d41396 |
| Coordinator Mission | 41d5107e-b03c-406e-9cfa-50e2bd9f5175 |
| Extension Host PID | 21224 |
| runtime incarnation | 711ca5fc-881e-4567-91c3-00b50edc1744 |
| Dev native window id | 2229874，app ShunCode.ShunCode |
| control / inspector / CDP | 49322 / 49330 / 49331 |
| Gateway | 49321，已恢复 healthy |
| logs | .build/shuncode-dev-user-data/logs/20260930T124517 |
| Coordinator managed session | 8e9380eb-f894-45dd-b159-becdf792e930 |
| Coordinator adapter | ad7d3b39-1b40-4e03-adb8-12f1a1937d4c |
| DeepSeek page | 07a58c1b-5059-4536-9ec1-23dc8fbe8d0f |
| Target managed session | b81499cd-541b-4804-8a19-735ca2e0e472 |
| Target adapter | 5cf7b5c866453e9603841a3fc0a84a60347de0d1e0dd2a35f98c4203742d5d32 |
| Target page | 4b01b5a5-9eb8-4a74-ab48-300f8c7894c5，https://chatgpt.com/ |
| old settings page | 3f41f5d6-09b0-452c-8a27-3dbd2a9820e2，仅旧 app 管理 |

旧 Target `240eea28-dd24-48de-9c78-f985d5374485` 在 `2026-09-30T04:58:05.764Z` 经 canonical machine-proof recovery 退役。旧 page lineage 不得重用；用户已认证/共享新页，当前 Target 在 `05:08:30.379Z` 实际挂接到相同 Mission。

Task journals：`.build/shuncode-dev-user-data/User/globalStorage/shuncode.shuncode/task-runtime-v1/<mission>.jsonl`。只能读，不直接编辑。

## 5. 当前 MCP 与最末 UI 状态（下一位必须先处理）

公开 setup 已生成精确 Target-bound native MCP，binding：`cfed429b-eb08-442f-8116-3c12e00eca49`。

完整当前 URL **只在本地** `.build/phase11-sept30-recovery-current.json` 的 `nativeMcp.publicUrl` 读取，不把路由 token 写进公开提交或产品 UI。域名为 boxes-brochures-hearing-moms.trycloudflare.com；重启后可能失效，先验证，不猜新 token。

读取并编辑 workspace policy 显式 required：workspace.read-files + workspace.apply-patch。当前 cognition profile metadata 实际 9 tools：apply_patch、read_files、lsp、get_diagnostics、get_command_output、wait、find_files、list_directory、search_files。不能照旧实践 profile 声称 11 tools。

Host-origin initialize / tools-list 各 200，仅 metadata reachability；diagnostic session 已删除，无 activeTurn、无工具执行。稳定 relay reads-removing-wifi-baseline 路径本轮同步失败，不能当当前可用 route。

用户已确认安装/重建新 app 完成。当前 Target 的加号菜单已实际看到 **Nimora Phase11 Current / 当前 Mission 工作区连接**。新 app id 未读取，不假定已经正确附到 composer。

**最末操作有未解决的 UI 问题：**通过 builtin click_element 点击菜单 ref e836（标注 Current）后，实际 composer 却显示 **Nimora Phase 11 MCP WO1 Final**。这个旧 app 的原 URL 已失效，不能发送。Escape 已关闭加号菜单；最后只读 read_page 再确认 Target 仍在首页，textbox 内仍是旧 app 标签。无法判断是错误 app chip 还是普通文本，需实际 DOM/可访问性复核、通过正常编辑清除，然后正确选择 Current。没有 Enter/send，也没有 provider proof。

只读 `.build/phase11-current-target-observe.mjs` 在此次选择后长时间没有返回，已在用户停止时 Ctrl+C 结束，exit1无结果；**不要把旧 JSON 当此刻观察**。不要盲重跑挂起脚本，先用小范围 read_page / readonly DOM。

## 6. proof 身份和零副作用现状

历史 consumed pairs 全部禁止 replay，包括 049/051、052/054、055/057、058/060、**061/063**。不要因某次未执行到写文件就重用它。

本轮没有创建 successor proof IDs，没有 provider proof send，没有手工 proof fixture 写入。

用户停止后只读复核：`.build/phase11-live-chatgpt.txt` 仍为 `PHASE11_CHATGPT_BEFORE`；SHA256 `74551F963AA872169E9DD8ECB329134F9BF67C7856ECABE12ABBB7FE165AD4E5`。Target journal 最后仍是新 Worker Attached，未新增 proof 执行。

## 7. 接手后最短推进顺序

1. 读取本文件和入口文档，检查当前 dirty tree、进程/端口和两个 Worker 的真实健康；保留现有实例，避免不必要 reload 使 MCP 再失效。
2. 清理上述 Target 首页的旧 app draft/mention；正确附加用户已安装的 Current。核对新 app route 与当前 binding，composer 正文空且仅正确 app。授权提示交给用户。
3. 经**正常 native Work Sessions / Chat** 开始有界实际任务，走 ordinary request Cognition → canonical Coordinator → 精确 Target；不通过 debugger 内部命令注入、不人工直接给 Target 发 proof prompt。
4. 用一个新且未消费的 input identity 完成一次 BEFORE read、一次 exact apply_patch、一次 AFTER read。route 只在实际 Phase8 activeTurn 内执行；不能用 host callTool 绕过。副作用或 submit 不盲重试。
5. 以 journal/execution counts 和真实文件核对 provider-origin RWV；失败后按真实状态收敛，不重放 consumed input。
6. 把真实跨 provider replacement、普通新 Project 入口和实际可打开产物补齐；实现/验证必要 feedback、Verification/root completion。依据最小可用产品范围推进，避免再扩展不影响落地的架构。
7. 必要时请求原只读 reviewer 对新增真实证据进行独立验证；不能把之前的六个模拟 PASS 当 live final acceptance。
8. 更新 PROJECT_STATE、roadmap 和父 SHUNCODE_AI_HANDOFF 的当前状态/日志；如用户明确修改验收范围，列 deferred 清单、原因与已测限制，不伪造原完整 Phase11 CLOSED。

### 正常 UI 与工具操作提示

- Native 用 node_repl 的 `@oai/sky`。读取 computer-use skill；截图一直 FrameArrived timeout，indexed click 也 geometry unavailable，但 accessibility + set_value + keyboard 可用。
- **F1** 可可靠打开 Command Palette；CtrlShiftP 有时被浏览器焦点吃掉。读当前 input index，用 set_value 筛选，再读 unique option，Return。QuickPick 不筛选就 Return 常只关闭不选择。
- `Nimora: Open Work Sessions` 是公开入口，映射 workbench.action.chat.history。选择现有 persistent Phase11 Target，Mission 资源 scheme 是 nimora-task。尚未真正发起此次普通 proof 请求。
- Native model picker 可见 GPT-5.5，但 provider 配置未证实；若 Cognition 需要模型，使用实际已配置 provider，不读出 credential。
- 本地 browser builtin `POST http://127.0.0.1:49322/invoke`，payload `{name,input}`；正常 list_browser_pages/read_page/click_element/type_in_page/navigate_page/open_browser_page 可用。
- 每次 UI 动作后重新 read；ref 会漂移。不要把菜单点击工具返回当已选 app 的证据。

## 8. Phase12 并行优先级与已有源码

别的对话已留下：`src/nimora-product-shell-projection.ts`、`extensions/shuncode/src/nimora-product-shell.ts`、`scripts/shuncode-nimora-product-shell-smoke.mts`。细节 `PHASE12_PRODUCT_SHELL.md`。它是既有 Project/Mission read model 的外壳，未在运行中的 extension 注册；之前 registration 已撤回，不能误称用户已能用。

**必须优先完成：**普通需求创建/继续 Project、真实读写文件与验证、可打开交付物、必要授权提示、失败/UNKNOWN 可理解且可恢复、同 Mission 明确接班、重启后不重复执行、必要反馈与独立验收闭环。

**可以暂缓：**视觉打磨/动画、更多 provider/models、复杂并行、完整统计面板、非必要全面重构、安装器与广泛发布。运行中最小 dev 产品不等于完整发布。

在隔离 worktree 开发 Phase12 与必要闭环；集成前刷新 main 的 extension registration / manifest，明确一次 build/reload 窗口，保留活跃 Phase11 Worker/MCP。不要另建 ProjectStore/TaskRuntime/调度 owner。

`PHASE12_PRODUCT_SHELL.md` 的 “Today's usable boundary” 是源码路径描述，不是完整真实模型产品 E2E PASS；下一位应按上述事实修正/补证。

## 9. 其它精确检查点

- `.build/phase11-sept30-recovery-current.json`：本地 runtime/source hashes/MCP URL snapshot。
- `.build/phase11-sept30-recovery-checkpoint.mjs`：生成检查点与文档的历史脚本。含硬编码 pending 状态，**不要盲重跑覆盖更新后的事实**。
- 原独立 reviewer 新 Target 05:08 挂接前已完成，不把它的检查范围扩展到后发生的动作。
- 当前交接仅文档更新；没有正式安装版变更，没有新 provider send/WRITE，没有 Phase11 close。
