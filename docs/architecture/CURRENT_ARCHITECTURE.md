# Current Architecture

## 1. 一句话结论

当前 Nimora 不是单一的“VS Code 扩展”，而是 **Code-OSS Core + Core Agent Host/Sessions + 第一方 ShunCode Extension + 独立轻量 Agent Runtime + MCP Tool Layer + Bridge + WebMCP + Browser Gateway** 叠加形成的系统。

它能工作，而且多条关键链路已经完成真实 E2E；但同一产品中同时存在两套不同层级的 Agent/Session 基础设施，Bridge/Gateway/WebMCP 又各自承担了部分路由、状态和安全职责，因此长期需要重新划清边界。

## 2. 当前主要层次

```text
┌──────────────────────────────────────────────────────────────┐
│ Code-OSS / VS Code 1.132.0                                  │
│ Editor · Workbench · Chat · Sessions · Terminal · LSP · Git │
│                                                              │
│  Core Agent Host / AHP / Sessions                            │
│  + ShunCode-specific Chat / Bridge / Multi-model patches     │
└───────────────────────────┬──────────────────────────────────┘
                            │ VS Code Extension API / proposed API
┌───────────────────────────▼──────────────────────────────────┐
│ extensions/shuncode                                         │
│ Native Chat · Model Provider · RuntimeClient · IDE Providers │
│ BridgeManager · BranchState · Codex auth · commands          │
└───────────────┬──────────────────────┬───────────────────────┘
                │ JSON-RPC JSONL       │ Streamable HTTP MCP
                │ stdio                │
┌───────────────▼──────────────┐  ┌────▼──────────────────────┐
│ root src/agent-host.ts       │  │ Bridge server            │
│ lightweight model/tool loop  │  │ external MCP exposure    │
└──────────────────────────────┘  └──────────┬───────────────┘
                                             │ upstream MCP
                                ┌────────────▼───────────────┐
                                │ tools/webmcp-gateway       │
                                │ tool federation + browsers │
                                └───────┬─────────┬──────────┘
                                        │         │
                          Integrated WebMCP       │ Managed/Personal Edge
                                        │         │
                                Web AI Session    │ Browser capabilities
```

## 3. 两套不同的 Agent Runtime

这是当前架构最容易被误解、也最重要的事实。

### 3.1 Code-OSS Core Agent Host / AHP

主要源码：`src/vs/platform/agentHost/**`、`src/vs/sessions/**`。

它是一个完整的进程级 Agent/Session 基础设施：

- Electron Main 懒启动独立 UtilityProcess；
- Renderer 通过 MessagePort 与 Agent Host 建立连接；
- 状态和请求走 AHP Protocol channel；
- 管理操作走独立 Management channel；
- 支持本地与远端 Agent Host；
- 支持 Copilot、Claude、Codex provider；
- 提供 session/chat/terminal/worktree/checkpoint/git/sandbox/plugin/telemetry 等基础能力；
- `src/vs/sessions` 提供 provider-agnostic session/workspace/chat UI 与管理抽象。

这是**平台级 Agent 运行基础**。

### 3.2 第一方 ShunCode Agent Runtime

源码：`src/agent-host.ts`，构建到 `extensions/shuncode/runtime/agent-host.js`。

由 `extensions/shuncode/src/runtime-client.ts` 从 Extension Host 启动 Node/Electron-Node 子进程，通过 stdin/stdout 的 JSON-RPC JSONL 通信。

它负责：

- OpenAI-compatible / Responses / Anthropic / Codex 模型调用；
- 模型工具循环；
- history、image、reasoning、checkpoint、trace；
- 通过 reverse RPC 请求 Extension Host 执行 IDE tools；
- 通过 Extension Host 网络代理访问模型端点。

当前 `native-chat.ts` 使用的是这一套 Runtime，而**不是** Core `IAgentHostService`。

因此当前产品客观存在两套 Agent 基础设施。它们都具有价值，但职责重叠和产品归属没有被明确建模。

## 4. 第一方扩展

