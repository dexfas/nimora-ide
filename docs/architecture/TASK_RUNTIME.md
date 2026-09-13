# Task-Centric Runtime

## 1. 为什么 Task 应成为最高业务对象

当前最顶层体验仍以 Chat session 为中心，但长期任务经常跨：

- 多次聊天；
- 多个模型；
- Web/API/local worker；
- terminal/background process；
- file artifacts；
- browser state；
- review/merge；
- 用户中断和恢复。

如果 Chat 是最高对象，换 Worker 或关闭网页就会丢失业务连续性。

因此目标关系是：

```text
Task
├─ Goal / Constraints
├─ State / Plan
├─ Context
├─ Memory references
├─ Capability Grants
├─ Worker Sessions
├─ Executions
├─ Progress
├─ Artifacts
├─ Checkpoints
└─ Result
```

Chat 只是 Task 的一个 interaction projection。

## 2. Task 基本状态机

```text
draft
→ ready
→ running
↔ waiting_user / waiting_external
→ completed
↘ failed
↘ cancelled
```

复杂 Task 内部可以有 steps/attempts，但不要把每次 tool call 都升级成顶层 Task。

## 3. Task Store

Task Store 是 Nimora-owned Source of Truth，至少持久化：

- task metadata / goal；
- current phase/status；
- worker assignments；
- execution references；
- artifact references；
- progress/todos；
- checkpoints；
- decisions；
- context summary；
- capability grants。

不要把完整巨大模型 transcript 复制到每个 state event；transcript/worker-native history 可以引用外部 session storage。

## 4. Event Model

推荐 append-oriented Task events：

```text
TaskCreated
WorkerAttached
ContextPrepared
CapabilityGranted
WorkerMessage
ExecutionRequested
ExecutionStarted
ExecutionFinished
ArtifactProduced
ProgressUpdated
WorkerDetached
CheckpointCreated
TaskCompleted
```

UI、Chat、Bridge timeline 都可以投影相同事件，而不是各自维护一套活动状态。

### Phase 3 shadow implementation

第一版 Task domain 已在 Extension Host 路径旁路运行，但**尚未成为 UI 唯一 Source of Truth**：

```text
Native Chat sessionResource ─┐
                            ├─ TaskShadowRecorder
Bridge MCP sessionId ───────┘        ↓
                              TaskRuntime
                                  ↓
                         append-only JSONL journal
                                  ↓
                           replay → TaskSnapshot
```

当前持久化对象覆盖 goal、todos、progress、interactions、executions、artifact refs。journal commit 会先 canonicalize 成真实 JSON 表示，再同时用于写盘和内存 projection，保证 live/replay snapshot 语义一致；最后一条 torn/corrupt JSONL 可被忽略而保留此前完整事件。

Phase 4.3 已把 Worker assignment 加入 durable Task state：

```text
TaskWorkerAttached
TaskWorkerDetached
        ↓
TaskSnapshot.workerSessions
```

每条引用保存 `managedSessionId / workerId / adapterSessionId / model / attachedAt / detachedAt`。同一 managed id 不能在 replay/lifecycle 中悄悄变成另一个 Worker 或 provider-native session；已经 detached 的同一身份可以被显式 reattach，用于 WorkerSessionManager 的绑定回滚或恢复。

当前 Bridge execution identity 使用 MCP `sessionId + requestId`。Worker 路径在 Phase 5.3 增加了另一套 Nimora-owned identity：`WorkerSessionManager` 按 managed session + Worker input 内 capability occurrence 生成 execution id，provider/model `callId` 只作为 origin metadata/配对线索，不作为全局主键。Worker-origin execution 结构化保存 `managedSessionId / workerId / inputId / callId`。

Worker capability projection 当前遵循：`capability_call → requested/executing`，`capability_result → succeeded|failed + result prepared(pending)`，显式 delivery ack → delivered；若 terminal 到达但没有 capability result，则写 `unknown/pending`。这已经提供跨 Worker 的 durable execution audit/replay，但仍是 shadow ownership：WebMCP page Core 继续负责真正 dispatch/dedupe/retry，后续 Execution Service 接管必须有明确 ownership handoff。

Phase 5.4.4 额外建立 future execution-owner 的 strict persistence contract。`TaskRuntime.beginExecution()` 等现有 shadow API 继续 fail-open，避免 Task journal 故障破坏 Chat/Bridge；Host-owned side effect 必须使用 strict API，journal append 失败即拒绝 claim/finish/result/delivery 状态推进。`TaskExecutionResultPrepared` 现在可保存 bounded `worker-capability` result payload（inputId/callId/name/text/error/duration），使重启后能恢复待投递结果。恢复时 `requested/executing` 或没有匹配 payload 的 finished execution 都是 ambiguous，禁止自动重新执行。

## 5. Context Engine

Context Engine 属于 Task Runtime，负责：

- task goal/constraints；
- relevant files/artifacts；
- conversation evidence；
- durable memory references；
- worker-specific context format；
- compression/summarization；
- context budget；
- stale-context invalidation；
- handoff packages。

### Context Budget

预算至少区分：

