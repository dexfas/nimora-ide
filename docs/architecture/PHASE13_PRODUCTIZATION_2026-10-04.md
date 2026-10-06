# Phase13 — Productization / Safety Boundary / Maintenance Closeout

更新时间：2026-10-05。当前结论：**SOURCE / FOCUSED TEST / FIRST-PARTY BUNDLE / FRESH EXTERNAL-PROVIDER ACCEPTANCE PASS；Phase13 产品化工程范围 CLOSED。Stable OS sandbox 源码接入已完成，但当前 Windows 主机 live certification 仍被宿主 isolation tier 阻断。**

本阶段承接 Phase12 已通过的 P0–P5 文理自治核心，不重建 Project/Mission/TaskRuntime/WorkerSession owner，不增加第二套 scheduler/outbox，也不把 Coordinator 变成第二个 Cognition。旧消费 input、历史 UNKNOWN 与 no-replay 规则保持原义。

## 1. Product Shell 与 Human Attention

新增 `src/nimora-human-attention.ts`。它只把 canonical/operational facts 翻译为 `working / waiting-external / needs-human / completed`，不拥有完成、重试、Worker assignment 或 Project truth。

Product Shell 新增 `NOW` 主状态。普通网页 Project 的主动作统一为“继续自动工作”，内部调用既有 `shuncode.nimora.runWebAutonomy`；ready frontier、按需 Worker assignment、conversation preparation、same-Mission succession、并行 Practice、反馈回 Cognition 与 completion-candidate 仍由原 owner 负责。

达到 `completion-candidate` 后进入正式 `reviewProjectCompletion`。最终 Human completion confirmation 没有被自动越过。`分配就绪 Mission`、单 Mission 继续、Worker 状态等入口下沉到“高级操作与诊断”。

`nimora.autonomyOutcome.v1` 只用于 UI 连续性提示，不是 completion truth，也不给 replay 权限。

## 2. Production Skills

新增 `extensions/shuncode/src/nimora-first-party-skills.ts`，production `NimoraSkillIndex` 不再为空。当前 first-party Skills：

- `nimora.cognition-evidence-review-v1`
- `nimora.practice-verify-before-report-v1`
- `nimora.coordination-transport-discipline-v1`

这些 Skill 只提供 subordinate workflow guidance：不拥有 Project truth、不授予 capability、不改变 approval、不把 Provider 文本升级为 Evidence，也不给 Coordinator 新的规划权。

## 3. Durable per-input workspace access policy

`TaskRuntime` 新增 durable event `TaskInputAccessPolicyRecorded`。策略绑定 exact `taskId + inputId + managedSessionId + allowedWorkspacePathPrefixes[]`。同一 inputId 不能在之后换绑 Worker 或扩大路径范围；Task journal replay 后仍存在。

tools-free Formation Cognition、existing-Project request Cognition 与长期 autonomy Cognition 的 Work Order contract 都加入 `allowedWorkspacePathPrefixes`。必须选择最小 workspace-relative literal prefix；只有确实需要整个 workspace 时才使用 `"."`。绝对路径和 `..` 被 admission 拒绝。

Coordinator 在 exact Worker send 之前持久化 policy。Canonical file tools `read_files / find_files / search_files / apply_patch` 的真实 absolute-path 访问都进入同一 permission check；missing/stale policy fail closed。

专项测试实际创建允许目录 `allowed/readme.txt` 与同工作区 `secret.txt`：允许文件可读，secret 得到 `PERMISSION_DENIED`；重启 TaskRuntime 后 policy 仍可恢复；同 inputId 试图改成 `"."` 被 identity mismatch 拒绝。后续 Stable hardening 又补了两个反例：不存在的目标文件如果位于一个已存在 symlink/junction 之下，会先 realpath 最近存在祖先再判断，因此不能借链接逃出 Work Order prefix；OS sandbox root 解析要求恰好一个 workspace root，多根歧义直接 fail closed。

Extension-host 的 path-scoped `list_directory / get_diagnostics / lsp` 在进入 broker 前也做 target-path admission。这里的安全承诺只到目标路径准入：语言服务处理一个允许文件时可能内部遍历更大的 project graph，不能冒称为完整 OS/data sandbox。

## 4. Terminal hardening 与 Stable 安全门

`terminal.run_command` 每次 capability invocation 都显式解析 workspace-relative cwd；省略 cwd 时从 workspace root 开始，不再继承持久 shell 先前可能漂到工作区外的 `cd`。工具说明已同步这一新语义。

