# Module Audit

## 1. 判定标准

每个模块都用同一个问题审计：

> 如果今天已经知道全部现有需求，我还会设计这个组件吗？如果会，它应该继续以当前形式和位置存在吗？

分类：Keep / Refactor / Merge / Split / Replace / Delete。

## 2. 总表

| 模块 | 当前判断 | 目标 |
| --- | --- | --- |
| VS Code Native Chat | Keep | 一个 Task 交互 surface，不做最高层 state owner |
| Sessions / Agents Window | Refactor/Reposition | Task Center / Work Sessions substrate |
| Core Agent Host / AHP | Keep | generic compute/session substrate |
| First-party `src/agent-host.ts` Runtime | Refactor | API/Local Worker runtime adapter + execution engine pieces |
| Model Provider | Split | provider catalog/auth/config 与 Worker adapter 分离 |
| Native Chat orchestrator | Split | thin UI adapter + Task Runtime orchestration |
| IDE Tool Broker | Split | Extension Host capability providers |
| File Tool Registry | Keep/Extend | Capability Registry 的第一批 canonical tools |
| stdio MCP server | Keep | thin transport adapter |
| Bridge | Split/Reposition | MCP exposure + tunnel adapters，不做业务状态 owner |
| WebMCP | Refactor | WebMCP Core + Site Adapters |
| WebMCP Gateway | Refactor | Nimora Gateway modular providers |
| Managed Browser | Keep | Gateway browser provider |
| Personal Edge Bridge | Keep/Harden | explicit personal-browser provider |
| Multi-model Branch/Merge | Replace domain | Task worker candidates/review/merge |
| `BranchStateStore` | Migrate | Task store |
| Custom Ask/Plan/Code | Keep as UX policy | Task mode/policy presets |
| Bridge license/payment compatibility | Delete after compatibility window | 不属于开源目标架构 |

## 3. Native Chat

### 有价值的能力

- VS Code 已成熟的 transcript/input/model/tool UI；
- attachments/context；
- streaming；
- tool confirmation；
- 与 editor/workspace 紧密交互。

### 问题

当前 `native-chat.ts` 同时编排 runtime、tools、branch/merge、checkpoint、模型策略。Chat Session 因此隐式成为业务主对象。

### 结论

**Keep surface / Split orchestration**。

未来 Chat 只负责：用户输入 → Task command、展示 Task events/results、必要时维护 transcript projection。

## 4. Agent Panel / Sessions Window

### 当前真实职责

不是第一方 extension 自造面板，而是 Core Sessions workbench：

- session list/create/archive；
- workspace/worktree；
- model/mode/permission/isolation；
- chat tabs；
- lead/worker chats。

### 用户疑问是否成立

“Agent Panel 没明显价值”对**当前命名与产品概念**有道理：用户没必要理解 Agent Host、provider plumbing。

但底层 Sessions UI 和 provider abstraction 非常有价值，删除会丢掉未来 Task/Worker 最需要的基础。

### 结论

**Refactor / Reposition，不 Delete。**

未来主概念：Task / Work Session。内部 Agent/Worker 可在需要时展开。

## 5. Core Agent Host

### 价值

进程隔离、远端、worktree、sandbox、checkpoint、provider SDK、state protocol 都是真正难做且有长期价值的基础设施。

### 问题

与第一方 Runtime 并存但没有统一领域抽象；部分 provider preference/UI 逻辑也在 Core。

### 结论

**Keep platform substrate；通过 Worker Adapter 纳入 Nimora Task Runtime。**

## 6. First-party lightweight Runtime

### 价值

- 简单的 API/BYOK 模型 loop；
- DeepSeek/OpenAI/Anthropic/Codex protocol compatibility；
- tool loop/checkpoint/trace；
- 与 Extension Host reverse tool/network RPC；
- 可独立测试。

### 问题

名字 `agent-host.ts` 与 Core Agent Host 极易混淆；它同时承载 model adapter 和 orchestration loop。

### 结论

