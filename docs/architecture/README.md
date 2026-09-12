# Nimora IDE Architecture

本目录是 Nimora IDE 的长期架构事实与演进依据。这里的目标不是把 2026-09 的实现永久固化，而是让后续开发者和 AI 能先知道“现在真实是什么、为什么会这样”，再安全地决定“下一步应该变成什么”。

## 阅读顺序

1. [`CURRENT_ARCHITECTURE.md`](CURRENT_ARCHITECTURE.md) — 当前系统真实组成与关键结论。
2. [`PROCESS_ARCHITECTURE.md`](PROCESS_ARCHITECTURE.md) — 进程、生命周期与通信链路。
3. [`SOURCE_OF_TRUTH.md`](SOURCE_OF_TRUTH.md) — 上游、恢复源码、维护源码、生成物与安装版参考的边界。
4. [`PROTOCOLS.md`](PROTOCOLS.md) — Runtime、AHP、MCP、WebMCP、Personal Edge 等协议。
5. [`CORE_PATCH_AUDIT.md`](CORE_PATCH_AUDIT.md) — Code-OSS Core 增量的职责与去留判断。
6. [`MODULE_AUDIT.md`](MODULE_AUDIT.md) — 当前组件 Keep / Refactor / Merge / Split / Replace / Delete 判断。
7. [`TOOL_ARCHITECTURE.md`](TOOL_ARCHITECTURE.md) — Tool Layer 现状与 Capability Registry / Router 方向。
8. [`AI_SESSION_ARCHITECTURE.md`](AI_SESSION_ARCHITECTURE.md) — Web / API / Local AI Worker 与 Adapter 设计。
9. [`TASK_RUNTIME.md`](TASK_RUNTIME.md) — 从 Chat-Centric 走向 Task-Centric 的领域模型。
10. [`TARGET_ARCHITECTURE.md`](TARGET_ARCHITECTURE.md) — 下一代目标架构与候选路线比较。
11. [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) — 从当前系统到目标架构的分阶段迁移。
12. [`TECH_DEBT.md`](TECH_DEBT.md) — 有事实依据的技术债务与优先级。

## 事实等级

本文档使用以下语义：

- **已验证事实**：可由当前源码、Git 历史、构建脚本、source map 审计或真实 E2E 重复支持。
- **历史事实**：来自 ShunCode 开源重建过程，并已尽可能由仓库产物交叉验证。
- **架构判断**：基于当前事实的工程判断，不等于不可改变的约束。
- **目标设计**：推荐的未来方向，需要按 `MIGRATION_PLAN.md` 分阶段验证，不允许一次性大改。

## 一条总原则

> 不为了保留而保留，不为了重构而重构。保留真正有长期价值的能力，并让每项能力待在长期最合理的位置。

Code-OSS / VS Code 是 Nimora 的长期基础，不以“去 VS Code 化”为目标；同时 Nimora 必须拥有清晰、可识别、可测试的自身架构，而不是把产品逻辑无限散落在 `src/vs/...`。