Nimora host-managed `run_command` 现已接入 Code-OSS 的 Terminal Sandbox Engine，而不是只做逻辑 cwd 限制。可信 Host executor 从 exact `taskId + inputId + managedSessionId` 的 durable Work Order policy 解析真实 filesystem roots，并通过 extension 内部 `unique symbol` 非枚举字段把 roots 交给 Terminal manager；模型/JSON arguments 不能伪造这个字段。Terminal manager 只在看到该可信上下文时调用 Workbench 内部 strict wrapper，并要求返回 `isSandboxWrapped=true`，否则拒绝执行。

Strict wrapper 使用独立一次性 Sandbox Engine：write roots 只取 exact Work Order roots + 独立 strict temp；不继承整个 workspace、workspaceStorage、通用用户 TEMP 或 PSReadLine write roots；Windows drive-root readonly 项被剔除；network 强制 default-deny；allow-network、unsandboxed-command fallback 与 retry-with-network 均强制关闭。Sandbox temp 由命令状态拥有并在完成/失败/kill/dispose 后清理。Diagnostics 因此更新为：

- `osSandboxIntegratedWithNimoraTerminalCapability=true`
- `osSandboxExactWorkOrderWriteRoots=true`
- `osSandboxNetworkDefaultDeny=true`
- `osSandboxUnsandboxedFallbackDisabled=true`
- `osSandboxLiveCertifiedOnCurrentHost=false`
- `unattendedStableSafetyReady=false`

Windows Stable 另外增加 isolation-tier gate：只接受 MXC `base-container` 或 `appcontainer-bfs`；`appcontainer-dacl` 在创建 sandbox config 前就被拒绝，因为它依赖宿主 ACL mutation，不作为无人值守 Stable 的可信基线。

当前开发机的真实 MXC probe 返回 `availableMethods=[processcontainer]`、`isolationTier=appcontainer-dacl`。SDK 明确报告 BaseContainer 不可用、AppContainer+BFS 未编入当前 binary，并提示 system-drive metadata / NUL device host preparation；实际 live smoke 还在受保护的 `Program Files\\nodejs...node-gyp-bin` 遇到 `WRITE_DAC not granted`。因此 `npm run test-shuncode-strict-sandbox-live` 现在明确以 `HOST_PREREQUISITE_BLOCKED` fail closed，而不是退回无沙箱。没有执行 elevated `wxc-host-prep`，也没有修改宿主 ACL。

## 5. Diagnostics / backup / restore

新增 `shuncode.nimora.exportDiagnostics`。报告只包含 owner/reconstruction/integrity、Project/Mission lifecycle 计数、UNKNOWN、Provider availability、Worker lifecycle、autonomy outcome 与 machine-readable safety gates。

诊断按构造省略 Project title/goal/content、workspace path、Provider transcript、tool output、browser profile/login state 与 credentials/secrets。

新增 `nimora-project-backup-v1`：精确导出一个 Project 的 Project journal slice、全部 Mission Task journals 与 Collaboration journal slice；每段带 SHA-256，连续双读同一 Project slice，不稳定即拒绝；导出后在临时目录用真实 `ProjectStore + TaskRuntime + MissionCollaborationStore` replay 验证。

Backup 包含真实项目内容与 tool arguments/results，可能敏感，因此导出前有 modal warning；不包含 Provider transcript、browser profile、Cookies、登录态或 extension secrets。

Restore 只允许空白 Nimora profile：digest/path allowlist 先验，temp-root 真 Store replay 先验，现有 Project/Task 或底层 store 非空即拒绝，不 merge、不覆盖活动 Project，写入后 reload 由 canonical Store 自己重载。

## 6. 回归与 bundle 证据

本轮实际 PASS：

