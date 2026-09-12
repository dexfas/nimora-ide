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

### 目标

建立统一 Capability Registry 的 metadata contract，但不改变现有 tool execution route。

### 工作

1. 把 file/IDE/browser tool metadata 映射到统一 definition；
2. 补 risk/idempotency/retry/approval/environment tags；
3. Bridge/Gateway 先只读 Registry 生成 tool list；
4. 原 dispatch 继续存在；
5. 写 schema snapshot tests。

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

### 目标

拆 `IdeToolBroker` / Gateway monolith，但不改变外部 tool names。

### 工作

- WorkspaceCapabilityProvider；
- TerminalCapabilityProvider；
- DiagnosticsCapabilityProvider；
- LspCapabilityProvider；
- ManagedBrowserProvider；
- PersonalBrowserProvider；
- 保留 facade 兼容旧 caller。

### 风险

PTY lifecycle、diagnostics/LSP cancellation、browser state 迁移出错。

### 测试

针对每个 provider 独立 unit/integration；所有已有 MCP/WebMCP browser smoke 回归。

### 回滚

Facade 可切回旧 implementation。

## 5. Phase 3 — Task Runtime Shadow Mode

### 目标

建立 Task Store/Event/Progress/Artifact/Execution Ledger，但先不成为 UI 唯一 Source of Truth。

### 工作

- Task contract + store；
- execution ledger；
- artifact refs；
- Bridge `set_todos/report_progress` 双写 Task projection；
- Native Chat request shadow-linked to Task；
- 不改变现有 Chat history/branch state。

### 为什么这样做

先证明 Task domain 能覆盖真实行为，再迁移 Chat/Bridge state，避免“大爆炸式模型重构”。

### 风险

双写状态不一致。

### 测试

- event replay；
- crash/restart；
- task projection vs existing UI state consistency；
- tool execution at-most-once ledger tests。

### 回滚

关闭 shadow Task store，现有 state 不受影响。

## 6. Phase 4 — Worker Contract

### 目标

让 API runtime、Core AgentHost、WebMCP 都可以被 Task Runtime 视为 Worker。

### 工作顺序

1. `ApiWorkerAdapter` 包装现有 first-party Runtime；
2. `AgentHostWorkerAdapter` 包装现有 IAgentHostService/AHP；
3. Worker Session Manager；
4. Context handoff package；
5. Web Worker adapter 最后接入。

### 风险

把最小公分母做得太低，丢失 provider-specific capability。

### 设计要求

统一 semantic contract，允许 adapter expose extensions/capability metadata；不要强迫所有 provider 使用同一种 wire protocol。

### 测试

- API model session；
- AgentHost local session；
- cancel/resume/health；
- worker switch with same Task context。

### 回滚

Native Chat 仍可直连旧 Runtime 直到 adapter parity 完成。

## 7. Phase 5 — WebMCP Core + Site Adapters

### 目标

消除 `arena-agent-bridge.js` / `generic-chat-agent.js` 逻辑漂移，让网页变化只进入 site adapter。

### 工作

- 提取 WebMCP semantic core；
- DeepSeekAdapter 首先迁移已有 v24 兼容；
- GenericAdapter；
- Arena/Claude/Gemini 后续按真实测试增加；
- page token/session/ledger 与 Gateway WorkerSession 绑定；
- 固定端口改为可配置/动态 discovery；
- auth page / streaming / delivery contract tests。

### 风险

Web DOM 变化、重复 tool execution、result delivery 丢失。

### 测试

DeepSeek 是 release gate：

```text
web model → request → Nimora tool → result delivery → final model response
```

必须至少覆盖 nested args 和一次 side-effect-safe failure simulation。

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
