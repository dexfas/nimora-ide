# AI-first Development Contract

## 1. 目的

未来 Nimora 会大量由新的 AI 会话继续开发。AI 不应依赖“上一段聊天记得什么”，而应依赖仓库事实。

新会话开始任何中大型任务前，先读：

1. root `AGENTS.md`；
2. `docs/architecture/README.md`；
3. 与任务相关的 architecture doc / ADR；
4. 当前源码与 tests；
5. `git status`。

## 2. AI Task Contract

每个中大型任务开始时明确：

```text
Goal
Current facts
Scope
Non-goals
Owned modules
Contracts touched
Risk / side effects
Validation plan
Rollback plan
```

这些可以存在于 issue、task description、todo 或 PR，不要求新增一个文件。

## 3. 工作顺序

```text
Read facts
→ locate Source of Truth
→ identify owner/boundary
→ make smallest coherent change
→ run narrow tests
→ run affected integration tests
→ update docs/contracts if architecture changed
→ review diff for generated/secrets/Core creep
```

## 4. Definition of Done

一个任务只有在以下条件满足时才能称为完成：

- 功能真实实现，不只是生成建议；
- canonical source 被修改，而不是 generated output；
- no unexplained new Core patch；
- contracts/schema changes documented；
- risk/retry/approval semantics preserved；
- relevant tests pass；
- `git diff --check` pass；
- no credentials/tokens/profiles committed；
- architecture/AGENTS/docs 在事实变化时同步；
- user-visible behavior 已说明或验证。

## 5. Validation Matrix

### Source / Tool changes

最少：

```powershell
npm run typecheck-shuncode
npm run compile-shuncode
npm run test-shuncode-capabilities
npm run test-shuncode-task-runtime
npm run test-shuncode-worker-adapter
npm run test-shuncode-agent-host-worker
npm run test-shuncode-worker-session-manager
npm run test-shuncode-runtime
```

如果改动 `TerminalCapabilityProvider` / `TerminalCommandManager` / `LspCapabilityProvider` 或 provider routing，除了上述自动测试，还应在隔离源码实例中打开一个真实 workspace，并按需使用：

```powershell
$env:SHUNCODE_TERMINAL_SMOKE = "1"
$env:SHUNCODE_LSP_SMOKE = "1"
.\scripts\shuncode-dev.bat --new-window .
```

确认 Extension Host output 中对应 smoke 为 `PASS`。只允许结束路径精确属于仓库 `.build/electron/ShunCode.exe` 的源码进程。

### Task Runtime / shadow integration changes

至少运行：

```powershell
npm run test-shuncode-task-runtime
npm run typecheck-shuncode
npm run compile-shuncode
```

`test-shuncode-task-runtime` 必须覆盖 event replay、torn journal recovery、live/replay parity 和 concurrent duplicate execution identity。

### Worker contract / adapter changes

至少运行：

```powershell
npm run test-shuncode-worker-adapter
npm run typecheck-shuncode
npm run compile-shuncode
```

`ApiWorkerAdapter` smoke 当前必须覆盖：normalized streaming/reasoning、capability call/result、checkpoint resume、interrupt/cancel、session state、health、host `toolInvocationToken` passthrough，以及 WorkerEvent → legacy RuntimeTrace parity。Native Chat 仍直连旧 Runtime 时，不能把 fake-runtime adapter smoke 写成“real API model parity 已验证”；切换 caller 后需另补真实 Native Chat/API 回归。

`AgentHostWorkerAdapter` smoke 必须覆盖：AHP session create/attach ownership、`ChatTurnStarted` send、text/reasoning、tool ready/result、usage、`ChatTurnCancelled`、health 与 owned-session cleanup。该 smoke 是 fake-AHP semantic parity，不等于真实 Claude/Codex/Copilot/remote provider E2E。由于 whole-root strict compile 仍有历史 baseline errors，新增 Core-facing adapter 至少要确认 `compile-client` 输出中没有该 adapter 自己的 TypeScript diagnostic；不能把 baseline non-zero 误报为本次回归。

