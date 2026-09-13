# Migration Plan

## 1. 迁移原则

目标不是“一次性重写 Nimora”，而是让每个阶段结束后项目仍然能工作、能验证、能回滚。

每个阶段必须遵守：

1. 先建立 contract / shadow state，再切换 owner；
2. 保持现有 Native Chat、Bridge、WebMCP、Personal Edge 可用；
3. 不同时重写 Core、Runtime、Gateway 三个层；
4. side-effect execution 语义不得回退；
5. 迁移旧 state 前先读、后双写、最后切读；
6. 没有自动测试/可重复 smoke 的模块不先大迁移。

## 2. Phase 0 — Architecture Baseline

### 目标

把重建阶段的隐式知识变成仓库事实。

### 工作

- 当前 architecture/process/source/protocol 文档；
- Core patch audit；
- module audit；
- Target Architecture + ADR；
- root AGENTS / AI development rules；
- 修正文档中的旧 WebMCP page-agent 版本等陈旧事实；
- 记录 E2E baseline。

### 风险

只有文档漂移风险，无产品行为变化。

### 验证

现有 runtime/build/syntax smoke 全通过。

### 回滚

纯文档 commit 可直接 revert。

## 3. Phase 1 — Capability Metadata, No Behavior Change

**Status: Completed (2026-09-13)**

### 目标

建立统一 Capability Registry 的 metadata contract，但不改变现有 tool execution route。

### 工作

1. 把 file/IDE/browser tool metadata 映射到统一 definition；✅
2. 补 risk/idempotency/retry/approval/environment tags；✅
3. Bridge/Gateway 先只读 Registry/metadata 生成 tool list 与 retry policy；✅
4. 原 dispatch 继续存在；✅
5. 写 metadata / MCP projection smoke tests。✅

### 实现结果

- 新增 `src/capability-registry.ts`，作为 Runtime/Bridge 核心 capability 的 semantic metadata Source of Truth；
- MCP `tools/list` 保持原名称/schema，同时增加标准 `annotations` 与 `_meta["nimora/capability"]`；
- Gateway browser / Personal Edge tools 使用同一 contract；
- Gateway upstream retry 从当前 hard-coded rule 迁到 metadata；对不携带 metadata 的旧 Bridge 保留 legacy read-only fallback；
- 新增 `npm run test-shuncode-capabilities`；runtime MCP smoke 也验证 metadata 真正穿过 stdio MCP transport。

Phase 1 没有启用 dynamic tool loading、统一 Policy Engine 或 Execution Ledger；这些仍属于后续阶段。

### 为什么先做

Context Router、Policy、Execution Ledger 都依赖统一 capability identity；这是最小、最安全的基础。

### 风险

tool schema 兼容性改变导致 MCP/WebMCP client 失败。

### 测试

- existing 12-tool Bridge list + calls；
- runtime file tools；
- DeepSeek list/read E2E；
- ChatGPT Native MCP；
- schema snapshot diff。

### 回滚

Registry 只做 adapter；可退回旧 arrays/definitions。

## 4. Phase 2 — Split Capability Providers

**Status: Completed (2026-09-13)**

### 目标

拆 `IdeToolBroker` / Gateway monolith，但不改变外部 tool names。

### 工作

- WorkspaceCapabilityProvider；✅
- TerminalCapabilityProvider；✅
- DiagnosticsCapabilityProvider；✅
- LspCapabilityProvider；✅
- TerminalCommandManager 独立 backend；✅
- `IdeToolBroker` 收缩为 provider composition / VS Code LM registration / native-direct invoke facade；✅
- 保留原 tool names、result shape、Native Chat 与 Bridge caller contract。✅

Gateway-managed Browser / Personal Edge 已在 Phase 1 具备 provider-local capability contract；更进一步的 Gateway monolith 模块化仍留给 Phase 6，不在本阶段强行与 Extension Host provider 拆分绑在一起。

### 实现结果

- `src/ide-tool-definitions.ts` 的每个 IDE tool 现在显式声明 `provider` owner；
- 新增 `ide-capability-provider.ts` 作为 Extension Host provider contract；
- `WorkspaceCapabilityProvider`、`DiagnosticsCapabilityProvider`、`LspCapabilityProvider` 已从旧 broker 物理拆出；
- `TerminalCapabilityProvider` 持有 terminal capability 语义与 Chat presentation；成熟 PTY/ConPTY/direct execution 实现机械迁移到 `terminal-command-manager.ts`，没有重写执行协议；
- `IdeToolBroker` 从约 1900 行历史大模块收缩为约百行 facade；
- capability smoke 会验证 IDE tool definitions 的 provider owner 集合，避免新增工具绕过 provider architecture。

### 实机验证

除 typecheck / compile / runtime smoke 外，源码隔离实例在真实 Extension Host 中以当前仓库作为 workspace 启动：

- `SHUNCODE_TERMINAL_SMOKE=1` → `[terminal-smoke] PASS`
- `SHUNCODE_LSP_SMOKE=1` → `[lsp-smoke] PASS`

首次空窗口验证曾得到 `No workspace folder is open.`，随后改为显式打开当前仓库 workspace 后两项均通过。只结束了 `.build/electron/ShunCode.exe` 的源码实例，没有操作安装版 ShunCode。

### 风险

PTY lifecycle、diagnostics/LSP cancellation、browser state 迁移出错。

### 测试

针对每个 provider 独立 unit/integration；所有已有 MCP/WebMCP browser smoke 回归。

### 回滚

Facade 可切回旧 implementation。

## 5. Phase 3 — Task Runtime Shadow Mode

**Status: Completed first shadow integration (2026-09-13)**

### 目标

建立 Task Store/Event/Progress/Artifact/Execution Ledger，但先不成为 UI 唯一 Source of Truth。

### 工作