- task instructions；
- history/decisions；
- workspace evidence；
- tool schemas；
- skills；
- model output reserve。

Capability Router 与 Skill Router 根据预算动态决定暴露内容。

### Phase 4.4 durable context / handoff

Task Snapshot 现在正式包含：

```text
context.summary
context.constraints[]
context.decisions[]
context.relevantFiles[]
context.updatedAt
```

`TaskRuntime.updateContext()` 会在 journal 边界做 trim、去重、单项字符限制和最大条目限制，避免“长期记忆”本身无限增长。`src/context-handoff.ts` 再从 Task Snapshot 选取 goal、context、todos、progress、artifacts、recent executions 和 Worker history，生成结构化 package 与受 `maxChars` 硬预算约束的文本 projection。

该 handoff 不等于 Memory，也不等于 transcript migration：provider-native 对话历史继续留在原 WorkerSession；handoff 只携带继续完成 Task 所需的最小持久事实。Execution 的 delivery state 会被保留，避免 failover 时把 `pending` 结果误当作 `delivered` 后重新执行副作用操作。

## 6. Memory

Memory 不等于“把所有旧聊天塞进 prompt”。

建议分：

- Task-local memory：当前任务事实/决策；
- Project memory：架构约束、项目规范、已验证事实；
- User preference memory：不应写进公共 repo；
- Worker-native history：某个 provider/session 的原生对话状态。

Project architecture docs / ADR / AGENTS 优先于隐式聊天记忆。

## 7. Progress / Todos

现有 Bridge 的 `set_todos` / `report_progress` 已证明 UI 价值，但 ownership 应移到 Task Runtime：

```text
Task Runtime progress state
    ├─ Native Chat projection
    ├─ Task Center projection
    ├─ external MCP set_todos/report_progress adapter
    └─ notification/status projection
```

外部 Worker 仍可以调用相同 capability，但它不直接“拥有 Bridge todos”。

Phase 3 已开始双写：Bridge 现有 `todos/activities` 仍驱动当前 UI，Task Runtime 同时记录 `TaskTodosUpdated` / `TaskProgressUpdated`。在 consistency 验证完成并建立 Task projection UI 前，不反转 ownership。

## 8. Artifact

Artifact 是 Task 的一等结果引用：

- files/patches；
- diffs；
- terminal commands/logs；
- screenshots；
- documents；
- plans/reports；
- URLs/browser outputs；
- checkpoints。

Artifact contract 让 UI 不需要通过 tool id/name 猜“这是不是文件 diff”。这也是移除 Core `shuncode_` tool renderer 特判的前提。

Phase 3 已为 Bridge `apply_patch` 建立 changeset artifact ref：journal 只保存文件路径、files changed、additions/deletions、diff truncated 等 metadata，不复制完整 patch/diff 内容。

## 9. Execution

Task Runtime 的 Execution Service 与 Capability Layer 协作：

```text
Worker requests capability
→ Router resolves provider
→ Policy decides approval
→ Ledger records requested/approved
→ Provider executes
→ Artifact/result persisted
→ Worker result delivery
→ Ledger marks delivered
```

发生 transport uncertainty 时，按 capability retry metadata 处理，而不是统一 retry。

当前 shadow ledger 已明确拆开：

```text
execution: requested → executing → succeeded / failed / unknown
delivery:  not-prepared → pending → delivered
```

Bridge handler 能证明 tool execution 完成、`CallToolResult` 已准备，因此写到 `pending`；它不能证明远端 Worker 已收到结果，所以当前不会写 `delivered`。此外 shadow ledger 只观察 duplicate execution id，不抑制旧路径的重复执行；at-most-once enforcement 要等 Task Execution Service 正式接管 dispatch。

## 10. Multi-model 映射

当前 Chat branch：

```text
one question
→ branch A
→ branch B
→ merge
→ adopted variant
```

目标 Task 模型：

```text
Task Step
├─ WorkerAttempt A → CandidateResult A
├─ WorkerAttempt B → CandidateResult B
└─ Review/Merge Attempt → Decision/Artifact
```

这样同一机制可用于代码 review、research、planning、视觉任务，而不局限于 Chat turn。

## 11. 与 Core Sessions 的关系

不应另外造一个完全平行 Task Window。

建议：

- `src/vs/sessions` 继续提供 Workbench session/workspace/chat shell；
- Nimora Task Runtime 提供 Task domain；
- `TaskSessionsProvider` 把 Task projection 映射给 Sessions UI；
- Core AgentHost sessions 也可以作为 Task 中一种 WorkerSession/compute environment。

这样既利用 VS Code 成熟 UI，又避免让 Core `ISession` 直接变成 Nimora 全部业务模型。

## 12. Ask / Plan / Code

迁移成 Task Policy Preset：

### Ask
- 默认 read capabilities；
- 更低副作用 grant；
- result 偏解释/回答。

### Plan
- read/search/diagnostics；
- 可启用多 Worker candidates；
- 不默认写入。

### Code
- edit/terminal capabilities；
- explicit approval policy；
- artifacts = patch/files/tests。

底层 Task/Worker/Capability contract 保持一致。
