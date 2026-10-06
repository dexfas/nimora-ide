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

Phase 5.4.8 把 authorization state 也纳入 Task Source of Truth：`TaskSnapshot.capabilityGrants` 保存 durable grant/revoke audit。`grantCapabilityStrict()` / `revokeCapabilityGrantStrict()` fail-closed；session grant 绑定当前 WorkerSession 的 attach generation，Task grant 则只在本 Task 内有效。Resolver 在每次 Host authorization 时读取当前 snapshot，因此 revoke/detach 立即生效。全局 `always` grant 故意不存进 Task journal。

Mission Work Phase 1 又在**同一套 Task journal/replay**上增加了 optional Mission identity，而没有建立第二套 Mission Runtime。旧 `TaskCreated` payload、`TaskSnapshot.version = 1`、`TaskEvent.version = 1` 均保持不变；新事件仅为：

```text
TaskMissionConfigured
        ↓
TaskSnapshot.mission?
  ├─ projectId
  ├─ rootMissionId
  ├─ parentMissionId?
  ├─ plane = coordination | cognition | practice
  ├─ missionType
  └─ completionCriteria[]
```

Mission ID 直接等于现有 `taskId`。配置使用 strict persistence：第一次成功后成为 immutable identity metadata；再次提交相同 canonical metadata 不写新事件，冲突配置拒绝。Root Mission 要求 `taskId === rootMissionId` 且无 parent；Child Mission 要求已配置 root/parent 且二者属于同一 Project/root chain。若 legacy Task 在配置 Mission 前已经有 Worker ref，`TaskMissionConfigured` 会在同一次 strict write 中携带当前 Worker refs 作为 durable adoption，避免早期 fail-open attach 只存在于内存。Mission 配置后的 `TaskWorkerAttached` 本身也改为 strict persistence。legacy journal 启动时不会 bulk migrate，未配置的 Task 始终保持 `mission === undefined`。Project→Mission membership 的唯一 durable link 是 `TaskSnapshot.mission.projectId`，ProjectStore 不保存镜像 `missionIds`。

Mission Work Phase 4 WO#1 又把 `TaskSourceKind` 从 transport-only 的 `native-chat | bridge` additive 扩展为 `native-chat | bridge | mission`。`mission` 只表示由 Nimora-owned Mission semantic operation 创建 Task 的 provider-neutral provenance；`MissionFeedbackService` 用稳定 feedback-operation key 调用既有 `ensureTask()`，因此重启/retry 会复用同一 Task。它不新增 Mission membership、parentage 或 workflow state：membership 仍只来自 `TaskSnapshot.mission.projectId`，`parent_of` 仍由 Mission metadata 派生，跨 Mission feedback provenance 仍由 `MissionCollaborationStore` 的 typed relation/exchange facts 持久化。

Mission Work Phase 2 继续复用同一 Task journal，并加入显式 finalization / retirement，而不是把 `status=completed` 当成隐式推断：

```text
TaskMissionFinalized
  ├─ completedAt
  ├─ handoffRequired
  └─ handoff? (report artifact, atomic with completion)
        ↓
TaskSnapshot.status = completed
TaskSnapshot.missionFinalization = completed

TaskWorkerRetired
  └─ managedSessionId + retiredAt + reason
        ↓
durable logical death of that Worker ref

TaskMissionArchived
        ↓
TaskSnapshot.missionFinalization = archived
```

`finalizeMissionStrict()` / `archiveMissionStrict()` / `retireWorkerSessionStrict()` 都使用 strict persistence。required Handoff 缺失、仍有 running interaction/execution、archive 时仍存在任何没有 `retiredAt` 的 Worker ref，都会拒绝状态推进。Finalized/archived Mission 是不可逆终态：todos/progress/context/artifacts、interaction/execution lifecycle、capability grants 与 Worker attach/detach 等 working-state writes 都拒绝；replay reducer 同样冻结终态后的 late work event，且不会接受 running Mission 的 forged finalization/archive 或重复 retirement 降级。Finalization 的 Handoff policy 也是 terminal identity 的一部分：已经完成的 Mission 若以冲突的 `handoffRequired` 重试会 fail closed。