- Task contract + append-only event store；✅
- execution ledger；✅
- artifact refs；✅
- Bridge `set_todos/report_progress` 双写 Task projection；✅
- Native Chat request shadow-linked to Task；✅
- 不改变现有 Chat history/branch state。✅

### 当前实现

- `src/task-contract.ts` 定义 Task / Interaction / Execution / Artifact / Event contract；
- `src/task-runtime.ts` 以每 Task 一份 JSONL journal 持久化 append-only event，并通过 replay 恢复 snapshot；
- `extensions/shuncode/src/task-shadow.ts` 是 fail-open compatibility recorder：shadow 失败只写日志，不得中断现有 Chat / Bridge / tool execution；
- Native Chat 使用 `request.sessionResource` 作为稳定 source identity；旧 API 才回退到 `sessionId/request.id`；
- Bridge 使用 MCP `sessionId` 映射 Task，并使用 `sessionId + requestId` 形成当前 shadow execution identity；
- Bridge `set_todos` / `report_progress` 继续维护原 UI state，同时双写 Task journal；
- `apply_patch` 成功后记录轻量 changeset artifact metadata，不把完整 diff 复制进 Task journal；
- execution result 与 delivery 独立：handler 返回 `CallToolResult` 后只记录 `TaskExecutionResultPrepared`，在没有远端 transport acknowledgement 前不写 `TaskExecutionDelivered`。

Shadow mode **不会阻止重复 tool execution**。Ledger 会记录 duplicate observation，但旧执行路径仍继续运行；真正 at-most-once enforcement 必须等 Execution Service 成为 Source of Truth 后再开启，避免 Phase 3 改变现有行为。

### 为什么这样做

先证明 Task domain 能覆盖真实行为，再迁移 Chat/Bridge state，避免“大爆炸式模型重构”。

### 风险

双写状态不一致。

### 测试

- event replay；✅
- crash/restart / torn final JSONL line；✅
- live snapshot 与 replay snapshot canonical parity；✅
- concurrent duplicate execution identity serialization；✅
- Bridge task projection vs existing UI state consistency；✅（真实本地 MCP `set_todos/report_progress` E2E）
- execution/result-prepared ledger；✅
- remote result-delivery acknowledgement；⏳ 尚无可观察 ack，因此正确保持 `pending`。

真实 Extension Host 验证使用源码扩展 development path 启动本地 Bridge，并通过 MCP client 执行 `set_todos → report_progress → list_directory`。结果 journal 为 14 events，其中 execution requested/finished/prepared 各 3，todo/progress 各 1，delivered 为 0。endpoint/token 未写入仓库或验证输出。

### 回滚

关闭 shadow Task store，现有 state 不受影响。

## 6. Phase 4 — Worker Contract

**Status: Semantic foundation complete — Phase 4.1–4.5 adapters/session/handoff landed (2026-09-13); real caller cutovers continue in later phases**

### 目标

让 API runtime、Core AgentHost、WebMCP 都可以被 Task Runtime 视为 Worker。

### 工作顺序

1. `ApiWorkerAdapter` 包装现有 first-party Runtime；✅ contract/adapter 已落地，Native Chat 尚未切换 caller
2. `AgentHostWorkerAdapter` 包装现有 IAgentConnection/AHP；✅ semantic adapter 已落地，现有 Sessions/UI caller 尚未切换
3. Worker Session Manager；✅ registry / managed session identity / Task binding 已落地
4. Context handoff package；✅ durable Task context + provider-neutral budgeted handoff 已落地
5. Web Worker adapter 最后接入。✅ semantic adapter/transport boundary 已落地；真实 WebMCP transport 由 Phase 5 实现

### 风险

把最小公分母做得太低，丢失 provider-specific capability。

### 设计要求

统一 semantic contract，允许 adapter expose extensions/capability metadata；不要强迫所有 provider 使用同一种 wire protocol。

Phase 4.1 已将 contract 放在 VS Code 无关的 `src/worker-contract.ts`。当前最小语义包括 Worker descriptor、logical session、streaming `send()`、interrupt/resume/dispose/health，以及 text/reasoning/capability/checkpoint/usage/provider/terminal events。

`ApiWorkerAdapter` 位于第一方 Extension adapter 层，只包装 `RuntimeClient`；它不会拥有 Task state、approval policy 或 artifact storage。第一版 adapter 仍允许 typed session options 携带 API Runtime 的 protocol/model-specific 参数，因此不会为了“统一”丢掉 Codex/Anthropic/Responses 等 provider-specific 能力。

Native Chat caller 切换前的 parity bridge 也已建立：`worker-runtime-trace-compat.ts` 可把 normalized WorkerEvent 临时还原为现有 `RuntimeTraceItem`，保留 tool card/history/workspace-reference 依赖的 call id、arguments、result text/error、duration 与 step。`toolInvocationToken` 属于 VS Code UI host 细节，因此只放在 `ApiWorkerInput.runtimeInvocation`，不进入通用 Worker Contract。

Core 审计同时确认 AHP 已有天然映射点：client `ChatTurnStarted` = send，`ChatTurnCancelled` = interrupt，server `ChatTurnComplete/ChatError/ChatUsage/ChatReasoning/tool-call actions` = WorkerEvent。Phase 4.2 应包装这些语义，不重写 AHP。

Phase 4.2 已将 `AgentHostWorkerAdapter` 放在 Nimora-owned `src/agent-host-worker-adapter.ts`，而不是 `src/vs/platform/agentHost/**`。它依赖 Core 已有 `IAgentConnection` / state subscription contract，因此 local `IAgentHostService` 与 remote AgentHost 都能复用同一个 semantic adapter，同时不扩大 Core Patch。Adapter 使用现有 chat subscription 作为唯一事件源，不创建第二套 AHP state store/轮询器。

