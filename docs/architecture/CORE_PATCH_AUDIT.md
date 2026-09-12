# Code-OSS Core Patch Audit

## 1. 审计结论

Nimora 与 Code-OSS 的耦合**确实偏深**，但不能简单得出“Core Patch 都应该移除”的结论。

当前 Core 增量可以分成两类完全不同的东西：

1. **平台级 Agent substrate**：Agent Host、AHP、Sessions、worktree、sandbox、checkpoint、remote/local parity 等。它们本身具有长期价值，而且很多能力天然需要 Workbench/Main/Renderer/UtilityProcess 层权限。
2. **ShunCode 产品逻辑进入通用 Core**：Bridge UI、多模型 branch 状态、ShunCode provider/tool id 特判、产品命令 glue、特殊 Chat rendering。它们不是“必须在 Core 才能实现”的平台能力，长期应迁出或泛化。

因此推荐路线是：

> **Thin Core，不是 No Core。**

## 2. 审计证据与限制

### 已验证的 upstream delta

`src/vs/platform/agentHost` 相对 VS Code 1.132.0 的重建阶段审计：

- changed: 86
- added: 2
- total: 88
- 与安装版 ShunCode source maps: 88 / 88 exact

### 当前显式产品耦合扫描

当前 `src/vs/**` 中至少有 38 个 TypeScript 文件直接包含 `ShunCode` / `shunCode` / `SHUNCODE` 标识，主要集中在：

- NLS / product / dialogs；
- extHost Chat API；
- Workbench Chat actions/service/model；
- branch/merge；
- Bridge management/session UI；
- model management；
- tool rendering；
- chat input/list/widget。

这只是 marker scan，不等于完整 diff；但足以证明“AgentHost 88 files”不是全部产品 Core 增量。

## 3. Category A — Core Agent Host / AHP

**位置：** `src/vs/platform/agentHost/**` 及相关 Main/Workbench wiring。

### 做什么

- 独立 UtilityProcess Agent Host；
- local/remote transport；
- AHP state/action protocol；
- provider lifecycle；
- session/chat/terminal/resources；
- worktree isolation；
- sandbox；
- git/checkpoint/file monitor；
- Claude/Codex/Copilot SDK integration；
- BYOK LM bridge；
- telemetry/OTel；
- remote WebSocket endpoint。

### 为什么历史上存在

它不是为了 Nimora Bridge 临时加的一组 API，而是一整套 platform-level agent execution substrate。安装版 source maps 证明它是真实发行实现，不是开源恢复阶段臆造。

### 普通 Extension API 能否替代

不能等价替代。Extension 可以创建子进程和工具，但很难在不重新造整套平台的前提下获得：

- Workbench/Main 级 lifecycle；
- provider-agnostic Sessions integration；
- remote host parity；
- worktree/sandbox/checkpoint 深度集成；
- shared state/action protocol；
- 多 window direct MessagePort；
- platform filesystem/session services。

### 分类

**Keep / Upstream-first / Minimize Nimora-specific changes**

以后原则：优先跟随 VS Code upstream Sessions/AgentHost 演进；Nimora 不在这里加入具体 WebMCP/Bridge/DeepSeek 业务。

## 4. Category B — Sessions / Agents Window

**位置：** `src/vs/sessions/**`。

### 做什么

- provider encapsulates compute environment；
- session/workspace/chat abstraction；
- local/remote session provider；
- model/mode/permission/isolation/worktree controls；
- chat tabs；
- lead/worker chat；
- quick chat / archive / read state。

### 是否属于 Nimora 产品能力

它是非常接近 Nimora 未来 Task/Worker UI 需求的通用 substrate，而不是应当丢弃的“旧 Agent Panel”。

### 分类

**Keep + Reposition**

未来用户概念可从 “Agents Window” 演化为 Task Center / Work Sessions；底层 provider/session primitives 尽量复用，不重新造一套窗口框架。

## 5. Category C — ExtHost / proposed Chat API shims

**代表位置：**

- `src/vs/workbench/api/common/extHostChatAgents2.ts`
- `extHostTypes.ts`
- `extHostTypeConverters.ts`
- `languageModelToolsService.ts`

### 当前作用

让第一方扩展访问默认 participant、私有 Chat metadata、model provider、tool presentation 等当前公开 API 不足的能力。

### 判断

这类 patch 的必要性要逐项看“公开/proposed API 是否已经覆盖”。如果 Nimora 只是因为缺一个窄能力而修改几十处 Chat Core，应该收缩为小接口。

### 分类

**Keep minimal shim / Reduce**

目标：建立 `NimoraWorkbenchAdapter`（概念名），所有必须的 Core hook 通过少量 typed API/command facade 暴露，禁止业务模块继续直接散入 Chat internals。

## 6. Category D — Multi-model branch / merge in Chat Core

**代表位置：**

