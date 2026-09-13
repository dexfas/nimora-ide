# Protocols and Contracts

## 1. 原则

当前 Nimora 的协议已经足够多。目标不是再造一个“万能协议”，而是明确每种 contract 的 owner、稳定性和转换边界，避免同一个 Tool Request / Session / Progress 概念被多套私有结构重复表达。

## 2. First-party Runtime RPC

**Client:** `extensions/shuncode/src/runtime-client.ts`
**Server:** `src/agent-host.ts`
**Transport:** line-delimited JSON-RPC 2.0 over child stdin/stdout
**Current protocolVersion:** `8`

主要 Extension → Runtime：

- `runtime/hello`
- `agent/run`
- `agent/cancel`

主要 Runtime → Extension reverse RPC / notifications：

- `ide/tool/invoke`
- `network/fetch`
- `network/fetch/cancel`
- `agent/trace`
- `agent/checkpoint`

优点：简单、可隔离模型 loop、已验证稳定。缺点：接口定义目前散落在两端 TypeScript，而非一个单独 versioned contracts package。

**判断：Keep + Refactor contract ownership。**

## 3. Core Agent Host Protocol (AHP)

**Client:** Renderer `LocalAgentHostServiceClient` / remote clients
**Server:** Core Agent Host UtilityProcess / remote host
**Transport:** MessagePort IPC、remote proxy/WebSocket
**Data plane:** AHP Protocol channel
**Management plane:** separate Management IPC channel

AHP 覆盖：

- root/session/chat/terminal state；
- action envelope；
- subscriptions；
- resource operations；
- changesets；
- MCP notifications；
- provider/session creation；
- remote/local parity。

这是 Code-OSS 平台级 contract，不应为了 Nimora 统一而重写成自有协议。未来 Nimora Runtime 应通过 adapter 使用它。

## 4. File Tools MCP stdio

**Server:** `src/mcp-server.ts`
**Transport:** official MCP `StdioServerTransport`
**Tools:** 四个 canonical file tools。

这是一个很薄的 transport adapter，适合保留。

## 5. Bridge Streamable HTTP MCP

**Server:** `extensions/shuncode/src/bridge-server.ts`
**Clients:** ChatGPT、独立 MCP client、Gateway 等
**Transport:** MCP Streamable HTTP
**Exposure:** localhost 或 Cloudflare/ngrok public tunnel。

它当前把 canonical file tools、IDE tools、`set_todos` / `report_progress` 转换为 MCP tools。

协议本身应该保留；未来 Bridge 不应再是业务状态 owner，而应成为统一 Capability/Tool Service 上的 **MCP transport adapter**。

## 6. WebMCP page protocol

当前 page agent 与本地 WebMCP bridge 使用：

- `GET /webmcp/tools`
- `POST /webmcp/invoke`
- page token header；
- page session id；
- `[SHUNCODE_TOOL]` / `[SHUNCODE_TOOL_RESULT]` 文本 envelope。

### Generic JSON syntax

```text
[SHUNCODE_TOOL]
{"id":"call-id","name":"TOOL_NAME","arguments":{}}
[/SHUNCODE_TOOL]
```

### DeepSeek line syntax

```text
[SHUNCODE_TOOL]
id=call-id
name=read_files
arg.files.0.path=README.md
arg.files.0.start_line=1
[/SHUNCODE_TOOL]
```

多行参数使用 heredoc。

这里必须区分：

- **semantic contract**：tool id/name/arguments/result；
- **site transport syntax**：JSON fence、line protocol、未来其他 adapter syntax。

未来统一的是 semantic contract，不应该强迫所有网页模型使用完全相同的文本语法。

## 7. WebMCP execution ledger semantics

当前 v25 WebMCP Core/page agent 继续执行一条必须保留的 contract：

> Tool execution 和 result delivery 是两个不同事务。

如果工具执行成功但结果回灌网页失败，只允许重试 delivery，禁止盲目重复调用 tool。

当前 Core/page 实现使用：

- call occurrence key；
- `seen`；
- `pendingDeliveries`；
- sessionStorage dedupe；
- bounded delivery retry。