当前 AgentHost adapter 已实现 session create/attach ownership、AHP `ChatTurnStarted` send、`ChatTurnCancelled` interrupt、text/reasoning streaming、tool ready/result、usage、terminal/error 与 health 映射。它只在自己创建 backend session 时调用 `disposeSession`；attach 到已有 session 时只释放 subscription。尚未映射 Worker image input、checkpoint resume 和 `allowedCapabilities` policy input，因此 descriptor 明确不宣称这三项已完成。

Phase 4.3 已新增 `src/worker-session-manager.ts`。Manager 为 heterogeneous adapters 提供统一 registry、descriptor refresh、managed session id、send/interrupt/resume/health/dispose routing 和 Task binding。Manager 使用自己的 `managedSessionId`，同时保留 adapter-native `sessionId`，因此两个不同 Worker 即使返回相同 provider-native id 也不会在 Task domain 冲突。

Task Runtime 同步新增 `TaskWorkerAttached` / `TaskWorkerDetached` 事件以及 `TaskSnapshot.workerSessions`。绑定关系进入 append-only journal，重启后可以 replay；同一 managed session id 若突然指向不同 worker/native session 会被拒绝，防止 identity 被静默篡改。运行中的 WorkerSession 也不能被 rebind/unbind 到另一个 Task，避免 Task ownership 在一次正在执行的 turn 中途漂移。

Phase 4.4 已新增 durable `TaskContextUpdated`，Task Snapshot 正式持有 bounded `summary / constraints / decisions / relevantFiles`。`src/context-handoff.ts` 从 Task Source of Truth 生成 provider-neutral handoff package 和文本 projection；它不复制 provider-native transcript，也不把 adapter-native session id 暴露给下一个 Worker。`maxChars` 是 caller 的硬预算，section 被截断时会显式记录 `truncatedSections`，而不是静默撑爆上下文。

handoff 会保留 execution 的 `status / deliveryStatus`，因此一次 tool 已执行但只到 `delivery=pending` 时，切换 Worker 不会把它误解释为“远端已经收到结果”。这为后续真正的 worker switch/failover 提供了最低限度的 at-most-once 语义基础。

Phase 4.5 已新增 `src/web-worker-adapter.ts`。它只定义 Web Worker 的 semantic adapter 与 `WebWorkerTransport` contract：connect/send/interrupt/health/disconnect，以及 assistant/reasoning/capability/usage/status/terminal transport events。DOM selector、composer、page token、DeepSeek line protocol、result-delivery retry 等仍属于 WebMCP Core/Site Adapter，禁止迁入 Worker domain。

Web adapter 对 capability 采用保守声明：transport 未明确声明的 streaming/reasoning/interruption/image/checkpoint 能力不会被虚报。Transport 若在没有 terminal event 的情况下结束，adapter 会产生 error terminal，避免 Task Runtime 把不完整网页 turn 当作成功。

### 测试

- API adapter fake-runtime parity（streaming/reasoning/capability/checkpoint/cancel/health/tool invocation context/legacy trace projection）；✅
- real API model session；⏳ caller 尚未切换
- AgentHost fake-AHP semantic parity（create/attach ownership、streaming/reasoning/tool/usage/cancel/health）；✅
- AgentHost real local/remote provider session；⏳ 现有 Sessions/UI caller 尚未切换
- cancel/resume/health；API cancel/resume/health ✅，AgentHost cancel/health ✅，AgentHost resume ⏳
- WorkerSessionManager registry/routing/Task attach-detach/replay；✅
- Context Handoff package/budget/replay/provider-neutral identity；✅
- WebWorkerAdapter fake-transport semantic parity / capability honesty / terminal guard；✅
- worker switch with same Task context；🟡 handoff package 已就绪，待真实 caller switch/failover integration

### 回滚

Native Chat 仍可直连旧 Runtime 直到 adapter parity 完成。

## 7. Phase 5 — WebMCP Core + Site Adapters

**Status: In progress — Phase 5.1 canonical v25 Core/Site/page-agent extraction + HTTP/binding parity, Phase 5.2 real WebWorkerTransport/WorkerSession binding, and Phase 5.3 Worker capability-event → Task execution projection landed (2026-09-13); execution ownership transfer, dynamic discovery, live DeepSeek release gate and upper orchestrator selection remain**

### 目标

消除 `arena-agent-bridge.js` / `generic-chat-agent.js` 逻辑漂移，让网页变化只进入 site adapter。

### 工作

- 提取 WebMCP semantic core；✅ parser / call-occurrence dedupe / pending-delivery state 已进入 `webmcp-page-core.js`
- DeepSeekAdapter 首先迁移已有 v24 兼容；✅ auth/composer/line protocol prompt/send policy 已进入 Site Adapter，page agent 升级为 v25
- GenericAdapter；✅ generic composer/assistant selection + JSON transport prompt 已进入 Site Adapter
- Arena/Claude/Gemini 后续按真实测试增加；
- page token/session/ledger 与 Gateway WorkerSession 绑定；🟡 page token 继续封装在 WebMCP extension 内，page session 已成为 `WorkerSessionManager` adapter session 并可 attach/detach/replay Task journal；Worker capability call/result/delivery 已 shadow-project 到 Task execution ledger，但 page Core 仍是当前 dispatch/dedupe/delivery-retry owner
- 固定端口改为可配置/动态 discovery；🟡 env override 已落地，dynamic discovery/handshake 待完成
- auth page / streaming / delivery contract tests。🟡 auth/parser/delivery/dedupe + worker plain/tool/interrupt synthetic browser 已覆盖，live provider streaming/release gate 待完成

Phase 5.1 同时让 v25 page agent 支持两种 transport：Integrated Browser 使用 localhost HTTP；Gateway-managed Edge 使用 Playwright binding。Extension 启动 Gateway 时传入 canonical Core/Site/Agent 源码路径，因此正常产品路径不再由 `generic-chat-agent.js` 维护第二份逻辑；legacy generic agent 暂时只作为 standalone Gateway fallback。