Final Handoff 不再由 service 先拍 snapshot 再提交。`finalizeMissionStrict()` 接受在 task-exclusive 临界区内执行的 handoff factory，从最终 durable working snapshot 生成 bounded provider-neutral report；artifact metadata 绑定 `missionId/projectId + sourceTaskEventId/sourceTaskEventCount + contentDigest`，artifact id 在同一 Task 内拒绝碰撞。只要 finalization 携带 Handoff，replay 就强制要求 event-level 与 artifact-level 的 source event id/count 全部存在、彼此一致，并精确匹配 Handoff 生成前的 Task revision；不能通过同时省略两层 binding 来绕过校验。Replay 同时会对实际 `metadata.content` 重新计算 SHA-256；缺失/伪造 content、错误 Mission/Project/revision、digest disagreement 都不能建立 finalization。合法的 no-Handoff finalization 不受该 source-binding 要求影响。`TaskMissionFinalized` 也只有在 Mission 已经 `TaskMissionConfigured` 后才是合法 replay transition，非法 Finalized-before-Configured 是 no-op，不能冻结后续合法配置。这样 snapshot 与 `TaskMissionFinalized` 之间不存在可插入的 context mutation，同时 replay 与 live precondition 保持一致。

Worker failure 与 Mission death 分离：普通 `TaskWorkerDetached` 当下不写 `retiredAt`，替代 Worker 可以继续同一 Mission。对于 provider-native identity，durable death 由 replayed Task state 统一派生：只要某个拥有该 `workerId + adapterSessionId` 的 Mission 已 `TaskMissionFinalized`，或对应 Worker ref 已 `TaskWorkerRetired`，该 identity 就已经永久死亡。`MissionFinalizationService` 先在 task-exclusive lane 安装 Mission-level finalization admission fence 并取得封闭的 Worker-history identity snapshot，然后释放 task lock，再按排序后的 provider-native barriers 执行 finalization。这样 snapshot 之后的新 create/attach/rebind/send continuation 会在 Task authority 上 fail closed，即使新 provider identity 不在初始 barrier 集合中也不能越界；同时不会形成 task-lock → provider-lock 的嵌套。若已有 send 先取得 native barrier 和 active-send lease，finalizer 会释放 provider barriers、等待 lease cleanup、再重新取得全部 barriers并重验，而不是持 barrier 等待造成死锁。该已 admission turn 的 host-result continuation 使用单独的 narrow Task check：Manager 必须先证明精确 pending call 与仍存活的 send lease，然后 Task authority 只忽略临时 finalization fence、绝不忽略 durable terminal state；因此 turn 可以完成自身但不能借此开始新工作。若 A 的旧 identity 当前包装在 B，B 的 retirement bookkeeping 写失败不会复活该 identity或阻止 A archive；Manager 记录 cleanup/ownership warning并移除旧 routing，B Mission 本身仍可获得真正新的 Worker。

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

Phase 3 先建立了双写 shadow；Phase 7.1 已把 `set_todos` / `report_progress` 的 ownership 翻转到 Task Runtime。Bridge MCP session 对应的 Task 必须先 durable 创建，随后 `TaskTodosUpdated` / `TaskProgressUpdated` 使用 strict persistence。Phase 7.6 在 Work Sessions 接住 presentation 后进一步删除 `BridgeManager.todos/progress activity` 兼容投影：coordination strict write 成功后只 acknowledge MCP caller，失败则既没有 live Task 更新也没有成功 acknowledgement。普通 Bridge file/IDE execution 仍保持 fail-open shadow，等待后续 execution/artifact 迁移。

Phase 7.2 增加 `task-center-projection.ts` 作为 Task Runtime → product UI 的只读 boundary。它从 snapshot 生成 Task summary/detail 和统一 timeline，并由 extension command `shuncode.taskCenter.getState` 暴露；projection 不携带 `TaskSource.key`，避免把 MCP session id / Chat session key 重新升级成用户概念。

Phase 7.3 开始把这个 boundary 接入原生 Sessions/Agents Window。extension 注册 `nimora-task` / `Nimora Work Sessions`，Task summary 映射为 `ChatSessionItem`，Task detail/todos/workers/timeline 映射为只读 session content；`requestHandler` 为 `undefined`，因此这里没有新的 Chat-owned execution path。`shuncode.taskCenter.open` 直接打开现有 Sessions picker，而不是新增 Webview。

为了让 projection 跟随 Task live state 更新，`TaskRuntimeOptions.onDidChange` 在 event 已应用到 live snapshot 后触发，并传递 cloned snapshot/event。listener 自身异常会被隔离。对 strict owner write，journal persistence 失败会在 apply 之前终止，所以不会更新 live state，也不会发送 change notification；普通 fail-open shadow write 仍允许 persistence failure 后保留内存 projection，并因此发送 invalidation。`TaskShadowRecorder.onDidChangeTask` 将这个通知转发到 extension UI adapter。这个通知是 presentation invalidation signal，不是新的状态 owner。

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
