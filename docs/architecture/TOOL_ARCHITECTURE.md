# Tool / Capability Architecture

## 1. 为什么 Tool Layer 是一等核心

模型会变、网页会变、provider 会变，但“AI 能安全地对本地环境做什么”才是 Nimora 长期积累的资产。

当前已经验证的 file / terminal / LSP / diagnostics / browser / Personal Edge tools 证明 Tool Layer 不应继续只是各 transport 自己拼出来的一组 schema，而应升级为独立 **Capability Layer**。

## 2. 当前分布

```text
src/capability-registry.ts
    └─ canonical semantic metadata (risk / retry / approval / environment)

root src/file-tool-registry.ts
    └─ file schemas + pure implementation dispatch

root src/ide-tool-definitions.ts
    └─ logical IDE schema + read/execute capability

extensions/shuncode/src/ide-tool-broker.ts
    └─ actual VS Code/PTY/LSP implementations

extensions/shuncode/src/bridge-server.ts
    └─ MCP wrappers + set_todos/report_progress

tools/webmcp-gateway/server.mjs
    └─ browser + Personal Edge + upstream federation tools
```

现在 schema、risk、retry、approval、environment metadata 分散在不同组件。

### Phase 1 implementation status

Phase 1 已建立第一版统一 semantic metadata contract：`src/capability-registry.ts`。

- 当前 13 个 Runtime / Bridge 核心 capability 都有稳定 `id`、`risk`、`idempotency`、`retry`、`approval`、`environment` 与 tags；
- Bridge 和 file-tools stdio MCP 在 `tools/list` 中投影标准 MCP `annotations`，并通过 `_meta["nimora/capability"]` 携带完整 Nimora metadata；
- Gateway-managed Browser 与 Personal Edge 使用同一 metadata shape；
- Gateway 的 upstream transport retry 优先读取 capability metadata，不再把硬编码 tool-name 白名单当作当前 Source of Truth；
- 为兼容尚未携带 metadata 的旧 Bridge，原 read-only retry 白名单暂时保留为明确的 legacy fallback；
- tool name、input schema、provider dispatch 与现有审批行为均未在 Phase 1 改变。

当前 registry 是 **semantic registry**，不是“所有实现必须物理放进一个文件”。Gateway/browser provider 可以在正确的进程定义 provider-local capability，再使用相同 contract 暴露。

### Phase 2 provider split status

Extension Host 的 IDE capability 已按 owner 拆分：

```text
IdeToolBroker (thin facade)
├─ WorkspaceCapabilityProvider
│  └─ list_directory
├─ TerminalCapabilityProvider
│  ├─ run_command
│  ├─ get_command_output
│  ├─ send_command_input
│  └─ wait
│      ↓
│    TerminalCommandManager (PTY / direct backend)
├─ DiagnosticsCapabilityProvider
│  └─ get_diagnostics
└─ LspCapabilityProvider
   └─ lsp
```

`src/ide-tool-definitions.ts` 是 IDE tool → provider owner 的 canonical mapping。`IdeToolBroker` 只负责 provider composition、VS Code LM registration，以及 Native Chat / Bridge 需要的兼容 facade；它不再实现 Workspace/Diagnostics/LSP/Terminal 业务本身。

Terminal subsystem 没有为了“拆文件”而重写：原有 persistent PTY、ConPTY、echo gate、direct execution、output capture、interactive input 和 terminal reuse 逻辑整体迁入 `terminal-command-manager.ts`，并已通过真实 Extension Host terminal smoke。

## 3. 目标 Capability Definition

建议 canonical metadata：

