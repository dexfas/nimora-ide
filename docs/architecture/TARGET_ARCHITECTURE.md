# Target Architecture

## 1. 结论先行

Nimora 的目标架构选择：

> **Thin Core + Task Runtime + Capability Layer + Nimora Gateway + Worker Adapters**

不是 Deep Core Integration，也不是纯 Extension-first。

Code-OSS / VS Code 继续作为长期 IDE 平台；Core 保留真正需要 Main/Renderer/Workbench/AgentHost 权限的通用 substrate；Nimora 产品业务进入清晰的 Runtime / Gateway / Extension modules。

## 2. 三条候选路线比较

### A. Deep Core Integration

```text
Code-OSS Core
├─ Nimora Task logic
├─ model/provider special cases
├─ Bridge UI
├─ tool presentation
├─ multi-model
└─ Runtime integration
```

**优点**：能力上限高、可深度控制 Workbench、交互一致。
**缺点**：上游升级成本极高；产品 logic 散入 `src/vs`；AI 开发者难判断 owner；测试和发布耦合；任何 Nimora feature 都可能变成 Core patch。

当前 ShunCode 的部分结构就是这条路线的后果。

**不选。**

### B. Pure Extension-first

```text
Stock Code-OSS
└─ Nimora Extension
   ├─ Runtime
   ├─ Gateway
   └─ Tools
```

**优点**：上游升级最简单；模块边界显眼；发布独立。
**缺点**：会丢弃或重造 Core AgentHost/Sessions 已有的 remote/worktree/sandbox/checkpoint/session infrastructure；某些 Workbench/Chat UX 必须退化或通过脆弱 hacks 实现。

纯 Extension-first 对一个普通 AI 扩展是好路线，但对已经拥有并希望利用 AgentHost/Sessions substrate 的 Nimora 是倒退。

**不选。**

### C. Thin Core + Nimora-owned Services

```text
Code-OSS Core
├─ generic AgentHost / AHP / Sessions
├─ product carrier hooks
└─ minimal generic Nimora integration shim

Nimora Extension / Workbench Adapter
   ↓
Nimora Task Runtime
   ├─ Context Engine
   ├─ Worker Manager
   ├─ Capability Router
   ├─ Policy / Execution Ledger
   └─ Task / Artifact Store
   ↓                         ↓
Worker Adapters          Capability Providers
   ↓                         ↓
API / AHP / Web / Local  EH / Runtime / Gateway
                            ↓
                       Nimora Gateway
```

**优点**：保留 VS Code 平台价值；Nimora ownership 清晰；可测试；可逐步迁移；Core patch 可收缩；Web/API/local AI 能统一。
**代价**：需要设计 adapter/contract，迁移期会暂时存在新旧 domain 双轨。

**选择 C。**

## 3. System Architecture

```text
┌────────────────────── User Surfaces ─────────────────────────┐
│ Native Chat │ Task Center/Work Sessions │ Editor │ Settings  │
└──────────────────────────┬───────────────────────────────────┘
                           │
                  Nimora Workbench Adapter
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                     Nimora Task Runtime                      │
│                                                             │
│ Task Store · Event Bus · Context Engine · Worker Manager     │
│ Capability Router · Policy Engine · Execution Ledger         │
│ Artifact Store · Progress/Recovery                           │
└───────────────┬─────────────────────────┬────────────────────┘
                │ Worker Contract         │ Capability Contract
        ┌───────┴─────────┐          ┌────┴────────────────────┐
        │ Worker Adapters │          │ Capability Providers    │
        │                 │          │                         │
        │ API/Local       │          │ Runtime File            │
        │ AgentHost/AHP   │          │ Extension Host IDE      │
        │ WebMCP          │          │ Gateway Browser         │
        │ Remote          │          │ Personal Browser        │
        └───────┬─────────┘          └────┬────────────────────┘
                │                         │
                └────────────┬────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Nimora Gateway │
                    │                 │
                    │ MCP exposure    │
                    │ Web adapters    │
                    │ browser broker  │
                    │ tunnel adapters │
                    └─────────────────┘

Code-OSS Thin Core remains below/around the Workbench surface:
Editor · Terminal · LSP · Chat shell · Sessions · AgentHost/AHP · Remote
```