Phase 5.2 在同一 v25 page runtime 上增加 `workerSession / workerSend / workerPoll / workerInterrupt` control surface。WebMCP Extension 将其封装为内部 command contract；第一方扩展中的 `WebMcpCommandTransport` 只消费这些 command，不读取 DOM。`WebWorkerAdapter` 已注册进 `WorkerSessionManager`，真实 page session id 作为 adapter-native session identity，managed session 可严格写入现有 TaskRuntime 的 `TaskWorkerAttached/Detached` journal。当前内部 control commands 已能 create/run/health/interrupt/dispose Web worker session，但上层 orchestrator 尚未自动选择/调度 Web worker。

Phase 5.3 在 `WorkerSessionManager.send()` 增加 provider-neutral execution projection。绑定 Task 的 Worker 发出 `capability_call` 时生成 Nimora execution id 并写入 `TaskExecutionRequested/Started`；`capability_result` 推进到 `succeeded|failed + result prepared`；WebMCP 的 `capability_result_delivered` provider event 再推进到 `TaskExecutionDelivered`。如果 turn 终止前没有看到 capability result，execution 以 `unknown + pending` 收口。每条 Worker-origin execution 结构化保存 `managedSessionId / workerId / inputId / callId`，不要求调用方解析 execution id。**这仍是 shadow projection，不代表 Task Execution Service 已接管 WebMCP dispatch/dedupe。**

Phase 5.4.1 已先建立 execution ownership handoff 的语义前提：`capability_call.dispatch` 必须显式为 `observed | host-requested`。现有 API/AgentHost/WebMCP page-local 全部是 `observed`，因此 Manager/Task ledger 只能记录，绝不能重复执行；后续只有 WebMCP host-managed 路径明确发出 `host-requested` 时，Task Execution Service 才有资格接管 dispatch。下一步仍需 capability executor + result-return contract，当前没有启用 host-managed production path。

Phase 5.4.2 已补齐 dormant result-return contract：Worker/Transport 可选 `submitCapabilityResult()`，`WorkerSessionManager` 只允许向当前真实 outstanding 的 `host-requested + callId` 回传结果；早到、晚到、call 名不匹配都会拒绝，adapter 提交失败时 pending request 保留以便只重试结果投递。WebMCP v25 page runtime 新增 `workerResolveCapability()`，同一 `callId + capability` 已确认投递后再次提交不会重复注入。Extension command bridge 已贯通到 page runtime。**现有生产 WebMCP 仍只发 `observed`，所以该通道目前不会触发 Host 执行。**

Phase 5.4.3 新增未接生产 caller 的 `HostCapabilityExecutionCoordinator`。它要求 capability 已注册 metadata 且必须提供 authorizer；同一 execution identity 的并发请求只执行一次，executor 抛错会缓存为 error/ambiguous 结果而不会盲目重跑，result delivery 独立记账并可在失败后安全重试。该 coordinator 当前是内存态实验基础层，**尚不具备进程崩溃后的 durable execution claim/recovery，因此不能成为生产 execution owner**。下一步要先把 claim/result/delivery 状态落进 TaskRuntime，再考虑接真实 `IdeToolBroker` 和 host-requested WebMCP。

Phase 5.4.4 已把 Host execution claim/result/delivery 接到 TaskRuntime 的严格持久化路径。普通 Chat/Bridge shadow journal 仍保持 fail-open；未来 execution owner 使用 `claimExecution / finishExecutionStrict / markResultPreparedStrict / markDeliveredStrict`，任何落盘失败都会 fail-closed。Task execution 现在可持久化 bounded Worker result envelope，用于进程重启后只恢复结果而不重跑 capability。`TaskHostCapabilityExecutionStore` 的恢复规则是：`finished + matching result payload` 可恢复为 executed/delivered；`requested|executing`、finished 但缺 result、identity 不一致都视为 ambiguous/拒绝自动继续。自动 smoke 已覆盖 restart recovery、delivered 去重、strict claim 持久化失败和“执行后 result 落盘失败不得再次执行”。**这提供 crash-safe at-most-once，而不是对任意外部副作用宣称 impossible 的 exactly-once。**

Phase 5.4.5 已把真实 Extension Host `IdeToolBroker` 包装为 `HostCapabilityExecutor`，并把 Coordinator + Task-backed durable store + metadata policy authorizer 组合成 dormant `HostCapabilityExecutionService`。该 service 在第一方 Extension activate 时完成对象图 wiring，但**没有订阅 WorkerEvent、没有自动 dispatch caller**。Broker executor 只处理 `src/ide-tool-definitions.ts` 明确归属 Extension Host 的能力；Runtime/MCP-owned `read_files/search_files/apply_patch` 不会误路由进 Broker。默认 authorizer 只自动放行 `approval=none`，`session/task-grant/always` 没有显式 grant resolver 时 fail-closed，因此 `run_command/send_command_input` 当前不会因 service 存在而获得执行权限。

Phase 5.4.6 已建立**显式实验**的 host-requested end-to-end lane。只有 `WorkerInput.extensions.hostManagedCapabilities === true` 时，WebMCP page agent 才停止 page-local `invokeTool`，记录 pending host capability 并发出 `dispatch=host-requested`；默认输入继续 `observed`。`WorkerSessionManager` 为 host-requested call 分配 Nimora executionId 并附在 event extensions，但不再 shadow-start/finish/deliver 这条 execution；第一方 `_shuncode.worker.web.run` 仅在同一实验 flag 下把该 event 交给 `HostCapabilityExecutionService`，再通过 Manager result sink 回填网页。真实 Edge synthetic smoke 已证明实验 lane 不调用 page-local tool binding；stack smoke 已证明 `page/transport → Manager → strict Task claim → Host service → Broker → result-return → final Worker terminal` 闭环，并且 Host-owned execution 只由 strict owner 写 ledger。**live DeepSeek/default WebMCP 仍未切换 ownership。**