`extensions/shuncode/src/extension.ts` 是当前第一方功能的 composition root。它创建或注册：

- `IdeToolBroker` thin facade + Workspace/Terminal/Diagnostics/LSP capability providers；
- `BridgeManager`；
- Bridge access/license compatibility stack；
- `RuntimeClient`；
- API 与 Codex Language Model Provider；
- `BranchStateStore`；
- `shuncode.agent` Native Chat participant；
- Ask / Plan / Code custom agents；
- Bridge、Codex、模型、多模型相关命令。

当前 Bridge 授权入口显式 `free access enabled` 后直接返回；后面的历史许可代码仍在但不可达。这属于重建兼容/历史遗留，不应该继续被当作目标产品架构。

## 5. Native Chat

`extensions/shuncode/src/native-chat.ts` 既是 VS Code Chat participant adapter，也承担较多业务编排：

- Ask / Plan / Code；
- attachment/image/history；
- 模型选择与运行配置；
- VS Code LM tools → runtime external tools；
- trace/checkpoint/presentation；
- multi-model branch/merge。

因此当前“UI adapter”和“Agent orchestration”混在同一模块。长期应让 Chat 成为 Task/Runtime 的一个交互前端，而不是业务状态的最高层 owner。

## 6. Tool Layer

当前 Tool Layer 已经是 Nimora 最成熟的长期资产之一。

### Capability metadata

`src/capability-registry.ts` 现在提供第一版统一 capability semantic metadata。Runtime/Bridge 核心工具拥有稳定 capability id 与 risk/idempotency/retry/approval/environment 描述；MCP transport 将其投影为标准 tool annotations 与 `nimora/capability` namespaced metadata。Gateway browser providers 使用相同 contract，并以 metadata 决定 transport-level automatic retry 是否允许。

这一步只统一语义，尚未改变现有 provider dispatch，也还没有实现 Task-scoped Capability Router。

### 文件工具

`src/file-tool-registry.ts` 同时定义 schema 和 dispatch：

- `apply_patch`
- `find_files`
- `read_files`
- `search_files`

它被 runtime、stdio MCP、Bridge 复用，是当前较好的 Source of Truth。

### IDE 工具

`src/ide-tool-definitions.ts` 定义逻辑工具 metadata：

- `list_directory`
- `run_command`
- `get_command_output`
- `send_command_input`
- `wait`
- `get_diagnostics`
- `lsp`

`extensions/shuncode/src/ide-tool-broker.ts` 在 Extension Host 内执行真实 IDE/terminal/LSP/diagnostics 操作。它所在进程合理，但一个类承担过多 capability。

这一点已在 Phase 2 改造：`IdeToolBroker` 现在只负责 provider composition、VS Code LM registration 与兼容 invoke facade；Workspace、Diagnostics、LSP 已分别成为独立 provider，Terminal capability 语义与 PTY backend 也已拆开。tool 名称和外部调用 contract 没有变化。

### Bridge-only state tools

Bridge 还增加：

- `set_todos`
- `report_progress`

当前这些状态仍由 Bridge UI state 驱动，但 Phase 3 已通过 `TaskShadowRecorder` 双写独立 Task domain。Task journal 已记录 todos/progress/executions/artifacts；在 shadow consistency 验证完成前，Bridge state 仍是现有 UI Source of Truth，不做大爆炸式切换。

Native Chat 同样已 shadow-link 到 Task：优先使用稳定 `request.sessionResource` 把同一 Chat session 映射到同一 Task，并记录 interaction start/finish；现有 Chat history、checkpoint、branch state 行为没有改变。

## 7. Bridge

`extensions/shuncode/src/bridge-server.ts` 当前在 Extension Host 进程内提供 Streamable HTTP MCP server。

它暴露文件工具、IDE 工具和进度工具，并同时承担：

- MCP session/event-store 生命周期；
- tool dispatch；
- activity/presentation/todo state；
- health；
- Cloudflare Quick / Named Tunnel、ngrok 生命周期；
- endpoint rotation；
- 部分状态给 Workbench UI。

