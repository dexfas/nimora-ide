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

## 8. Gateway federation contract

Gateway 同时：

- 作为 MCP client 连接 `SHUNCODE_MCP_URL`；
- 作为 MCP server 暴露聚合后的 tools；
- 通过 localhost control API 管理 browser/page/personal-edge。

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