Phase 5.4.7 把 Host execution 从单一 `IdeToolBroker` 提升为 provider-aware `HostCapabilityExecutorRouter`。Extension Host IDE tools 继续走 `IdeToolBrokerHostCapabilityExecutor`；`read_files/find_files/search_files/apply_patch` 复用 canonical `file-tool-registry.ts`，由 `FileToolHostCapabilityExecutor` 执行。Router 要求恰好一个 provider owner，0 owner 或多 owner 都 fail-closed。自动 stack smoke 已把 host-requested 工具改成真实 `read_files`，证明 Runtime/file provider 不会误落到 IdeToolBroker。默认 authorizer 仍生效，因此 `apply_patch` 虽然已有 provider route，但没有显式 session grant 时仍不会执行。

Phase 5.4.8 已把 capability approval grant 纳入 TaskRuntime durable state。`TaskCapabilityGranted/Revoked` 使用 strict persistence；支持 `task` 与 `worker-session` 两种 scope，session grant 同时绑定 `managedSessionId + attachedAt generation`，因此 detach 或同 ID re-attach 都不会复活旧授权。`TaskCapabilityGrantResolver` 按 capability id/version 与 metadata approval 精确解析：`task-grant` 只接受 task scope，`session` 只接受当前 active WorkerSession 的 session scope，`always` 明确 fail-closed 等待独立 trusted global store。第一方 Host execution service 默认使用该 resolver；没有 grant 时不会执行 `run_command/apply_patch`。当前**没有自动 grant，也还没有用户审批 UI**。

Phase 5.4.9 已把 durable grant 接到明确的用户审批 surface。第一方 Extension 使用 `PromptingTaskCapabilityGrantResolver`：只有缺少匹配 task/session grant 时才弹 modal approval；同一 Task/Session/Capability 的并发请求共享一个 pending prompt，批准后必须先 strict 写入 TaskRuntime 才算授权，拒绝/关闭不写 grant。`dispatchHostCapabilityRequest` 把 authorization denial 转成 `isError=true` 的 Worker capability result，使网页 AI 可以继续当前 turn，同时保证 denied request 不 claim execution、不调用 provider executor。Command Palette 新增 `Nimora: Manage AI Permissions`，只允许查看并撤销 active grants，不提供脱离具体 capability request 的“直接授权”入口。`approval=always` 仍 fail-closed。**默认/live WebMCP ownership 仍未切换；下一 gate 是用户已登录 provider 的 opt-in live roundtrip。**

Phase 5.5 已建立 live ownership 的**显式 release gate**，但仍保持默认 page-local。`shuncode.webWorker.hostManagedCapabilities` 是 application-scoped、默认 `false` 的实验设置；`_shuncode.worker.web.run` 不再信任 caller 自带的 ownership flag，而由该设置与 `workspace.isTrusted` 共同决定最终 `hostManagedCapabilities`。设置关闭或 workspace 未受信任时都强制 `page-local`；只有“设置开启 + trusted workspace”才进入 `host-managed`。`Nimora: Web AI Worker Status & Tool Ownership` 显示当前 ownership、workspace trust、Web Worker session/health，并可显式启用实验模式或一键退回 page-local。这个 release gate **不授予 capability permission**，`session/task-grant` 仍必须经过 Phase 5.4.9 的独立 modal approval。当前 automated/synthetic gate 已通过；**用户已登录 live DeepSeek roundtrip 仍是发布前 gate，未验证前不能把默认值改成 true，也不能删除 page-local ledger。**

### 风险

Web DOM 变化、重复 tool execution、result delivery 丢失。

### 测试

DeepSeek 是 release gate：

```text
web model → request → Nimora tool → result delivery → final model response
```

必须至少覆盖 nested args 和一次 side-effect-safe failure simulation。

当前自动验证已经覆盖：Core JSON/DeepSeek line parser、nested args/heredoc、incomplete-stream guard、bounded JSON repair、dedupe replay、pending-delivery state；真实 Edge synthetic DeepSeek 页面同时覆盖 HTTP 与 binding transport、plain worker completion、tool call/result/delivery 后继续回答、interrupt/cancel 与 repeated-scan no-reexecution；command transport smoke 覆盖 event cursor/terminal/health/disconnect；完整 stack smoke 覆盖 `WebMcpCommandTransport → WebWorkerAdapter → WorkerSessionManager → TaskRuntime` 的 attach/detach、`succeeded/delivered`、`succeeded/pending`、`unknown/pending` execution projection 与 restart replay；真实 Gateway process + managed Edge 验证 canonical v25 source 通过 binding transport 注入；隔离源码 Extension Host 已实际加载第一方 Web Worker 注册与 0.4.12 WebMCP control bridge。**这些 synthetic/integration smoke 不等于 live DeepSeek service release gate**。

### 回滚

保留 legacy page agent feature flag 一个迁移周期。

## 8. Phase 6 — Gateway Modularization / Bridge Reposition

### 目标

把 Bridge 从 business service 收缩成 MCP exposure/tunnel adapter，Gateway 成为 modular local edge。

### 工作

- Gateway internal provider interfaces；
- MCP Exposure Adapter；
- TunnelProvider Cloudflare/ngrok；
- Capability Service direct local route；
- WebMCP 不再内部绕 Gateway → Bridge MCP → EH；
- external native MCP 仍使用标准 MCP endpoint；
- Bridge compatibility commands/status 映射新 service。

### Phase 6.1 实现结果

- 新增 `tools/webmcp-gateway/provider-registry.mjs`，定义 ordered Gateway Provider contract：`id / listTools / owns / callTool / fallback`；
- Gateway 当前注册 `upstream-mcp`、`integrated-browser`、`managed-browser`、`personal-edge` 四个 provider；
- tool list 继续保持历史顺序 `upstream → integrated → managed → personal`，避免外部 MCP client 出现无意义排序漂移；
- tool call resolution 改为“本地显式 owner 优先，upstream 仅 fallback”，保持此前行为并显式阻止同名 tool 同时落到 upstream；
- `/mcp`、`/control/*`、WebMCP browser control 与 upstream retry policy 本阶段没有改协议；
- `test-shuncode-gateway-providers` 保护 registry contract，`test-shuncode-gateway-federation` 使用真实 Gateway `/mcp` + fake upstream/integrated provider 验证 list/call federation。