Phase 3 新增的 Task Runtime 不改变以上部署：Task domain 当前也是 Extension bundle 内模块，但领域 contract 位于仓库根 `src/`，不依赖 VS Code API；未来如需进程隔离，可以迁移 deployment 而不重写 Task contract。

“把 Nimora tools 暴露给外部 AI”这一能力必须保留；但当前单文件/单 manager 的职责明显过宽。

## 8. WebMCP 与 Gateway

### WebMCP UI Extension

`extensions/shuncode-webmcp/extension.js` 在本地默认监听 `127.0.0.1:48322`，作用是：

- 通过 VS Code LM browser tools 接入 Integrated Browser；
- 向网页注入 WebMCP page agent；
- 提供 `/webmcp/tools` / `/webmcp/invoke`；
- 管理 page token / page session / approval；
- 启动与连接 Gateway；
- 保留一部分 Arena 专用 CDP 历史路径。

### Page Agent

`arena-agent-bridge.js` 当前为 v25。页面实现已经拆成三个协作层：`webmcp-page-core.js`、`webmcp-site-adapters.js` 与薄化后的 page agent。它保留并继续验证以下可靠性语义：

- version + transport identity + page token 一致才复用；
- DeepSeek 登录页保护；
- MutationObserver / bounded scan；
- execution 与 result delivery 分离；
- dedupe；
- DeepSeek line protocol；
- generic JSON protocol；
- delivery retry 不重复执行工具。

WebMCP Core 当前拥有 tool request parsing、call-occurrence dedupe、sessionStorage seen migration 与 pending delivery state；Site Adapter 当前拥有 composer/assistant DOM 选择、DeepSeek auth guard、lane detection、site-specific transport prompt 与 DeepSeek send-policy hook。Page agent 负责调度 MutationObserver、调用 capability、把结果回填网页。

v25 支持两种 page transport：Integrated Browser 使用 localhost HTTP bridge；Gateway-managed Edge 使用 Playwright page binding。由 `extensions/shuncode-webmcp` 启动 Gateway 时，扩展会把 canonical Core/Site/Agent 源码路径传给 Gateway，因此这两条主路径不再维护两套 page agent。`tools/webmcp-gateway/generic-chat-agent.js` 目前仅保留为 standalone Gateway 未收到 canonical source path 时的兼容 fallback。

Phase 5.2 在 page agent 上新增 Worker control surface：`workerSession()` 提供稳定 page-session identity，`workerSend()` 建立一轮网页 Worker turn，`workerPoll()` 输出 sequence-numbered assistant/capability/status/terminal events，`workerInterrupt()` 委托 Site Adapter 停止当前生成。工具协议正文不会作为普通 assistant text 暴露；发生 capability call 后，只有 result delivery 完成且出现新的 post-tool assistant revision，turn 才允许进入 completed。

WebMCP Extension 把上述 surface 封装为 `_shuncode.webMcp.worker*` 内部 command contract，并始终校验 `pageId + pageSessionId`，防止页面刷新/换页后继续控制陈旧 session。第一方扩展通过 `WebMcpCommandTransport` 消费 command contract，再进入 `WebWorkerAdapter → WorkerSessionManager`；page session id 是 adapter-native session id，managed session id 与 Task binding 仍由 `WorkerSessionManager/TaskRuntime` 拥有。WebMCP page token 不向 Worker/Task 层暴露。

Phase 5.3 又让 `WorkerSessionManager` 对绑定 Task 的 capability events 做通用 execution projection：call/result/delivery ack 会进入 TaskRuntime，Worker-origin metadata 会保存 managed session / worker / input / provider call identity。当前这是 durable shadow ledger；WebMCP Core 仍然拥有实际 page execution occurrence dedupe 与 delivery retry，因此尚未发生执行 ownership 切换。

### Gateway

`tools/webmcp-gateway/server.mjs` 默认监听 `127.0.0.1:48321`，同时是：

