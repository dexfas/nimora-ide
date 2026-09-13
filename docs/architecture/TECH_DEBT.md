# Technical Debt

## 1. 分级

- **P0**：安全/数据破坏/执行一致性风险，继续扩展前必须处理。
- **P1**：会显著阻碍目标架构或上游升级，应进入近期 roadmap。
- **P2**：维护性/开发体验问题，可在相关模块修改时处理。
- **P3**：清理/命名/历史兼容，不阻塞核心演进。

## 2. 债务表

| 优先级 | 债务 | 事实依据 | 风险 | 处理方向 |
| --- | --- | --- | --- | --- |
| P0 | Personal Edge 使用开发 pairing token | MV3/Gateway hard-coded local-development token | 发布环境本地恶意进程冒充/劫持 | per-install/session pairing secret + origin binding |
| P0 | execution ownership 尚未全链路统一 | Phase 5.3–5.4.4 已完成 durable ownership 基础，5.4.5 已把真实 IdeToolBroker executor + fail-closed metadata authorizer 接进 dormant service；但 WebMCP page Core 仍是生产 dispatch owner，尚无真正 `host-requested` end-to-end lane | 双 owner 切换错误仍可能造成副作用重放/状态漂移 | 下一步只在 synthetic/实验 lane 完成 host-requested 闭环；release gate 通过前不切 live WebMCP 默认 ownership，不删除 page at-most-once ledger |
| P1 | 两套 Agent runtime 无统一 domain | Core AgentHost + first-party Runtime | session/task/worker 重复建模 | Worker Contract + Task Runtime |
| P1 | Nimora product logic 进入 Chat Core | Bridge/branch/model/tool renderer patches | 上游升级成本、AI 误改 | Thin Core migration |
| P1 | Bridge 职责过宽 | `bridge-server.ts` 同时 MCP/tunnel/state/UI | 修改牵连大、难测试 | split exposure/tunnel/task state |
| P1 | Gateway 单文件职责过宽 | `server.mjs` federation/browser/personal/web agent | failure isolation 差 | modular providers |
| P2 | standalone Gateway legacy page-agent fallback | Phase 5 已让 Extension + Extension-launched Gateway 共用 canonical v25 Core/Site/Agent，但 standalone Gateway 缺 shared-source env 时仍回退 `generic-chat-agent.js` | standalone fix 仍可能漂移 | 后续把 fallback 也改为可打包的 canonical WebMCP bundle，再删除 legacy agent |
| P1 | localhost port discovery 尚未完成 | Phase 5 已允许源码通过 env 覆盖 48321/48322，但默认安装、多 workspace 仍无 discovery/handshake | 多 workspace/并行实例需手工分配 | dynamic port + discovery/handshake |
| P1 | Context/tool 全量暴露趋势 | Capability metadata 已存在，但 WebMCP prime 仍可发送大量 tools | token/attention/attack surface | Capability Router / Context Budget / dynamic loading |
| P1 | 上层 worker selection 仍绑定现有 Chat/调用面 | Phase 5.2 已有真实 Web WorkerSession/Task binding，但 Native Chat/未来 Work orchestration 尚未通过统一 WorkerSessionManager 自动选择/切换 worker | Web worker 仍需内部 control caller 才能启动 | migrate caller orchestration to Task WorkerAttempt + WorkerSessionManager |
| P1 | Bridge todo/progress 仍是 UI Source of Truth | Phase 3 已双写 Task journal，但现有 `BridgeManager.todos/activities` 仍驱动 UI | Task continuity/多 session ownership 仍不完整 | 验证 projection consistency 后切 Task progress store 为 owner |
| P1 | upstream baseline diff 不可离线复核 | repo 缺 1.132.0 commit object | Core audit 难重复 | baseline fetch/cache/audit script |
| P2 | Terminal backend 仍较大 | `IdeToolBroker` 已在 Phase 2 收缩为薄 facade，但 PTY/ConPTY/direct execution 本身约 1500 行且状态复杂 | Terminal 修改仍需高强度回归 | 保持独立 backend；只在有明确收益时继续内部模块化，不为 LOC 强拆 |
| P2 | `model-provider.ts` 过大 | catalog/auth/protocol/config mixed | provider change 高风险 | split catalog/auth/worker adapters |
| P2 | `native-chat.ts` 混 UI/orchestration | runtime/tool/branch/checkpoint | Chat 变 state owner | thin Chat projection |
| P2 | Core↔extension magic command IDs | `shuncode.branch.*`, Bridge commands | 类型弱/隐藏依赖 | typed adapter/proposed API |
| P2 | architecture docs 需要持续随协议版本更新 | Phase 5 已将入口文档同步到 v25，但 WebMCP/Worker/Gateway 仍在迁移 | 新 AI 读取旧版本事实 | architecture docs + smoke outputs as source of truth |
| P2 | strict root typecheck ≠ production recovered scope | documented ~1173 historical errors | 新 AI 误“修复” recovered code | explicit validation tiers |
| P3 | historical license/payment dead path | free access early return | 噪音/误解 | delete after compatibility audit |
| P3 | internal ShunCode naming | runtime/IDs/protocol paths | branding confusion | keep compatibility; rename only behind migrations |
| P3 | first-party runtime named `agent-host` | conflicts with Core AgentHost concept | architecture confusion | rename when contract migration lands |

## 3. 当前不应被误判为“债务”的东西

### Code-OSS / VS Code 基础

不是债务。重造 editor/LSP/terminal/workbench 没有价值。

### Core AgentHost 复杂度

复杂不等于错误。它解决 remote/session/sandbox/worktree 等复杂问题；目标是减少 Nimora-specific coupling，而不是把它删掉重写。

### 保留历史 `shuncode` IDs

兼容期内属于必要技术约束。全局 rename 可能破坏 command/config/protocol/storage；必须有 migration plan 才能动。

### 生成物存在

`dist/runtime/out/.build` 本身不是债务；真正问题是开发者是否清楚 canonical source。

## 4. 衡量技术债务是否改善

建议持续跟踪：

- `src/vs/**` Nimora-specific patch files/count；
- Core↔extension magic command IDs 数量；
- capability schema duplicate count；
- Gateway/Bridge monolith LOC 与 module coverage；
- E2E pass matrix；
- Web site adapter-specific test coverage；
- average tools exposed per Task/Worker；
- context bytes by category；
- unknown/retried side-effect executions；
- upstream rebase conflict files；
- generated-file accidental edits。