- `npm run typecheck-shuncode`
- `npm run test-shuncode-nimora-phase13-productization`
- `npm run test-shuncode-mission-user-entry`
- `npm run test-shuncode-mission-autonomy-loop`
- `npm run test-shuncode-worker-assignment-coordinator-e2e`
- `npm run test-shuncode-mission-worker-succession`
- `npm run test-shuncode-nimora-product-shell`
- `npm run test-shuncode-nimora-product-ui-host`
- `npm run test-shuncode-task-runtime`
- `npm run test-shuncode-host-capability-execution`
- `npm run test-shuncode-host-capability-durable`
- `npm run test-shuncode-host-capability-policy`
- `npm run test-shuncode-capability-grants`
- `npm run test-shuncode-mission-worker-input-materialization`
- `npm run test-shuncode-mission-skill-materialization`
- `npm run test-shuncode-nimora-phase13-productization` 的新增 Stable 反例：symlink/junction escape、multi-root ambiguity、BaseContainer/BFS allow、DACL reject
- TerminalSandboxService focused Electron suite：71 PASS / 2 upstream pending；exact roots / network deny 单测 PASS。新增 DACL test 已写入 source；当前仓库全量 client compile 被既有 AgentHost/BYOK test type drift 阻断，旧 `out` runner 尚未执行到这条新增 test，因此不把它冒称为独立 Electron PASS
- `npm run typecheck-client` 的 changed-file 过滤结果：本轮 `sandboxHelper* / terminalSandboxService` **0 error**；命令整体仍因无关的既有 AgentHost/BYOK 测试错误返回 1
- `npm run test-shuncode-strict-sandbox-live`：**HOST_PREREQUISITE_BLOCKED（预期 fail-closed）**，当前主机仅有 `appcontainer-dacl`，没有 Stable 可接受 isolation tier

并实际执行 `$env:SHUNCODE_BUILD_INCREMENTAL=1; npm run compile-shuncode`：production Gateway 13 trusted assets staging、`agent-host.js`、`mcp-server.js`、`extension.js` 均重新 bundle PASS。

### 6.1 2026-10-05 fresh DeepSeek external-provider acceptance

最终 fresh acceptance 使用独立发行目录 `VSCode-win32-x64-phase13-r11-20261005`、独立 profile `.build/nimora-phase13-acceptance-r11-20261005` 与独立 workspace `R11-Fresh`。启动前 canonical Nimora storage 为 0；Workspace Trust 与登录态来自独立复制 profile，但 Project/Task/Collaboration 真值与旧日志均清空，未复用历史 Project/Input/Work Order。

真实 Project `e0cd539f-708c-4f0a-89ae-ab7663b71333` 成功形成 continuing Cognition root `d06bd37a-8dc7-460e-840c-0d5968c78abb`、Coordinator `1f487fd4-488f-4c1f-b738-3c184bc466a2` 与 Practice child `5824f895-e5d6-4e81-a035-c0442b3a0b72`。Practice exact input `c933830e-b332-429c-9951-4ebb4626ee7f` 仅授权 `RESULT.txt / SEED.txt`，真实执行恰为 `read_files -> apply_patch -> read_files` 三次，三次均 `succeeded + TaskExecutionDelivered`；无 Terminal、无 network、无 UNKNOWN、无 pending delivery。

`SEED.txt` 初始/最终 SHA256 均为 `195596078f2e478e2dc7165358ea0738a2aee33ae2f14b98aa76b5ff6d081222`。真实 `RESULT.txt` 内容严格为两行 `NIMORA_PHASE13_R11_ACCEPTANCE_OK` 与 `seed=NIMORA_PHASE13_R11_ACCEPTANCE_SEED_20261005`，artifact/version SHA256 为 `19f384165687c716b16ff8cfaeb51873b67b6cddf93c0fc2197c40fa8a8cf189`。Practice report 被提升为 durable Evidence `autonomy:evidence:v1:9750b9105ad30d006cae36bff38f758f535de1a84527619b470ba23e1faba618`，随后 Practice Mission 完成 `TaskMissionFinalized -> TaskWorkerRetired -> TaskMissionArchived`，fresh Cognition 再次审阅证据并判定满足 completion criteria、无 unresolved Problem。

产品 workspace state `nimora.autonomyOutcome.v1` 对该 Project 明确写入 `state=completion-candidate`，reason 为 `Owning Cognition proposes Project completion; use the canonical completion preflight/finalization path.`。因此 Phase13 fresh external-provider acceptance **CLOSED**。最终 Human Project completion confirmation 仍保持为独立治理边界，未由验收脚本自动点击。

本轮同时将 DeepSeek 写入节流收敛为 extension-host-wide FIFO：默认仍不自动重试；只有 Coordinator `resolve` 回执被 DeepSeek 明确证明为 **before exact user-message admission** 的 rate-limit 时，才允许进入全局 30 秒 cooldown 后对同一 Host result 做最多一次重送。任何 admission 歧义、普通 rate-limit 或第二次失败仍 fail closed，绝不重新执行 Coordinator command / Practice Work Order。专项 `shuncode-deepseek-provider-write-gate-smoke`、Coordinator result boundary、DeepSeek semantic-text smoke 均 PASS。R11 fresh live run 未实际命中 rate-limit，因此该 recovery path 当前状态是 **packaged + regression-covered，not live-hit**，不冒称现场触发验证。