**Refactor/Split**：未来命名为 worker-runtime / model-worker 一类，保留可复用 loop，但 Task ownership 上移。

## 7. Model Provider

`model-provider.ts` 体量较大，当前同时承担 model discovery、protocol、auth/config、reasoning metadata、stream/provider compatibility。

### 结论

**Split**：

- Provider catalog/config；
- Auth adapter；
- API Worker adapter；
- capability metadata。

VS Code `LanguageModelChatProvider` 只是其中一个 presentation/integration adapter。

## 8. IDE Tool Broker

### 位置判断

留在 Extension Host 合理，因为 LSP/diagnostics/editor/VS Code terminal API 在这里最自然。

### 结构问题

单个类过大，file listing、PTY/direct command、diagnostics、LSP、presentation 生命周期混合。

### 结论

**Split, not move**：

- WorkspaceCapabilityProvider
- TerminalCapabilityProvider
- DiagnosticsCapabilityProvider
- LspCapabilityProvider

通过统一 Capability Registry 注册。

### Phase 2 状态

该拆分已经完成第一轮落地。`IdeToolBroker` 现为薄 facade；四类 provider 已成为显式 owner，Terminal 的成熟执行引擎独立在 `terminal-command-manager.ts`。真实源码 Extension Host 的 terminal/LSP smoke 均通过，因此后续 provider 演进应继续在这些边界内进行，而不是把逻辑重新塞回 broker。

## 9. Bridge

### 保留

“让任何 MCP client 获得 Nimora capability”是核心竞争力，必须保留。

### 拆分

当前 Bridge 不应继续同时拥有：

- MCP transport；
- tunnel；
- todo/progress；
- activity/presentation；
- capability schemas；
- task state。

### 结论

**Split + Reposition**：`McpExposureAdapter` + `TunnelProvider`，连接统一 Capability Service。

名字“Bridge”可在用户层保留一段兼容期，但不再代表内部大模块。

## 10. WebMCP

### 核心价值

把没有原生 MCP/tool calling 的网页 AI 转成 Worker，这是 Nimora 独特能力之一。

### 当前问题

- site detection、DOM、protocol、dedupe、approval、local server 混杂；
- `arena-agent-bridge.js` 与 `generic-chat-agent.js` 两套实现漂移；
- Arena 历史专用 CDP 路径仍在通用 extension。

### 结论

**Refactor** 为 WebMCP Core + Site Adapter；不删除。

## 11. Gateway

### 有价值职责

- tool federation；
- browser provider；
- Personal Edge broker；
- web-worker host；
- local security boundary。

### 问题

当前一个 `server.mjs` 承担所有职责，内部 HTTP control API 与 MCP transport 混在一起。

### 结论

**Refactor into modular Nimora Gateway**，而不是再新增一个并行“新 Gateway”。

## 12. Personal Edge

用户主动共享一个真实 tab、无 arbitrary JS 的安全边界设计是正确方向。

### 结论

**Keep + Harden**：正式发布前需要真实 pairing/session secret、origin binding、reconnect/version contract。

## 13. Multi-model branch / merge

### 能力价值

多模型独立回答、采纳、比较、review、merge 非常符合未来多 Worker。

### 当前建模问题

它依附 Chat turn/variant 和 `BranchStateStore`，无法自然承载：

- background worker；
- web worker；
- artifact review；
- worker failover；
- non-chat tasks。

### 结论

**Replace domain, preserve feature**。迁移到 Task Worker Attempts / Candidate Results / Review/Merge。

## 14. Ask / Plan / Code

这三个 mode 对用户有价值，但不应作为三套 runtime。

### 结论

**Keep as policy presets**：不同 mode 改变 allowed capabilities、approval、prompt policy、result expectation，而底层仍是同一 Task/Worker/Tool architecture。

## 15. 历史 license/payment stack

当前开源发行行为明确 free access，授权检查入口已经直接返回。

### 结论

**Compatibility-only → Delete later**。在确认没有旧 settings/data migration 依赖后，从目标架构和 UI 移除，不把不可达商业逻辑继续维护成核心组件。
