# Nimora IDE Agent Instructions

本仓库是 **Nimora IDE**。它以 Code-OSS / VS Code `1.132.0` 为长期平台基础，并包含从 ShunCode 发行版可验证恢复的 Agent Runtime、Tool Layer、Bridge、WebMCP、Gateway 与浏览器能力。

历史 `shuncode` / `ShunCode` 内部标识仍广泛存在于 command id、configuration、storage、protocol 和 runtime path 中。除非任务包含明确 migration plan 与兼容测试，**不要为了品牌统一做全局重命名**。

## 开始任何中大型任务前

1. 读取 [`docs/architecture/README.md`](docs/architecture/README.md)。
2. 读取与任务相关的 architecture 文档和 ADR。
3. 检查当前源码、测试与 `git status`，不要只根据 README 推断实现。
4. 明确 Source of Truth、模块 owner、涉及的 contract、验证与回滚方案。

详细 AI 开发规则见 [`docs/architecture/AI_DEVELOPMENT.md`](docs/architecture/AI_DEVELOPMENT.md)。

## 当前架构方向

目标架构是：

> **Thin Core + Nimora Task Runtime + Capability Layer + Worker Adapters + modular Nimora Gateway**

关键原则：

- **Code-OSS 不抛弃。** Editor、Workbench、Terminal、LSP、SCM、Sessions、AgentHost/AHP 等通用平台能力继续复用。
- **Task 是最高业务对象。** Chat 是 Task 的交互/展示 surface；AI 会话是可替换 Worker。
- **Tool Layer 演化为 Capability Layer。** schema、risk、approval、idempotency、retry、environment metadata 应逐步统一。
- **WebMCP 是 Worker adaptation layer。** 站点 DOM/协议差异进入 Site Adapter，不进入 Task/Capability domain。
- **Gateway 是外部连接与浏览器边界，不是 Task brain。**
- **Core 默认只接受 generic thin hook。** Nimora-specific Bridge、multi-model、provider/tool 特判优先留在 Nimora-owned modules。

目标架构与迁移阶段见：

- [`docs/architecture/TARGET_ARCHITECTURE.md`](docs/architecture/TARGET_ARCHITECTURE.md)
- [`docs/architecture/MIGRATION_PLAN.md`](docs/architecture/MIGRATION_PLAN.md)
- [`docs/architecture/CORE_PATCH_AUDIT.md`](docs/architecture/CORE_PATCH_AUDIT.md)

## Source of Truth

- 第一方 Extension canonical source：`extensions/shuncode/src/**`
- 第一方 Runtime canonical source：仓库根 `src/agent-host.ts`、`src/openai-agent.ts`、`src/*tool*` 等
- WebMCP Extension source：`extensions/shuncode-webmcp/**`
- Gateway source：`tools/webmcp-gateway/**`
- Code-OSS Core：`src/vs/**`，默认视为上游/platform ownership

不要直接修以下生成物：

- `extensions/shuncode/dist/**`
- `extensions/shuncode/runtime/**`
- `out/**`
- `.build/**`

详细边界见 [`docs/architecture/SOURCE_OF_TRUTH.md`](docs/architecture/SOURCE_OF_TRUTH.md)。

## Core Patch Guard

修改 `src/vs/**` 前必须确认：

1. Extension API 是否真的做不到；
2. proposed API 是否已经足够；
3. 是否可以放进 Nimora Workbench Adapter；
4. 如果必须改 Core，能否做成 generic hook 而不是 Nimora product logic；
5. 哪个测试保护它；
6. 将来上游提供等价能力时如何删除它。

无法回答时先调查，不要继续扩大 Core Patch。

## 执行与安全不变量

- 工具**执行**与结果**投递**是不同事务。
- transport/result delivery 失败不能作为重新执行有副作用工具的理由。
- `run_command`、`apply_patch`、click/send/delete 等副作用操作不得盲重试。
- Web page / external MCP client 不等于可信 runtime；按 Task/Worker 最小授权。
- Personal Edge 只操作用户明确共享的 tab。
- 不提交 API key、route token、Cloudflare/ngrok token、cookie、browser profile 或登录态。

## 安装版 ShunCode

`C:\Program Files\ShunCode` 只允许作为 **read-only reference**。

禁止修改、覆盖、重新安装、patch，禁止为了源码测试通用 kill 正式 `ShunCode.exe`。源码实例使用 `.build/shuncode-dev-*` 隔离环境。

## 基础验证

第一方 Runtime / Extension 改动通常至少运行：

```powershell
npm run typecheck-shuncode
npm run compile-shuncode
npm run test-shuncode-runtime
```

WebMCP / Gateway 改动至少做相关 `node --check`，并按影响范围回归 DeepSeek、ChatGPT MCP、Browser 或 Personal Edge 实链。

不要把完整 root strict typecheck 与“生产 source-map 恢复一致性”混为一谈；验证层级和已知限制见 [`docs/architecture/AI_DEVELOPMENT.md`](docs/architecture/AI_DEVELOPMENT.md) 与 [`docs/BUILDING.zh-CN.md`](docs/BUILDING.zh-CN.md)。

## 架构变化

如果任务改变了模块 ownership、协议、security model、Core boundary 或长期 domain model：

- 更新对应 `docs/architecture/*`；
- 必要时新增/更新 ADR；
- 不允许让重要设计决定只存在于聊天记录。

最终目标是：新的 AI 会话只依赖 **代码 + 文档 + contract + tests + ADR + roadmap** 就能安全接手 Nimora。