## 4. Module Architecture

### 4.1 Code-OSS Platform

Owns generic IDE/platform concerns：

- Editor/Workbench/SCM/Terminal/LSP；
- Chat shell；
- Sessions workbench；
- AgentHost/AHP；
- remote infrastructure；
- product carrier bootstrap。

它**不应该知道** DeepSeek WebMCP、Nimora Bridge tunnel、`shuncode_` tool IDs、Task merge policy。

### 4.2 Nimora Workbench Adapter

这是 Thin Core 与 Nimora Runtime 的唯一主要 UI/integration seam，概念上负责：

- Chat input/result projection；
- Sessions ↔ Task projection；
- artifact presentation；
- editor/workspace context acquisition；
- generic model/provider contribution；
- commands/menu/status wiring。

能在 extension 做的全部在 extension；只有当前 API 不足且价值明确时才增加 generic Core hook。

### 4.3 Task Runtime

Nimora 业务核心。Owns：

- Task；
- Context/Memory references；
- Worker sessions；
- Capability selection；
- Execution/Policy；
- Progress；
- Artifacts；
- recovery/checkpoint；
- worker collaboration。

不 owns DOM、VS Code widget、MCP HTTP server、具体 browser automation。

### 4.4 Capability Layer

Owns semantic tool definitions/routing/policy metadata。Implementation 分布在正确进程，不集中为一个超级进程。

### 4.5 Worker Layer

Owns模型/会话通信。API、Core AgentHost、Web AI、本地模型都是 adapter；不 owns Task。

### 4.6 Nimora Gateway

Gateway 是**本地外部连接与浏览器边界**，不是 Task brain。

目标职责：

- MCP exposure adapter；
- web-worker transport host；
- managed browser provider；
- Personal Edge provider broker；
- tunnel providers；
- transport authentication/version/health；
- capability-provider federation transport。

不负责：Task selection、global context、multi-worker strategy。

## 5. Bridge 与 Gateway 最终关系

当前：

```text
WebMCP page
→ WebMCP Extension
→ Gateway
→ Bridge MCP
→ Extension Host Tool Broker
```

这个内部链路有一个可以消除的 MCP hop。

目标：

```text
                     ┌─ Native MCP / ChatGPT
External clients ────┤
                     └─ WebMCP / Web Worker
                              │
                        Nimora Gateway
                              │
                      Capability Service
                              │
                 Capability Provider Registry
```

“Bridge”保留为用户兼容名或 MCP Exposure Adapter，不再是与 Gateway 并行的大型 business service。

外部 MCP 仍然是标准协议；内部无需为了复用而把所有调用再序列化成 MCP。

## 6. Process Architecture（目标）

```text
Electron Main
├─ Renderer / Workbench
├─ Extension Host / Nimora Workbench Adapter + IDE providers
└─ Core Agent Host UtilityProcess  ← 保留

Nimora Runtime process/service
├─ Task Engine
├─ Context / Worker / Capability routing
├─ Stores / Ledger
└─ API/Local Worker runtime

Nimora Gateway process
├─ MCP exposure
├─ WebMCP adapters
├─ Managed browser
├─ Personal Edge broker
└─ tunnel transports
```

第一阶段不要求立即把 Task Runtime 从 Extension Host 完全拆进新 process。先建立 contract，再根据稳定性/资源隔离数据决定最终 deployment。**模块边界先于进程边界。**

## 7. Task Flow