- `chatBranchService.ts`
- `chatBranchActions.ts`
- `chatExecuteActions.ts`
- `chatInputPart.ts`
- `chatListRenderer.ts`
- `shunCodeMultiModelWidget.ts`

### 当前作用

把同一轮不同模型回答表示为 Chat request variants，支持：

- branch send；
- prev/next；
- adopt；
- merge summary；
- canonical/active variant；
- branch badges；
- merge model settings。

持久状态又由 extension `BranchStateStore` 管理，并通过 `shuncode.branch.*` command 与 Core 交互。

### 问题

能力有价值，但领域建模错位：

> “多个 AI Worker 的候选结果/评审/合并”被编码成了 Chat renderer 的 branch 特例。

这让 multi-model 与 ChatModel 生命周期紧耦合，也无法自然服务 Web AI worker、后台 Task、非 Chat artifact。

### 分类

**Replace domain + Migrate UI**

未来由 Task Runtime 的 Worker Attempt / Candidate / Review / Merge 表达；Chat 只渲染这些结果。迁移完成前保持现有行为以兼容用户数据。

## 7. Category E — Bridge UI in generic Chat Core

**代表位置：**

- `shunCodeBridgeSessionView.ts`
- `shunCodeBridgeWidget.ts`
- `chatViewPane.ts`
- `chatActions.ts`

### 当前作用

- Bridge start/stop/status/health；
- tunnel/provider/config；
- activity/tool-call timeline；
- todo/progress；
- open file/diff/terminal；
- persistent Bridge mode；
- external-client output-only session。

### 问题

Bridge 是连接能力，不应该成为 Chat View 的特殊运行模式。Core 通过大量 `shuncode.bridge.*` command ID 读取 extension state，是典型 ownership 反转。

### 分类

**Move out of generic Chat Core**

推荐：

-连接与 tunnel 配置 → Connections / Settings；
- external tool execution/progress → Task execution timeline；
- file/diff/terminal actions → generic artifact/execution presentation；
- Chat 不再切换成 “Bridge session”。

## 8. Category F — ShunCode-specific model management in Core

**代表位置：** `chatModelsWidget.ts`、model picker、languageModels。

### 当前表现

Core 直接执行：

- `shuncode.codex.login/logout/relogin/getStatus`
- `shuncode.testApiEndpoint`

以及对 ShunCode provider/model 做产品特判。

### 分类

**Replace with provider metadata / contribution contract**

Core model UI 应只认识 generic provider capabilities：authentication actions、config editor、health/test endpoint、reasoning options。具体 command/provider 名称由 extension/provider contribution 提供。

## 9. Category G — ShunCode-specific tool UI in Core

**代表位置：**

- `chatToolInvocationPart.ts`
- `shunCodeChatToolProgressPart.ts`
- `chatListRenderer.ts`

### 当前表现

通过 `toolId.startsWith('shuncode_')` 和 `shuncode.chat.bridgeStyleUI` 特判视觉；文件 diff、terminal 等 actions 又调用 Bridge command。

### 分类

**Generalize then migrate**

保留“结构化 tool progress / file diff / terminal link”体验，但把判断条件改为 generic presentation metadata/artifact contract，而不是品牌/tool-id prefix。

## 10. Category H — Product/NLS/branding bootstrap

**代表位置：**

- `src/vs/platform/product/common/product.ts`
- `src/vs/base/node/nls.ts`
- `shunCodeLanguagePackBootstrap.ts`
- dialogs product behavior。

### 判断

发行版 branding、application id、data folder、server name 和 first-launch bundled language pack 都属于产品 carrier 层，不能完全由 workspace extension 负责。

### 分类

**Keep minimal product patch**

要求：与 AI Runtime 业务严格分开；以后升级上游时可单独审计。

## 11. Core Patch 决策矩阵

| 类别 | 当前价值 | Extension 可完全替代 | 目标分类 |
| --- | --- | --- | --- |
| AgentHost/AHP | 极高 | 否 | Keep / upstream-first |
| Sessions foundation | 高 | 否/不值得重造 | Keep + Reposition |
| narrow proposed API | 高 | 部分 | Reduce to thin shim |
| Multi-model Chat branch | 高能力/错位置 | 是，需 Task domain | Replace + migrate |
| Bridge Chat UI | 中/错位置 | 是 | Move |
| provider-name model UI | 中/错位置 | 是 | Generalize/remove |
| ShunCode tool renderer | 高 UX/错耦合 | 大部分 | Generalize/remove brand special-case |
| Product/NLS carrier | 必要 | 否 | Keep minimal |

## 12. Core Patch Definition of Done

未来每个新的 `src/vs/**` Nimora patch 必须在 PR/ADR 中回答：

1. 为什么公开 Extension API 做不到？
2. Proposed API 是否足够？
3. 是否可以只加 generic hook，而不加 Nimora product logic？
4. 上游升级冲突面有多大？
5. 对应测试是什么？
6. 如果未来 upstream 提供等价 API，如何删除该 patch？

没有答案时，默认**不进 Core**。
