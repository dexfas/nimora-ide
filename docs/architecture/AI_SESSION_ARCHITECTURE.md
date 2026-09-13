# AI Worker / Session Architecture

## 1. 目标

Nimora 不应该把“模型厂商”或“网页聊天”当作产品核心。ChatGPT Web、DeepSeek Web、API 模型、本地模型和 Core AgentHost provider 都应该被视为可以替换、可以并存、可以失败迁移的 **AI Worker**。

Task 才是业务对象，Worker 是执行 Task 的资源。

## 2. 领域对象

### WorkerDefinition

描述一类可用 AI 能力：

```text
id
provider
kind = web | api | local | agent-host | remote
models
capabilities
cost/latency hints
auth state
availability
```

### WorkerSession

具体的一次可持续交互连接：

```text
sessionId
workerId
model
transport
state
contextHandle
rateLimit
health
currentTaskId?
createdAt / lastActiveAt
```

WorkerDefinition ≠ WorkerSession。一个 ChatGPT worker 可以有多个会话；一个 Task 也可以先后或同时使用多个 WorkerSession。

## 3. 最小 Worker Contract

建议抽象语义，不强迫 transport 相同：

```ts
interface WorkerAdapter {
  describe(): Promise<WorkerDescriptor>;
  createSession(options: WorkerSessionOptions): Promise<WorkerSessionHandle>;
  send(session: WorkerSessionHandle, input: WorkerInput): AsyncIterable<WorkerEvent>;
  interrupt(session: WorkerSessionHandle): Promise<void>;
  resume?(session: WorkerSessionHandle, checkpoint: unknown): Promise<void>;
  dispose(session: WorkerSessionHandle): Promise<void>;
  health(session?: WorkerSessionHandle): Promise<WorkerHealth>;
}
```

`send` 的 event 可以包括：

- text/reasoning delta；
- capability request；
- artifact proposal；
- checkpoint；
- rate-limit/usage；
- terminal state。

### Phase 4.1 当前实现

该 contract 已实际落地在 `src/worker-contract.ts`，不是仅作为文档示意。当前 event union 明确包含：

- `text_delta` / `reasoning_delta`；
- `capability_call` / `capability_result`；
- `artifact_proposal`；
- `checkpoint`；
- `usage`；
- `provider_event`，用于保留不能安全压平的 provider-specific 语义；
- `terminal = completed | interrupted | cancelled | error`。

`WorkerAdapter<TSessionOptions, TInput>` 使用 generics 允许每个 adapter 扩展自己的 typed options，而不是把所有 provider 参数塞进最低公分母。Wire protocol 仍属于 adapter：API Runtime 可以走 JSON-RPC/HTTP，Core 继续走 AHP，Web Worker 继续走 DOM/WebMCP。

## 4. Adapter 不负责什么

Worker Adapter **不应该**拥有：

- Task state；
- global memory；
- capability policy；
- approval；
- tool implementation；
- artifact storage；
- cross-worker merge policy。

这些属于 Task Runtime / Capability Layer。

## 5. API Worker

当前 `src/agent-host.ts` + `openai-agent.ts` 已经证明 API/BYOK Worker 可独立运行。

未来把它拆成：

- API protocol adapters：OpenAI Chat / Responses / Anthropic / Codex；
- model loop runner；
- Runtime transport adapter；
- WorkerAdapter facade。

现有 `ShunCodeLanguageModelProvider` 可继续把这些模型暴露给 VS Code model picker，但不再成为 Worker domain 的唯一 Source of Truth。

Phase 4.1 已新增 `extensions/shuncode/src/api-worker-adapter.ts`：

```text
Worker Contract
      ↓
ApiWorkerAdapter
      ↓
existing RuntimeClient.runAgent()
      ↓
first-party agent-host child / model protocols
```

Adapter 当前把 Runtime trace 映射成 WorkerEvent，并保留 checkpoint resume、interrupt/cancel 和 health。它暂时没有替换 Native Chat 的直接 `RuntimeClient.runAgent()` 调用；这是刻意的 rollback boundary，等 caller parity 映射验证后再切换。

为降低切换风险，Phase 4.1 同时提供临时 `worker-runtime-trace-compat.ts`：Native Chat 可以先继续复用现有 tool card、tool-history 与 workspace reference 投影，再逐步把这些消费者改成直接读取 WorkerEvent。VS Code `toolInvocationToken` 同样只作为 `ApiWorkerInput` 的 host-specific runtime invocation extension 透传，不下沉到跨 provider contract。

## 6. Core AgentHost Worker

Code-OSS `IAgentHostService` / Sessions provider 已经拥有 session/provider/remote/worktree 能力。

不要重写 AHP。增加一个 **AgentHostWorkerAdapter**：

```text
Task Runtime
   ↓ Worker Contract
AgentHostWorkerAdapter
   ↓ IAgentHostService / Sessions provider
Core Agent Host / remote host
```

这样 Core Claude/Codex/Copilot 和未来 remote agent 能与 Web/API worker 进入同一个 Task 体系。

现有协议审计确认无需新增“统一 wire”：AHP `ChatTurnStarted` 本身就是 client-dispatchable send；`ChatTurnCancelled` 是 interrupt；完成、错误、usage、reasoning、tool call/result 已由 chat action/state 表达。`AgentHostWorkerAdapter` 应只做 semantic translation 和 session ownership，不复制 AgentHost/session implementation。

Phase 4.2 已实际新增 `src/agent-host-worker-adapter.ts`。它刻意位于 Nimora-owned source，而不是 `src/vs/platform/agentHost/**`：