`WorkerSessionManager` smoke 必须覆盖：多 adapter registry、managed/native session id 分离、Task bind/rebind/unbind、running-session ownership guard、send/interrupt/resume/health routing、dispose cleanup，以及 Task journal restart replay。Manager/Task contract 改动同样要确认 `compile-client` 中没有这些新文件自己的 diagnostic。

`Context Handoff` 改动必须运行 `npm run test-shuncode-context-handoff`。至少验证 durable Task context replay、provider-neutral package、provider-native session id 不泄露、execution delivery state 保留、普通预算与极小硬预算、截断 section 显式报告，以及 restart 前后 handoff package/text parity。不要把完整 provider transcript 为了“方便切换”重新塞进 Task journal。

`WebWorkerAdapter` 改动必须运行 `npm run test-shuncode-web-worker-adapter`。Smoke 至少覆盖 transport descriptor/capability 映射、session create/dispose、assistant/reasoning/tool/usage/status/terminal event、allowed capability 透传、interrupt、missing-terminal guard，以及“未声明能力不得虚报”。Fake transport smoke 不能替代真实 WebMCP/DeepSeek roundtrip。

如果改动 Bridge shadow wiring，还要在隔离源码实例中做真实 local MCP roundtrip。由于第一方扩展在普通 source carrier 中仍可能被当作 builtin/Production mode，Bridge local smoke 应显式使用 extension development path：

```powershell
$env:SHUNCODE_BRIDGE_SMOKE_LOCAL = "1"
$devExt = (Resolve-Path "extensions/shuncode").Path
.\scripts\shuncode-dev.bat --new-window --extensionDevelopmentPath "$devExt" .
```

验证 `set_todos → report_progress → read-only tool` 后，Task journal 应出现对应 todo/progress/execution events。没有 transport-level remote acknowledgement 时，`TaskExecutionDelivered` 必须保持缺失；不要为了“测试变绿”伪造 delivered。任何 smoke 输出必须遮蔽 Bridge route token / MCP endpoint。

### WebMCP/Gateway changes

最少：

```powershell
node --check extensions/shuncode-webmcp/arena-agent-bridge.js
node --check extensions/shuncode-webmcp/webmcp-page-core.js
node --check extensions/shuncode-webmcp/webmcp-site-adapters.js
node --check tools/webmcp-gateway/generic-chat-agent.js
node --check tools/webmcp-gateway/server.mjs
npm run test-shuncode-webmcp-core
npm run test-shuncode-webmcp-browser
npm run test-shuncode-webmcp-gateway-shared-agent
npm run test-shuncode-gateway-providers
npm run test-shuncode-gateway-federation
npm run test-shuncode-gateway-upstream-provider
npm run test-shuncode-gateway-managed-browser-provider
npm run test-shuncode-webmcp-command-transport
npm run test-shuncode-web-worker-stack
npm run test-shuncode-host-capability-execution
npm run test-shuncode-host-capability-durable
npm run test-shuncode-host-capability-policy
npm run test-shuncode-capability-grants
npm run test-shuncode-capability-approval
npm run test-shuncode-web-worker-release-gate
```

`test-shuncode-webmcp-core` 必须保护 JSON/DeepSeek line protocol、nested args/heredoc、streaming incomplete-call guard、bounded repair、dedupe persistence/migration 与 pending-delivery bookkeeping。`test-shuncode-webmcp-browser` 使用真实 Edge 和 synthetic DeepSeek DOM 验证 HTTP/binding transport、result delivery、worker plain/tool/host-managed/host-result/interrupt lifecycle、host-managed 不调用 page-local invoke、host-result idempotency 与 repeated-scan no-reexecution；`test-shuncode-webmcp-gateway-shared-agent` 启动真实 Gateway process/managed Edge，确认 Gateway 使用 canonical v25 Core/Site/Agent；`test-shuncode-webmcp-command-transport` 保护 command bridge event cursor/terminal/host-result/interrupt/health/disconnect；`test-shuncode-web-worker-stack` 保护 command transport → adapter → manager → TaskRuntime，并额外验证 opt-in host-requested → strict Host execution service → Broker → result-return → terminal 闭环。以上都是自动 integration baseline，**不能写成 live DeepSeek 服务 E2E**；涉及发布级 DeepSeek 兼容时仍需要用户已登录网页上的真实 roundtrip。