- 上游 Nimora Bridge 的 MCP client；
- 对下游的 MCP server；
- Integrated Browser tool federation；
- managed Edge browser capability host；
- Personal Edge broker；
- managed browser WebMCP host/control API。

Phase 6.1 已把 Gateway 的 tool federation 路由从 `server.mjs` 内硬编码 if/else 提取为 `provider-registry.mjs`。当前显式 provider 是 `upstream-mcp`（fallback）、`integrated-browser`、`managed-browser`、`personal-edge`：tool list 保持原有 provider 顺序，调用时先解析本地显式 owner，只有没有本地 owner 才回落 upstream。标准 `/mcp` endpoint 与 `/control/*` routes 没有改变；真实 Gateway MCP smoke 已验证本地同名 tool 不会重复落到 upstream。

这一步只建立了**模块边界和 ownership contract**；Managed Browser、Personal Edge、upstream MCP client 等具体实现目前仍物理位于 `server.mjs`，Gateway monolith 尚未完成拆分。

默认 WebMCP control/gateway 端口仍保持 48322/48321 以兼容现有安装版；源码/测试实例可通过 `SHUNCODE_WEBMCP_CONTROL_PORT` / `SHUNCODE_WEBMCP_GATEWAY_PORT` 隔离运行。动态 discovery/多 workspace handshake 尚未完成。

## 9. Browser 的三个不同环境

必须长期明确区分：

1. **Integrated Browser**：Nimora 内部 BrowserView/共享页面；WebMCP AI 页面主要宿主。
2. **Managed External Edge**：Gateway 自己管理的持久 Edge profile，不等于用户日常浏览器。
3. **Personal Edge**：用户通过扩展明确共享的真实 Edge tab；只允许受限 read/elements/click/fill/navigate/reload，不提供任意 JS。

## 10. Sessions / “Agent Panel” 的真实情况

`extensions/shuncode` **没有注册自己的 View Container 或 View**；`shuncode.agent` 只是注册在 VS Code 原生 Chat `panel` location。

用户体验中看到的 Agents/Sessions 工作台来自 Code-OSS `src/vs/sessions/**` 和 Core Agent Host 体系，而不是第一方扩展单独造出的“Agent Panel”。它已经包含：

- provider-agnostic sessions；
- workspace/worktree；
- chat interactivity（Full / ReadOnly / Hidden）；
- lead/worker chat 的 agent-team 模型；
- model/mode/permission/isolation；
- session creation/listing/routing。

因此对“Agent Panel”的正确审计结论不是直接删除，而是**保留其平台价值、重新定位用户概念**。未来更适合演化为 Task Center / Work Sessions，而不是把技术对象 “Agent Host” 暴露给用户。

## 11. 已验证的生产链路

重建阶段已经实际通过：

- source Runtime `runtime/hello`、MCP smoke；
- file tools 四项真实调用；
- 本地 Bridge 外部 MCP client；
- Cloudflare Quick Tunnel 公网 MCP client；
- Personal Edge navigate/elements/fill/click/read/reload；
- ChatGPT Native MCP → Nimora `run_command`；
- DeepSeek Web → WebMCP → Nimora `list_directory` / `read_files` → result 回灌 → DeepSeek 继续回答。

这些能力应被视为迁移过程的回归基线。

## 12. 当前最大的架构问题

不是“功能缺失”，而是**ownership 和边界不清晰**：

1. 两套 Agent runtime/session 基础设施并存，但没有统一 Task/Worker 抽象；
2. ShunCode 产品逻辑直接进入通用 Chat Core；
3. Bridge 同时是 tool server、tunnel manager、activity state、todo state；
4. Gateway 同时是 federation、browser provider、Personal Edge broker、WebMCP host；
5. WebMCP 有两套 page-agent 实现并出现能力漂移；
6. Tool schema/permission/retry/risk metadata 还没有统一 registry；
7. Chat/branch/session/agent/bridge 多种状态各自存在，缺少一等 Task domain；
8. 根 `AGENTS.md` 仍是上游 VS Code 占位说明，新 AI 无法安全判断 Nimora 与 Code-OSS 边界。