当前仍只是路由模块化；provider implementation 尚未从 `server.mjs` 物理拆出，Bridge reposition 也未开始切换 endpoint owner。

### Phase 6.2 — Integrated Browser Provider Extraction

第一块 provider implementation 已物理拆出：`integrated-browser-provider.mjs` 现在独立拥有 Integrated Browser localhost bridge 的 tool cache、`/tools` refresh、`/invoke` transport 与 MCP result normalization；Gateway composition root 只注入 bridge URL 并注册 provider。`test-shuncode-gateway-providers` 同时验证 cache TTL、强制 refresh、invoke payload 与 binary omission，真实 `test-shuncode-gateway-federation` / shared-agent smoke 继续保护外部行为。这个阶段仍不改 control endpoint，也不改变 Integrated Browser Extension 本身。

### Phase 6.3 — Upstream MCP Provider Extraction

`upstream-mcp-provider.mjs` 现在独立拥有 Gateway → Bridge MCP client：连接/关闭/reset、稳定 listTools cache、4-step list reconnect、tool metadata lookup 与 call retry 都已从 `server.mjs` 移出。安全语义保持不变：`retry=automatic` 可以在 transport failure 后重连并调用一次；`retry=never/verify-before-retry` 的副作用 capability reset transport 后直接报错，不自动重跑；旧 Bridge 没 metadata 时仅历史 read-only allowlist 保留一次 compatibility retry。`test-shuncode-gateway-upstream-provider` 用注入 fake clients 明确保护这三条分支，真实 Gateway federation smoke 继续保护标准 `/mcp` compatibility。

### Phase 6.4 — Managed Browser Provider Extraction

`managed-browser-provider.mjs` 独立拥有 Gateway-managed persistent Edge 的 launch/reuse/close 生命周期、page selection、page metadata 与八个 browser capabilities。原有 `browser_open/pages/click/fill/get_text/dom/evaluate/screenshot` metadata 和 result shape 保持不变；`start/status/open/stop/currentPage/pages/pageInfo` 作为 Gateway 内部 control surface 提供给现有 `/control/*` routes 与 WebMCP page-agent host。`server.mjs` 不再直接 import Playwright `chromium`，也不再持有 `browserContext/browserConnectPromise`。`test-shuncode-gateway-managed-browser-provider` 使用 fake Playwright context 保护 lifecycle/control/tool/metadata；真实 Edge `test-shuncode-webmcp-gateway-shared-agent` 继续验证 page-agent binding transport。

### Phase 6.5 — Personal Edge Provider / Control Broker Extraction

`personal-edge-provider.mjs` 现在独立拥有 shared-tab client state、90 秒 heartbeat freshness、7 个 Personal Edge tool definitions、command queue、pending result timeout、long-poll waiters 与 result settlement。Gateway route 层仍保留 `/control/personal-edge/register|poll|result` 原路径和 payload，但鉴权/active-client/pending-result 校验已由 provider 返回同样的 403/400/409/410 语义。poll HTTP 断开通过 AbortSignal 仅取消当前 waiter，不自动取消已经发出的 tool command。`test-shuncode-gateway-personal-edge-provider` 保护 auth/status/tool/poll/result/timeout/abort；`test-shuncode-gateway-federation` 进一步用真实 Gateway `/mcp` 验证 `personal_edge_read → poll → result → MCP result`。

### Phase 6.6 — WebMCP Page Host Extraction

`webmcp-page-host.mjs` 现在独立拥有 managed Web AI page 的 agent source/session boundary：优先组合 canonical `webmcp-page-core.js + webmcp-site-adapters.js + arena-agent-bridge.js`，缺少 shared source env 时仍读取 `generic-chat-agent.js` compatibility fallback；factory source 只加载一次。每个 Playwright page 只建立一次随机 token + list/invoke binding session，binding 必须校验 token；tool result 经过 binary-safe serialization 后才进入网页。`connect()` 负责当前 page 的 ensure/status/prime/page-info，但不拥有 browser lifecycle。`test-shuncode-gateway-webmcp-page-host` 保护 source cache/composition、fallback、session reuse、token guard、binding payload、serialization、prime；真实 `test-shuncode-webmcp-gateway-shared-agent` 继续保护 canonical v25 binding transport。

### Phase 6.7 — Gateway MCP Exposure Adapter

`mcp-exposure-adapter.mjs` 现在独立拥有 Gateway 本地标准 Streamable HTTP MCP server/session：initialize 创建 session，后续 POST/GET/DELETE 按 `mcp-session-id` 路由，tools/list 与 tools/call 仅回调 Capability federation。原 `/mcp` endpoint、invalid-session 400 response 与 server identity 保持不变。`test-shuncode-gateway-mcp-exposure` 用真实 MCP Client 保护 initialize/session/list/call/invalid-session；`test-shuncode-gateway-federation` 继续保护 adapter 接到真实 Gateway provider registry 后的端到端行为。

**Bridge 暂不复用这个轻量 adapter。** `bridge-server.ts` 的 public exposure 还包含 bounded EventStore/replay、keepalive/retry、session capacity/idle cleanup、Cloudflare Quick Tunnel 的 JSON-response/SSE 限制、Task shadow execution 与 activity state。把它直接替换为 Gateway adapter 会是能力回退，而不是架构收敛。Phase 6 后续 Bridge reposition 应先迁走 progress/activity/business state，再决定是否抽一个更高层的共享 MCP exposure contract；不以代码复用为目的降级 Bridge reliability。

### 风险

公网 endpoint、MCP session、external clients compatibility。

### 测试