```text
User creates/continues Task
→ Task Runtime resolves state + policy
→ Context Engine selects evidence / memory / skills
→ Worker Manager selects or reuses WorkerSession
→ Capability Router materializes relevant tools only
→ Worker receives task context
→ Worker responds or requests capability
→ Policy approves / asks user
→ Execution Ledger starts execution
→ Capability Provider runs
→ Result + Artifacts persist
→ Result delivered to Worker
→ Worker continues
→ Progress projected to Chat/Task Center
→ Task checkpoint/result persisted
```

## 8. AI Worker Flow

### Native/API/local

```text
Task Runtime → WorkerAdapter → model/runtime
```

### Core AgentHost

```text
Task Runtime → AgentHostWorkerAdapter → IAgentHostService/AHP → provider
```

### Web AI

```text
Task Runtime
→ WebWorkerAdapter
→ Gateway/WebMCP Core
→ Site Adapter
→ AI webpage
→ parsed capability request
→ Task Execution Service
```

网页 DOM 永远不进入 Task domain。

## 9. Tool Flow

```text
Worker
→ Capability request
→ Registry lookup
→ Router scope/filter
→ Policy
→ Ledger
→ Provider
→ Result/Artifact
→ delivery
```

Bridge/MCP/WebMCP 都只是 request/result transport adapters。

## 10. Context Flow

Context Engine 按 Worker 创建 materialized context：

```text
Project Rules
+ Task goal/state
+ relevant decisions
+ selected workspace evidence
+ selected artifact summaries
+ selected memory
+ selected skills
+ compact capability catalog / loaded tool schemas
```

明确不做：

- 把全部 tools 永久塞进 prompt；
- 把所有历史聊天复制给每个 Worker；
- 让 Gateway 维护 project memory；
- 让某个 Web session 成为唯一 Task state。

## 11. Security Boundary

### Trust domains

至少区分：

- local trusted Nimora runtime；
- Extension Host IDE provider；
- Gateway process；
- external native MCP client；
- Web AI page；
- managed browser；
- explicitly-shared personal browser tab；
- public tunnel peer。

### Policy原则

1. capabilities 按 Task/Worker 最小授权；
2. read ≠ write ≠ execute ≠ external side-effect；
3. Web page origin/session 与 grant 绑定；
4. side-effect execution 必须有 ledger；
5. transport failure 不等于 execution failure；
6. credentials 不进入 model context；
7. public endpoint 不依赖 obscurity token 作为唯一安全层；
8. Personal Edge 必须用户明确共享。

## 12. IDE Boundary

长期边界规则：

### 属于 Code-OSS

- IDE shell；
- generic Chat/Sessions surface；
- AgentHost platform substrate；
- editor/LSP/SCM/terminal primitives；
- generic extension/proposed API。

### 属于 Nimora

- Task domain；
- Worker orchestration；
- Context/Memory selection；
- Capability registry/router/policy；
- WebMCP adapters；
- Gateway；
- MCP exposure/tunnel；
- product-specific multi-worker strategy。

### 需要跨界的能力

先尝试 Extension API → Proposed API → generic thin Core hook。禁止直接把 Nimora business object import 进任意 Chat widget。

## 13. UI / UX Target

用户主概念：

- **Chat**：快速交互；
- **Task**：可持续工作；
- **Progress**：正在做什么；
- **Changes / Artifacts**：产出；
- **Workers**：高级用户需要时才展开；
- **Connections**：AI/MCP/Web session/tunnel 配置。

默认 UI 不需要用户理解：

- AHP；
- Agent Host；
- Gateway internal routing；
- WebMCP protocol；
- Bridge transport implementation。

## 14. Agent Panel 最终判断

**不删除底层 Sessions/Agents Window。**

处理：

- 产品层改名/重定位为 Task Center / Work Sessions；
- 复用 session/workspace/chat tabs；
- Task 为主要列表对象；
- Worker sessions 作为 Task detail；
- Bridge activity 进入 Execution timeline；
- connections/tunnel 从 Chat surface 移出。