## 7. Closeout 与仍开放的 release gates

本轮工程范围 CLOSED：Human Attention / NOW、普通用户单一 continue-autonomy 主入口、现有 owner 驱动的资源生命周期、first-party Skills、durable per-input canonical file path boundary、path-scoped IDE target admission、terminal cwd hardening、redacted diagnostics、real-store-verified Project backup/restore、focused regression 与 first-party bundle 均完成。

Phase13 portable refresh 于 2026-10-05 已关闭：标准 `vscode-win32-x64` 链使用 `VSCODE_PACKAGE_OUTPUT_SUFFIX=phase13-20261004` 构建到独立兄弟目录 `VSCode-win32-x64-phase13-20261004`，没有清理或覆盖旧 `VSCode-win32-x64`。桌面 core `src -> out-vscode` 实际完成 24 bundles、post-process syntax check PASS、186 resources copy PASS，随后 `package-win32-x64` / `vscode-win32-x64-ci` / `vscode-win32-x64` 全部 exit 0。目录级 portable smoke PASS；source/package `extensions/shuncode/dist/extension.js` SHA256 均为 `f06122d4d7884b53938a4c0f8f3934a06e03189724d6be5e4e246b33c4243510`。Packaged Workbench 可直接检出 `_workbench.prepareStrictTerminalSandboxCommand` 与 Stable DACL-rejection gate，证明本轮不只是替换 extension，而是当前 strict sandbox core 已进入发行目录。

最终归档：`.build/releases/Nimora-Beta-Windows-x64-20261005-Phase13.zip`，`361891441` bytes，SHA256 `586e55524001998ef791b104682f23ce3ed46efda3b5e0942982b56789d4729f`。ZIP 共 5889 entries，包含 `Start-Nimora.cmd` 与 `resources\\app\\node_modules.asar.unpacked\\@vscode\\windows-ca-certs\\build\\Release\\crypt32.node`；归档全量回解到全新 verification 目录后再次运行 `scripts/nimora-portable-smoke.mjs` PASS，packaged Electron Node / Gateway dependencies / first-party native assets / Windows certificate native load / source-checkout isolation 全 PASS，providerAcceptance 保持 `NOT_TESTED`。目录和 ZIP entry 对 Cookies、Login Data、`state.vscdb`、browser-profile、私有 `.env` 扫描均 0 命中。

R11 fresh acceptance 后已生成新的独立 Beta 归档：`.build/releases/Nimora-Beta-Windows-x64-20261005-Phase13-R11.zip`，`361912150` bytes，SHA256 `f132e902851e5ae06d105e296fea02fffa9e3b6be220675fe15bf36f1df8a08c`。ZIP 共 `5889` entries，CRC 全量校验通过，包含 `Start-Nimora.cmd` 与 `crypt32.node`；对 `Cookies / Login Data / state.vscdb / browser-profile / .env` 的 entry 名扫描为 `0` 命中。全量回解到 `.build/phase13-r11-zip-verify-20261005` 后再次执行 `scripts/nimora-portable-smoke.mjs` 为 PASS；回解后的 `extensions/shuncode/dist/extension.js`、`shuncode-webmcp/deepseek-provider-write-gate.js`、`arena-agent-bridge.js`、`extension.js` 均与 R11 发行目录 SHA256 完全一致。该归档取代旧 Phase13 ZIP 作为当前 fresh-provider-accepted Beta 归档；旧 ZIP 保留为历史证据，不覆盖。

仍开放的 release gate：

1. **OS terminal sandbox current-host certification**：源码接入、exact-root policy、network deny、no-unsandbox fallback、DACL tier rejection 已完成；当前机器只有 `appcontainer-dacl`，不满足 Stable tier gate，因此 live certification 仍未通过，unattended Stable 保持关闭。需换到具备 BaseContainer/AppContainer+BFS 的 Windows host，或在明确批准的宿主维护窗口解决 MXC host prerequisites 后重新做真实负向 live smoke；不得为了通过测试自动修改 ACL。

因此 Phase13 工程 closeout 与 fresh external-provider acceptance 均可成立；当前不能自动升级为 Stable release 安全完成的唯一已知 release gate，是在 Stable 可接受 Windows isolation tier 上完成 OS terminal sandbox live certification。