Phase 5 已把 parser/dedupe/pending-delivery bookkeeping 从单体 page agent 抽到 `webmcp-page-core.js`，但它仍属于 page-session 层。Phase 5.3 已把 Worker capability events shadow-project 到 TaskRuntime 的通用 Execution Ledger；这让 durable task state 能观察 request/result/delivery，但还没有把 dispatch ownership 从 page Core 迁走。

Phase 5.2 额外建立 page Worker control contract：page session 具有稳定 `sessionId`；每个 `workerSend(inputId, prompt)` 产生一轮 turn；`workerPoll(inputId)` 返回带单调 `seq` 的 event ledger；`workerInterrupt(inputId)` 只终止该轮生成。Worker event 中 capability call/result 与 assistant text 分离，tool protocol 文本不得冒充普通模型输出。发生 capability call 后，result delivery 完成并出现新的 post-tool assistant revision 之前，turn 不得被标记 completed。

第一方 `WebMcpCommandTransport` 通过 `pageId + pageSessionId` 调用 WebMCP Extension 内部 command，再用 event `seq` 去重轮询结果。这里的 WorkerSession binding **不等于 execution-ledger ownership 已迁移**：page Core 仍负责当前网页 tool at-most-once/delivery retry，Task Execution Service 的统一 ownership 是后续迁移项。

Phase 5.3 的 projection 规则是：Manager 为每个 managed session/input 内观察到的 capability-call occurrence 生成独立 Nimora `executionId`；model/provider `callId` 只作为 origin metadata 和 FIFO 配对线索，不作为全局 execution 主键。`capability_result` 表示执行结果已观察并将 delivery 状态推进到 pending；只有显式的 `capability_result_delivered` provider event 才能记录 delivered。若 terminal 先于 capability result 到达，则 execution 必须记录为 `unknown/pending`，禁止猜测成功。

Phase 5.4.1 开始显式区分 capability dispatch ownership。`WorkerEvent.capability_call.dispatch` 是必填字段：`observed` 表示该 Worker/runtime/page 已经拥有并执行这次调用，Host **禁止再次 dispatch**；`host-requested` 表示 Worker 只提出调用请求，必须由 Nimora host/Execution Service 执行并显式把结果送回 Worker。当前 API Runtime、AgentHost 与 WebMCP page-local 三条生产链全部标记为 `observed`。未来 host-managed WebMCP 只能通过显式切换到 `host-requested` 进入，不允许用“有没有 capability_result”之类启发式猜 ownership。

Phase 5.4.2 建立反向 result-return contract：`WorkerAdapter/WebWorkerTransport.submitCapabilityResult()` 把 Host 执行结果返回原 Worker。`WorkerSessionManager` 维护当前 input 的 outstanding host-requested calls，要求 stable `callId`，并且只在 adapter 确认提交成功后移除 pending；这使 transport failure 可以安全重试**结果回传**而不是工具执行。WebMCP page 的 `workerResolveCapability()` 对已确认投递的 `callId + capability` 幂等，重复调用不会再次写入 `[SHUNCODE_TOOL_RESULT]`。当前该通道是 dormant control surface，因为 WebMCP page-local call 仍声明 `dispatch=observed`。

Phase 5.4.3 的 opt-in Host execution coordinator 进一步把 `execute once` 与 `deliver result` 分成两个状态。execution identity 重用但参数/Worker/call identity 不同会直接报错；同一 identity 并发共享同一个 execution promise；delivery failure 不会清除已经执行的 result。当前实现故意不自动订阅 WorkerEvent，也不接生产 Broker，因为内存态 coordinator 还不能提供 crash-restart at-most-once 保证。

Phase 5.4.4 为 Host execution 增加 Task-backed durable contract。execution claim 必须先严格写入 `TaskExecutionRequested/Started`，成功返回后 caller 才允许启动 executor；执行结束后必须严格写入 `TaskExecutionFinished + TaskExecutionResultPrepared(resultPayload)`，delivery 确认再写 `TaskExecutionDelivered`。进程重启看到 `executing` 时不能推断“没执行”，必须按 ambiguous 处理；只有已经存在 matching durable result payload 时才能跳过 authorization/executor 并恢复 result。这样恢复策略是 conservative at-most-once：不重复副作用优先于自动重试。