`test-shuncode-gateway-providers` 保护 Gateway Provider Registry 的 ordered listing、local-owner precedence、upstream fallback、filter 与 provider identity contract；它还直接保护 Integrated Browser provider 的 cache TTL、强制 refresh、invoke payload 与 binary result normalization。`test-shuncode-gateway-federation` 必须启动真实 Gateway `/mcp` 并连接 fake upstream MCP + fake Integrated Browser bridge，证明同名 local tool 只执行本地 provider、upstream-only tool 仍正常 fallback。修改 federation/router/provider implementation 时两者都必须运行，不能只做 `node --check`。

`test-shuncode-gateway-upstream-provider` 专门保护 Gateway → Bridge MCP retry safety：listTools transport failure 必须 reset/reconnect；metadata `automatic` tool 可重试一次；metadata side-effect/non-retry tool 即使连接断开也不能重发；旧 Bridge 无 metadata 时只有固定 read-only allowlist 允许兼容 retry。修改 upstream transport、cache 或 retry policy 时该 smoke 是强制项。

`test-shuncode-gateway-managed-browser-provider` 保护 persistent Edge provider 的 lifecycle/control/tool contract：context 复用、start/status/open/stop、八个 browser capability metadata/result、page id guard、screenshot path 都不能因模块拆分漂移。修改 `managed-browser-provider.mjs` 或 Gateway managed-browser control routes 后，除该 smoke 外还必须运行真实 Edge 的 `test-shuncode-webmcp-gateway-shared-agent`。

`test-shuncode-host-capability-execution` 保护未来 host-managed execution 的 execute-once/identity guard/mandatory authorization/result-delivery retry/ambiguous executor failure 语义。这个 smoke 通过不代表 host-managed production dispatch 已启用；在 TaskRuntime durable claim/recovery 完成前，禁止把该 coordinator 直接接到 `run_command` / `apply_patch` 等副作用 capability 的生产自动执行路径。

`test-shuncode-host-capability-durable` 保护 strict Task journal、durable result envelope、进程重启后 result-only recovery、delivered 去重以及 ambiguous crash guard。它证明 Host execution 已具备 crash-safe at-most-once 基础，但仍不等于 WebMCP 已切到 host-managed dispatch；`IdeToolBroker` executor 与 approval/policy wiring 仍必须作为独立迁移阶段验证。

`test-shuncode-host-capability-policy` 保护 metadata approval 的 fail-closed 语义和 Host Capability Router：`approval=none` 可以继续，`session` 等需要显式 grant；IDE capability 必须走 IdeToolBroker，Runtime/file capability 必须走 canonical file provider，0 owner/多 owner 都拒绝。`test-shuncode-web-worker-stack` 还必须证明 host-requested `read_files` 不调用 IdeToolBroker。以上仍不代表 live/default Worker dispatch 已切换。

`test-shuncode-capability-grants` 保护 TaskRuntime strict grant/revoke、restart replay、task/session scope 隔离、session attach-generation binding、detach/re-attach 不复活旧授权、`always` fail-closed 以及 persistence failure 不产生内存授权。任何 approval UI/command 的后续实现都必须调用这些 strict APIs，禁止另建一份 UI-only permission state。

`test-shuncode-web-worker-release-gate` 保护 live ownership 的最后一道软件 gate：manifest 设置必须保持 application scope + default false；caller flag 不能绕过 disabled gate；untrusted workspace 必须强制 page-local；只有 trusted + enabled 才能得到 host-managed。修改 release status/settings 或 Web Worker run command 时必须运行此 smoke。它仍**不能代替**用户已登录 live provider roundtrip。

`test-shuncode-capability-approval` 保护 interactive resolver 的 prompt dedupe、批准后 durable grant、拒绝不落盘、重启后复用 grant 与 `always` 不进入 task/session prompt。`test-shuncode-web-worker-stack` 还保护 denied Host capability 不 claim execution、不调用 Broker、但会通过 dispatch boundary 返回 permission-denied Worker result。权限管理 UI 只能 revoke；禁止新增无需具体 capability request 就能静默 grant 的命令。