- local MCP client；
- public Quick Tunnel client；
- ChatGPT Native MCP；
- Gateway browser providers；
- no duplicate execution under reconnect。

### 回滚

兼容 endpoint 保持旧 Bridge implementation 可切换。

## 9. Phase 7 — Move Progress / Artifacts / Bridge UI to Task

### 目标

不再让 Chat Core 拥有 Bridge session 特例。

### 工作

- Task Center execution timeline；
- generic artifact/diff/terminal presentation；
- Connections UI 管 Bridge/MCP/tunnel/web sessions；
- remove persistent Bridge mode from Chat；
- `set_todos/report_progress` 直接映射 Task state。

### Phase 7.1 — Task-owned Bridge Coordination

`set_todos` / `report_progress` 已从“Bridge state first + fail-open Task shadow”切为“Task strict owner first + legacy UI projection”。`TaskRuntime` 新增 `setTodosStrict` / `reportProgressStrict`，且 `TaskCreated` 本身也必须先 durable append 成功才进入 live Task map，避免出现只有 coordination event、没有创建事件的不可 replay journal；`TaskShadowRecorder` 提供 fail-closed `getTaskOwned / setTodosOwned / reportProgressOwned`，不会经过 shadow-mode `safe()`。Bridge coordination 输入校验移到纯 `bridge-task-coordination.ts`：todo id/title/status/数量/唯一性/单一 in-progress 与 progress message/percent/todo link contract 保持原语义。

Phase 7.1 当时的执行顺序是：`validate → strict Task append → read returned Task snapshot → project to BridgeManager.todos/progress activity`。如果 journal append 失败，Task live snapshot 不变化，legacy Bridge UI 也不会变化。`report_progress` 的 explicit/implicit todo linkage 从当前 Task 的 todos 解析，不再从 manager-global `this.todos` 解析，因此不同 MCP session 不会拿另一个 session 的 todo 做权限式关联。Phase 7.6 已移除末尾的 legacy coordination projection，见下文。

Phase 7.1 时旧 Bridge status UI 仍是 manager-global presentation surface，只显示最近一次 coordination Task 的投影；这只是当时的兼容层。普通 Bridge file/IDE execution 仍保持 fail-open shadow，本阶段不把所有 Bridge 工具突然变成 TaskRuntime 硬依赖。

`test-shuncode-bridge-task-coordination` 保护 validation、strict write fail-closed 与 restart replay；Phase 7.6 又把源码 contract 更新为 “Task owner write before MCP acknowledgement，并且不再产生 legacy coordination projection”。

### Phase 7.2 — Task Center Read Model

Task Center 的第一步不是重写 Sessions/Agents Window，而是先建立 UI-independent read model。`src/task-center-projection.ts` 现在从 TaskRuntime snapshot 投影：Task 列表/选择、todo/progress counts、WorkerSession 摘要、execution counts，以及按时间排序的 interaction/execution/artifact/current-progress timeline。projection 明确保留 `execution.status` 与 `deliveryStatus` 两个维度，同时不向 UI 暴露 Bridge/Chat 的 raw source session key。

first-party extension 暴露只读 command `shuncode.taskCenter.getState(taskId?)`，它直接读取 `TaskRuntime.listTasks()` 并返回该 projection。现阶段**尚未**宣称 Task Center UI 已完成：旧 Bridge Session View 仍读 `shuncode.bridge.getStatus`，下一小步才是让新的/迁移中的 Work Sessions surface 消费这个 read model。这样可以先固定 product/domain boundary，再迁 UI，而不是继续让 Core 根据 Bridge manager-global state 猜 Task。

`test-shuncode-task-center-projection` 保护 newest-first Task list、explicit selection、todo/worker/execution summaries、execution/result-delivery 分离、timeline 顺序、snapshot immutability、raw source-key 不泄露，以及 extension command wiring。

### Phase 7.3 — Native Work Sessions Projection

Task Center read model 已开始接入现有 Sessions/Agents Window，而不是另造一套 Nimora Webview。first-party extension 通过 proposed `chatSessionsProvider` 注册只读 `nimora-task` session type（显示名 `Nimora Work Sessions`）：每个 Task snapshot 投影成一个 native session item，展示 goal、todo/worker/action/artifact 摘要、状态与 timing；打开后由 `ChatSessionContentProvider` 返回只读 Task detail/timeline。`requestHandler` 明确为 `undefined`，因此 Chat/Sessions 只是 Task 的 presentation surface，不重新获得执行或 durable state ownership。

为让 session list 在 Task 变化后自动更新，`TaskRuntimeOptions.onDidChange` 在 event 已应用到 live snapshot 后收到 cloned snapshot/event；listener 异常只记录日志，不能破坏已经提交的 Task state。对 strict owner writes，persistence 失败会在 apply 之前终止，因此既不改变 live snapshot，也不触发 change notification；普通 fail-open shadow write 仍保持既有语义，即 persistence 失败时可继续更新 live shadow projection 并通知 UI。`TaskShadowRecorder.onDidChangeTask` 只是把该 owner-side invalidation signal 暴露给 extension presentation 层。

命令 `shuncode.taskCenter.open` 复用现有 `workbench.action.chat.history` 入口打开原生 Sessions picker；旧 Bridge Session View 仍保留作为兼容 projection，尚未删除。`test-shuncode-task-center-sessions` 保护 native provider wiring、只读 content、Task-owned presentation、execution/result-delivery 分离和 package/proposal wiring；`test-shuncode-task-runtime` 额外保护 change notification 的 clone、listener fail-open 与 strict-write no-notify contract。

### Phase 7.4 — Bridge → Work Sessions Handoff

旧 Bridge Session View 暂时不能直接删除：它仍承载 rich file/diff/terminal tool cards、Bridge start/stop/health 等尚未迁到 generic Artifact/Connections surface 的能力。但它不应继续看起来像最终 Task Center。因此 Bridge Session footer 与 Bridge 配置/诊断页现在都提供 `Work Sessions` 入口，统一执行 `shuncode.taskCenter.open`；Bridge footer copy 明确说明 Task progress 在 Work Sessions，当前 Bridge view 只是 output-only compatibility/connection surface。