```text
Nimora Worker Contract
        ↓
AgentHostWorkerAdapter
        ↓ IAgentConnection
existing AHP subscriptions/actions
        ↓
local IAgentHostService OR remote AgentHost connection
```

Adapter 使用 chat subscription 的 `onDidApplyAction` 作为 streaming event source，因此不会复制 AHP reducer/state ownership。它同时区分 **owned backend session** 与 **attached existing session**：前者在 Worker dispose 时释放 AgentHost session，后者只释放 subscription，避免误杀 Sessions UI 或其他 client 正在使用的持久 session。

当前 descriptor 只声明已经实现的语义。AHP protocol 本身支持更多能力，但 Worker adapter 尚未完成 image input、checkpoint resume 与 per-send `allowedCapabilities` policy mapping，因此这些不会因为“底层理论上支持”就被虚报成 adapter capability。

## 6.1 Worker Session Manager

Phase 4.3 已新增 `src/worker-session-manager.ts`，它是 Worker domain 的 lifecycle/router 层，而不是新的 model runtime：

```text
Task Runtime
    ↕ TaskWorkerAttached / TaskWorkerDetached
WorkerSessionManager
    ├─ ApiWorkerAdapter
    ├─ AgentHostWorkerAdapter
    └─ future WebWorkerAdapter
```

Manager 负责：

- Worker adapter registry / descriptor refresh；
- Nimora-managed session identity；
- provider-native session handle 保存；
- Task bind / unbind；
- send / interrupt / resume / health / dispose routing；
- 按 worker / task / state 查询 session。

`managedSessionId` 与 adapter-native `sessionId` 明确分离。前者属于 Nimora Task domain，后者属于具体 provider/transport。这样两个不同 provider 即使恰好使用相同 native session id，也不会产生碰撞。

Manager 不拥有 transcript、Task goal、capability policy 或 context packing。它只持有 active lifecycle state；Task binding 的 durable Source of Truth 是 Task Runtime journal。Task Snapshot 现在会保存 worker id、managed session id、adapter session id、model、attached/detached timestamp。

运行中的 WorkerSession 不允许 rebind/unbind。这个限制不是 UI 偏好，而是 ownership invariant：一次 turn 尚未结束时，不能把同一执行 session 从 Task A 静默改挂到 Task B。

## 7. Web Worker / WebMCP

### 正式 Adapter Layer

WebMCP 应建立明确分层：

```text
WebWorkerAdapter
├─ DeepSeekAdapter
├─ ClaudeWebAdapter
├─ GeminiWebAdapter
├─ ArenaAdapter
└─ GenericChatAdapter
```

Site Adapter 只负责网页变化：

- `matches(location)`；
- `detectAuthState()`；
- `findComposer()`；
- `sendUserMessage()`；
- `observeAssistantMessages()`；
- `isStreaming()`；
- `encodeCapabilityRequestInstruction()`；
- `parseCapabilityRequest()`；
- `deliverCapabilityResult()`。

WebMCP Core 负责：

- semantic call/result envelope；
- session lifecycle；
- execution ledger binding；
- dedupe；
- result delivery retry；
- context/tool refresh；
- policy hook。

### 为什么必须 Adapter

DeepSeek E2E 已经证明：

- auth page 能被 generic composer 错判；
- JSON request 在该网页模型上会截断；
- Markdown renderer 的 `textContent` 与 `innerText` 行为不同。

这些都应该被限制在 DeepSeek Adapter，而不是污染 Capability Router/Gateway。

## 8. ChatGPT

如果平台已经支持原生 MCP，默认**不使用 WebMCP**。

```text
ChatGPT
  ↓ native MCP
MCP Exposure Adapter
  ↓
Capability Service
```

WebMCP 只作为无法原生接入时的 fallback，不为了“统一”增加脆弱网页依赖。

## 9. Local Model

本地 Ollama/llama.cpp/vLLM/Qwen 等未来走 API/Local Worker Adapter：

- 模型本身不需要知道 VS Code internals；
- Task Runtime 根据模型 tool/context 能力选择 schema 数量和 prompt；
- 小模型可以只获得高度裁剪的 capabilities/skills。

## 10. Session Manager

Session Manager 属于 Task Runtime 服务层，维护：

- active WorkerSessions；
- health/online/offline；
- provider/model/capability；
- rate-limit/backoff；
- usage/cost metadata；
- context state handle；
- task assignment；
- reconnect/recovery。

它**不在 Gateway**。Gateway 可以提供 Web/browser transport health，但不决定 Worker 调度策略。

## 11. Worker 选择与迁移

Task Runtime 可根据：

- capability requirements；
- user choice；
- model strength；
- local/privacy preference；
- latency/cost；
- rate-limit；
- session health；
- context compatibility；

选择 Worker。

失败迁移不是简单把原聊天全文复制给另一个模型，而是由 Context Engine 构建 **handoff package**：task goal、decisions、artifacts、current state、relevant evidence、pending work、grants。

## 12. 多 Worker 协作

未来支持的模式统一建模为 Task graph，而不是 Chat 特例：

- parallel candidates；
- planner → executor；
- implementer → reviewer；
- debate；
- specialist routing；
- merge/synthesis；
- failover。

当前 multi-model branch/merge 是这一方向的可用原型，应迁移其用户价值而不是复制其 Chat-specific state model。

## 13. Web Session 安全边界

每个 Web WorkerSession 必须绑定：

- exact origin/site adapter；
- page/session identity；
- current tool/capability grants；
- page token/session secret；
- execution ledger；
- auth state；
- no-credential-exfiltration policy。

刷新/重新注入后 token 变化必须重新建立绑定；不能只按 page-agent version 复用。