修改 page Worker control / command transport / WorkerSession binding 后，还必须运行 `npm run typecheck-shuncode` 与 `npm run compile-shuncode`。真实源码载体验证应确认 Extension Host 同时激活第一方扩展与 `shuncode-integrated-browser-bridge`，隔离 control port 的 `/agent.js` 包含 worker control surface，并在 ShunCode output log 中出现 `Web worker registered: nimora.web-worker via webmcp.integrated-browser`。这只证明真实 Extension Host wiring，不等于 live provider E2E。

源码实例与正式安装版并行时，优先使用 `SHUNCODE_WEBMCP_CONTROL_PORT` / `SHUNCODE_WEBMCP_GATEWAY_PORT` 分配隔离端口；禁止为了抢占默认 48322 去结束 `C:\Program Files\ShunCode` 正式进程。默认端口兼容性与动态 discovery 是两个不同问题。

并根据影响回归：DeepSeek real roundtrip / browser provider / Personal Edge。

### Bridge/MCP changes

回归：

- listTools；
- read-only tool；
- one terminal/tool execution；
- reconnect/no blind retry；
- public tunnel only when transport changes。

### Core changes

除了相关 compile/test，还必须：

- 在 `CORE_PATCH_AUDIT.md`/ADR 说明必要性；
- 检查 upstream alternative；
- 尽可能验证 isolated source desktop；
- 记录升级冲突面。

## 6. Validation Tiers

不要混淆：

1. **Unit/type/build** — 模块内部正确；
2. **Runtime smoke** — 源码 bundle/协议工作；
3. **Integration** — Extension/Bridge/Gateway/Browser；
4. **Real model E2E** — ChatGPT/DeepSeek 等真实 worker；
5. **Release parity** — installer/update/full UI，不是每次开发都自动成立。

`SHUNCODE_SKIP_CORE_TYPECHECK=1` 是重建 dev launcher 的已知策略，不代表“类型检查没意义”，也不允许 AI 随意忽略第一方 typecheck。

## 7. 修改 Core 的准入

AI 想修改 `src/vs/**` 时必须先回答：

- 这是 upstream generic behavior 还是 Nimora product behavior？
- Extension API 是否足够？
- proposed API 是否足够？
- 能否在 Nimora Workbench Adapter 做？
- 如果必须 Core，能否把 hook 做成 generic？
- 哪个测试保护它？
- upstream 新版本有等价实现吗？

无法回答时停止修改 Core，先调查。

## 8. Source of Truth Guard

禁止直接修：

- `extensions/shuncode/dist/**`
- `extensions/shuncode/runtime/**`
- `out/**`
- `.build/**`

除非任务明确是调查生成物；最终 fix 必须回到 canonical source/build pipeline。

## 9. Installed ShunCode Guard

`C:\Program Files\ShunCode` 是 read-only reference。

禁止：

- patch/overwrite/install；
- 写入其配置以配合测试；
- generic `taskkill ShunCode.exe`；
- 读取/输出用户 credential/cookie/token。

源码实例使用 `.build` isolation。

## 10. Tool / Execution Guard

- side-effect tool 在 transport uncertainty 后不得盲重试；
- execution 与 result delivery 分开；
- approval 不能通过改 transport 绕过；
- read-only retry 必须来自 canonical capability metadata；
- browser/web page 不等于可信 runtime；
- Web Worker 不应获得超过 Task 所需的 capabilities。

## 11. 文档规则

当 architecture fact 改变时，更新对应 architecture doc，而不是只更新 README。

ADR 用于：

- 较难逆转的边界决定；
- 新 Core patch；
- protocol/domain 重大变化；
- security model 变化。

不为每个小函数写 ADR。

## 12. 交接规则

新 AI 不应该收到一大段私人聊天历史作为唯一上下文。

标准交接：

```text
Read AGENTS.md.
Read docs/architecture/README.md and relevant ADRs.
Inspect current git status and source.
Continue the current phase in MIGRATION_PLAN.md.
Do not assume documents override current executable facts; reconcile and update docs when facts changed.
```