所以分类是 **Refactor + Reposition**。

## 15. Runtime 最终职责

Runtime 应负责：

- Task domain/state；
- Worker orchestration；
- Context/Memory selection；
- Capability routing；
- execution state/recovery；
- artifacts/progress。

Runtime 不应该负责：

-具体网页 DOM；
- Workbench widget rendering；
- public tunnel process UI；
- every capability implementation。

## 16. Tool Router / Context Router 放哪里

都在 Task Runtime：

- Capability Router：Task needs + policy + worker support → materialized tools；
- Context Engine/Router：Task state + budget + worker characteristics → materialized context。

Gateway 只提供 availability/transport/provider state。

## 17. 完整问题答复

### 1. 当前 Nimora 真正架构是什么？
多层混合：Code-OSS Core AgentHost/Sessions + first-party Extension/Runtime + Tool Layer + Bridge + WebMCP/Gateway/browser providers。

### 2. 最大架构问题？
Ownership 边界不清，尤其两套 Agent runtime、Chat-centric business state、Bridge/Gateway 职责过宽。

### 3. 与 Code-OSS 混合过深？
**产品逻辑部分是；平台 substrate 不应算坏耦合。**

### 4. 哪些 Core Patch 必要？
AgentHost/Sessions、产品 carrier、缺失 API 的最小 generic hooks。Bridge UI/multi-model/product special-cases 不应长期留 Core。

### 5. Extension-first 合适吗？
适合作为默认 feature placement 原则，但不适合作为“清空全部 Core agent infrastructure”的绝对架构。

### 6. Thin Core 更合理？
**是。**

### 7. Agent Panel 继续存在？
底层 Sessions UI 保留，产品重定位为 Task Center；不保留技术概念本身作为卖点。

### 8. Agent Host 当前设计合理？
Core AgentHost 作为 platform substrate 合理；与 first-party runtime 平行而未统一的产品架构不合理。

### 9. Runtime 应负责什么？
Task/Worker/Context/Capability orchestration 与 recovery，不负责所有 UI/transport/provider implementation。

### 10. Tool Layer 应是一等核心？
**是，升级为 Capability Layer。**

### 11. Bridge/Gateway 职责重叠？
**存在。** MCP exposure 与 federation/browser boundary 应统一在模块化 Gateway/transport adapters；Task state 从 Bridge 移走。

### 12. WebMCP 定位？
Web Worker transport/adaptation layer，让无原生 MCP 的网页 AI 成为 Worker。

### 13. Adapter Layer 正式建立？
**是。** Site-specific DOM/protocol compatibility 只存在 Adapter 内。

### 14. 多网页 AI Session 谁管理？
Task Runtime 的 Worker Session Manager；Gateway 只管理 transport/page health。

### 15. Task 是最高业务对象？
**是。**

### 16. Chat 定位？
Task 的交互与 transcript projection，仍然重要但不是 state root。

### 17. Context Router 在哪里？
Task Runtime / Context Engine。

### 18. Tool Router 在哪里？
Task Runtime / Capability Router。

### 19. AI Worker 如何统一？
统一 semantic Worker Contract，transport/provider 用 adapters；不强迫 AHP/MCP/Web 变成同一种 wire protocol。

### 20. 如果今天重新设计 Nimora？
保留 VS Code/AgentHost/Sessions 平台；在其上建立 Nimora Task Runtime 与 Capability Layer；用 Worker adapters 统一 API/AHP/Web/local AI；用 modular Gateway 负责外部连接和 browser/WebMCP；只保留极薄 Core integration。

## 18. 不变量

任何迁移不能破坏以下用户价值：

- native IDE editing/terminal/LSP；
- external native MCP；
- WebMCP；
- Personal Edge；
- public Bridge/tunnel；
- multi-model comparison/merge 的能力；
- Ask/Plan/Code；
- real tool execution；
- execution safety / no blind retry。