这一步只迁入口与产品语义，不改变 `shuncode.bridge.openSession`、Bridge execution 或 tunnel contract；旧 Bridge Session 入口继续保留，直到 rich artifact/terminal presentation 有替代方案后再切读/删除。`test-shuncode-work-sessions-handoff` 保护两个 compatibility surface 的 handoff wiring，并同时保护旧 Bridge Session 仍可访问。

### Phase 7.5 — Generic Artifact Summary in Work Sessions

Work Sessions 现在开始直接消费 Task Artifact contract，而不是从 Bridge tool id 猜文件结果。`changeset` artifact 的 `metadata.files/additions/deletions/diffTruncated` 会进入通用 Artifact summary；安全的 workspace-relative changed files 还会投影为 native `ChatResponseFileTreePart`，让用户可从 Work Sessions 打开相关文件。带 `uri` 的 artifact 只允许 `http/https`，或经过 workspace containment 校验的 `file:` URI，再投影为 native anchor；`command:` 等 scheme 与 traversal/absolute changed-file metadata 会被忽略。

这还不是 rich diff/terminal migration：Task journal 当前只保存 bounded changeset metadata，不复制完整 diff，Work Sessions 因此不会伪造 patch 内容。旧 Bridge diff/terminal cards 继续保留，直到对应 Artifact contract 与 generic renderer 成熟。`test-shuncode-task-center-sessions` 现在同时保护 artifact path sanitization、file-tree shape、artifact summary 与 native file-tree/anchor wiring。

### Phase 7.6 — Remove Legacy Bridge Coordination Projection

Work Sessions 已经能稳定展示 per-Task todos/progress 后，Bridge 不再把 `set_todos` / `report_progress` 复制到 manager-global `BridgeManager.todos` 或 `BridgeActivity(status=progress)`。当前顺序简化为 `validate → strict Task append → acknowledge MCP call`；`report_progress` 的 todo linkage 仍从当前 Task snapshot 解析。`BridgeStatus.todos` 为兼容旧调用方暂时保留，但恒为空，并标记 deprecated；普通 tool-call activities、Bridge start/stop/health/tunnel 状态完全不变。

因此 coordination presentation 现在只有一条正式路径：`TaskRuntime → task-center-projection → Nimora Work Sessions`。MCP acknowledgement 文案也明确指向 Work Sessions。`test-shuncode-bridge-task-coordination` 继续保护 strict fail-closed/replay/linkage，并新增“没有 manager-global todos/progress activity”的源码 contract。

### Phase 7.7 — Decouple Bridge Startup from Chat Core

`shuncode.bridge.persistentMode` 继续保留用户价值，但不再代表“持久 Bridge Chat 模式”。extension activation 现在在 `bridgeReady + bridgeLicenseReady` 后直接调用 `bridgeAccess.start()`；不会先执行 `workbench.action.chat.open`，也不会等待 Chat view render。`shuncode.bridge.start` 同样只负责启动 Bridge，不再顺带打开/切换 Bridge Session。旧 diagnostics/tool-card surface 仍可通过显式 `shuncode.bridge.openSession` 进入。

对应地，`ChatViewPane` 已删除 `persistentBridgeStartupScheduled`、`schedulePersistentBridgeStartup()` 和对 `shuncode.bridge.persistentMode` 的认知。Bridge settings 中的开关文案改为“后台自动启动，不打开 Chat”。`test-shuncode-bridge-startup-decoupling` 保护 extension-owned startup、start-command 无 Chat side effect、Chat Core 不依赖 Bridge startup config，以及显式 legacy diagnostics 入口仍在。

### 风险

现有用户找不到 Bridge 状态/活动。

### UX 要求

新入口完成并验证后再删旧入口，提供一次迁移提示。

## 10. Phase 8 — Multi-model → Multi-worker

### 目标

保留 branch/merge 用户价值，迁出 Chat-specific branch domain。

### 工作

- Task WorkerAttempt/Candidate/Review schema；
- branch state importer；
- candidate comparison UI；
- merge/review worker；
- Chat projection；
- 切读后删除 Core branch commands/service。

### 风险

旧聊天 branch metadata 兼容。

### 回滚

legacy branch reader 保留，旧数据只读兼容至少一个版本周期。

## 11. Phase 9 — Thin Core Extraction

### 目标

在外部 replacement 已完成后收缩 Core product patches。

优先移除：

1. Bridge Chat mode/UI；
2. `shuncode.branch.*` glue；
3. provider-name special cases；
4. `shuncode_` tool renderer special cases；
5. duplicated model/account UI commands。

保留：

- AgentHost/AHP/Sessions；
- generic APIs/hooks；
- product/NLS carrier；
-确实没有替代方案的薄 integration。

### 成功指标

升级到新 VS Code upstream 时，Nimora-specific merge conflicts 显著集中到少量明确目录/adapter，而不是散布 Chat internals。

## 12. Phase 10 — Context / Skill Dynamic Routing

### 目标

解决规模化后 context 膨胀。

### 前提

Capability Registry、Task Runtime、Worker Contract 必须先稳定。

### 工作

- capability catalog；
- dynamic tool schema loading；
- Skill Registry；
- Context Budget；
- handoff compression；
- retrieval/cache metrics。

不要在 Task/Capability identity 未稳定前先做复杂“智能 Router”。

## 13. 发布门槛

任何阶段宣称完成前至少满足：

- no unexpected tool/schema rename；
- no blind side-effect retry；
- no new direct installed-ShunCode dependency；
- source-of-truth docs updated；
- relevant unit + runtime smoke；
- Bridge/DeepSeek/ChatGPT E2E 按影响范围回归；
- Core patch count/area 不无理由增长。