Phase 5.4.5 增加 provider/policy boundary。`IdeToolBrokerHostCapabilityExecutor` 仅接受 canonical IDE tool definitions 且要求 capability environment=`extension-host`；其他 provider-owned capability 必须由后续 Router 选择对应 executor。`CapabilityMetadataHostAuthorizer` 直接尊重 registry 的 `approval` 字段：`none` 可继续，其余模式若没有显式 grant resolver 一律拒绝。第一方 Extension 已构造 dormant Host execution service，但当前没有 protocol path 会自动调用它。

Phase 5.4.6 增加 opt-in ownership lane。Page Worker 只有收到 `extensions.hostManagedCapabilities=true` 才把解析到的 tool call 标成 `host-requested`；此时必须有 stable callId，page 把该 call 放入 `pendingHostCapabilities`，不调用自己的 `invokeTool`，也不会在 Host result delivery 前结束 turn。Manager 对 host-owned call 只生成/附加 executionId，不写 shadow execution 状态；Host service 取得该 executionId 后 strict claim/execute/deliver。默认无 flag 的 protocol 仍映射为 `observed`，保持现有 page-local at-most-once/delivery ledger。

Phase 5.4.7 明确 Host execution 的 provider routing contract：`HostCapabilityExecutorRouter` 根据 capability metadata + provider ownership 选择唯一 executor；没有匹配或多个匹配都拒绝执行。当前两条 route 是 Extension Host IDE provider 与 Runtime/file provider。Router 只负责“由谁执行”，approval authorizer 仍先于 executor 生效，所以 provider 可路由不等于 capability 已获授权。

Phase 5.4.8 建立 durable grant protocol。Task journal 新增 `TaskCapabilityGranted` / `TaskCapabilityRevoked`；grant identity 使用 canonical capability id + version，而不是 UI tool name。Session scope 还记录 Worker session 的 attach generation，防止 detached session ID 被复用后继承旧权限。Grant/revoke 都必须 strict append 成功后才改变 live authorization。Task journal 目前只承载 task/session scope；metadata `approval=always` 不会被它满足，必须等待独立全局 trust store。

Phase 5.4.9 增加 approval request/delivery contract。缺 grant 的 `session` / `task-grant` capability 先进入 UI prompt；批准只有在 strict grant append 成功后才返回 authorized。拒绝由 `HostCapabilityAuthorizationError` 表示，并在 Worker dispatch 边界转换成正常的 error capability result，而不是 execution failure：这条路径发生在 durable claim 之前，因此拒绝不会生成 execution ledger，也不会触发 executor。并发相同 scope/capability approval 共享一个 pending prompt，避免多弹窗造成竞态授权。

Phase 5.5 增加 release-gate contract。Web Worker caller 提供的 `extensions.hostManagedCapabilities` 不再拥有最终决定权；第一方 Extension 在发送 turn 前根据 application-scoped `shuncode.webWorker.hostManagedCapabilities` 与 VS Code Workspace Trust 计算 authoritative ownership，并把最终值写回 WorkerInput。未开启设置或 untrusted workspace 都必须产生 `hostManagedCapabilities=false`，从而继续 `dispatch=observed`；只有 trusted + enabled 才允许 page runtime 发 `host-requested`。Release gate 与 approval grant 是正交状态：开启 host-managed 不等于批准任何 capability。

## 8. Gateway federation contract

Gateway 同时：

- 作为 MCP client 连接 `SHUNCODE_MCP_URL`；
- 作为 MCP server 暴露聚合后的 tools；
- 通过 localhost control API 管理 browser/page/personal-edge。

Phase 6.1 起，Gateway federation 由 ordered `GatewayProviderRegistry` 负责。Provider contract 为 `id / listTools / callTool`，可选 `owns()`，并允许一个 compatibility `fallback` provider。当前 provider 顺序是 upstream MCP、Integrated Browser、Managed Browser、Personal Edge；**顺序只决定 tools/list 展示顺序，不决定同名调用归属**。调用解析会先检查所有非 fallback provider 的显式 ownership，再回落 upstream MCP，因此本地同名 capability 不会因为 upstream 也声明同名 tool 而发生重复/错误执行。WebMCP 隐藏 Integrated Browser tool 的过滤仍发生在 provider list projection 层，不改变 provider ownership。