```ts
interface CapabilityDefinition {
  id: string;
  version: number;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;

  category: 'workspace' | 'terminal' | 'diagnostics' | 'browser' | 'os' | 'task' | string;
  tags: string[];
  environment: 'runtime' | 'extension-host' | 'gateway' | 'personal-browser' | string;

  risk: 'read' | 'write' | 'execute' | 'external-side-effect';
  idempotency: 'safe' | 'idempotent' | 'non-idempotent' | 'unknown';
  retry: 'automatic' | 'verify-before-retry' | 'never';
  approval: 'none' | 'task-grant' | 'session' | 'always';

  timeoutMs?: number;
  availability?: CapabilityAvailability;
}
```

这不是要求一次性改完 schema，而是统一设计目标。

## 4. Registry 与 Provider

**Registry** 只拥有 definition/index/availability，不拥有所有实现。

实现继续按环境分布：

- Runtime File Provider：纯 workspace file operations；
- Extension Host Provider：editor/LSP/diagnostics/PTY；
- Gateway Browser Provider：managed browser；
- Integrated Browser Provider：shared BrowserView；
- Personal Edge Provider：explicit shared personal tab；
- Future OS Provider：更明确的 system capability。

Provider 注册到统一 Registry，Router 决定当前 Task/Worker 可见哪些 capability。

## 5. Capability Router

Router 属于 **Task Runtime / Context Engine**，不是 Gateway。

输入：

- Task intent/state；
- worker capability；
- policy grants；
- environment availability；
- context budget。

输出：

- 当前 worker 可发现的 capability categories；
- 实际暴露的少量 tool definitions；
- 执行 endpoint/provider route。

Gateway 负责 transport/federation，不决定“这个 Task 应看到什么工具”。

## 6. Dynamic Tool Loading

未来避免把全部 tools schema 塞进每个模型上下文。

推荐两阶段：

1. Worker 先看到 compact capability catalog，例如 `workspace.read`、`workspace.edit`、`terminal.execute`、`browser.personal`；
2. 只有 Task 需要某能力时，Router 才 materialize 具体 tool schemas。

对于原生 MCP client，可通过 namespaced server/list changed 或 capability server slicing 实现；对于 WebMCP，可在 prime/context refresh 时只发送 task-relevant tools。

## 7. Skill Registry

Skill 和 Tool 不同：

- Tool = 可执行 capability contract；
- Skill = 如何组合/使用 capabilities 的 instruction/workflow knowledge。

Skill Registry 应记录：

- id/version；
- trigger/capability requirements；
- context cost；
- source/trust；
- relevant task types。

Skill Router 与 Tool Router 都由 Context Engine 编排，但不能把 Skill 当作 executable tool。

## 8. Permission / Approval

审批不应由每个 transport 各自维护一套名单。

目标 Policy Engine 接收：

- Capability risk metadata；
- Task grant；
- Worker/session identity；
- origin/provider；
- concrete arguments；
- user policy。

WebMCP 的 trusted/session/always 和 Bridge/Chat 的 confirmation 最终都映射到统一 policy。

## 9. Execution Ledger

每个 tool call 必须有稳定 `executionId`，记录：

```text
requested
→ approved/rejected
→ executing
→ succeeded/failed/unknown
→ result-pending-delivery
→ delivered
```

并保留：

- taskId；
- workerSessionId；
- capability id/version；
- arguments digest；
- side-effect/risk；
- provider；
- start/end；
- result/artifact refs；
- retry relationship。

这样 WebMCP 已经验证的“执行成功但 result delivery 失败时不能重跑工具”就变成系统级可靠性保证。

## 10. 当前工具迁移优先级

1. ~~先给现有工具补统一 metadata，不改 behavior；~~ **Phase 1 已完成第一版**；
2. ~~从 `IdeToolBroker` 拆 provider；~~ **Phase 2 已完成 Extension Host provider split**；
3. Bridge/Gateway 改为读取 Registry，而不是复制 tool semantics；
4. 把 `set_todos/report_progress` 移入 Task Capability；
5. browser tools 统一 provider metadata；
6. 最后才启用 dynamic discovery/router。

任何一步都必须保持现有 12-tool Bridge E2E 和 DeepSeek/ChatGPT 回归可通过。