Phase 6.2 起，Integrated Browser provider transport 自身也成为独立模块。它对 `127.0.0.1` bridge 的 `/tools` 使用 2 秒短缓存，health probe 可显式 bypass cache；`/invoke` 返回的 VS Code LM parts 在 provider 边界归一化成 MCP text content，binary data 只保留长度提示而不穿过 Gateway。以上 transport 细节不再属于 Gateway server composition root。

Phase 6.3 起，Gateway → Bridge 的 MCP client 也成为独立 `upstream-mcp` provider。Provider 是 federation 的 fallback owner，并独立持有 MCP session lifecycle 与 reconnect state。Transport failure 时先 reset stale client；只有 canonical metadata `retry=automatic`（或旧 Bridge 的有限只读 compatibility allowlist）才允许自动发起第二次 tool call。副作用 capability 即使 transport 已断开也只 reset connection，不重发 tool request。`/healthz` 的 upstream probe 同样通过 provider，不再绕过其 connection lifecycle。

Phase 6.4 起，Managed Browser 的 Playwright lifecycle 也成为独立 provider protocol boundary。Gateway HTTP control route 不再直接操作 `BrowserContext`；它调用 provider 的 `start/status/open/stop`，WebMCP host 则只通过 `currentPage/pages/pageInfo` 取得当前 managed page。标准 browser tool contract 与 `/control/*` response shape 不变，因此这是 module ownership 迁移，不是外部协议版本升级。

Phase 6.5 起，Personal Edge localhost protocol 的状态机也由独立 provider 持有。`register` 更新 active client/shared tab heartbeat；`poll` 先消费仍有 pending result 的 queued command，否则建立可由 HTTP AbortSignal 取消的 waiter；`result` 只接受当前 active client 且仍 pending 的 command id。HTTP disconnect 只结束 poll waiter，tool command 的 pending result 仍保留到 result 或 command timeout。原有 403 invalid token、400 missing client id、409 inactive client、410 stale result 状态码保持不变。

重要安全语义：只有明确的 read-only upstream tools 可以在 transport failure 后自动 retry；side-effecting tools 不自动 retry，而是要求 caller 核实状态。

这条语义与 WebMCP execution ledger 是同一个更高层问题，未来应统一到 Tool metadata + execution policy。

## 9. Personal Edge localhost protocol

**Browser side:** MV3 background service worker
**Gateway side:** `:48321/control/personal-edge/*`

流程：

1. 用户主动点击扩展选择共享 tab；
2. extension `register` shared state + heartbeat；
3. long poll 获取一个 command；
4. 在当前共享 http/https tab 执行受限 operation；
5. POST result。

允许：`read`、`elements`、`click`、`fill`、`navigate`、`reload`。
不允许任意 JavaScript。

当前 development pairing token 为硬编码 `shuncode-local-development`，仅适合开发，不应作为发布安全模型。

## 10. VS Code command bridge

部分 Core Workbench 与第一方 extension 通过 command id 交互，例如：

- `shuncode.branch.getGroupState`
- `shuncode.branch.adoptVariant`
- `shuncode.branch.setActiveVariant`
- Bridge status/start/stop/open resource 等。

这是当前跨 Core/Extension 边界的隐式 contract。它工作简单，但类型弱、可发现性差。未来 thin Core shim 应把必须存在的交互集中成少量 typed/proposed API 或一个明确 adapter，而不是继续增加 magic command IDs。

## 11. 目标 Contract 集合

未来建议只新增以下 Nimora-owned 稳定 contract：

1. **Task Contract** — task state/events/artifacts/progress。
2. **Worker Contract** — worker/session health/send/interrupt/resume/capabilities。
3. **Capability Contract** — tool/skill metadata、permission、risk、retry/idempotency。
4. **Execution Contract** — call id、execution state、delivery state、approval/audit。
5. **Gateway Provider Contract** — browser/web adapters/tool providers 注册。

外部标准（MCP、AHP）继续作为 transport/platform contract 使用，不复制定义。
