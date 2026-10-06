# Nimora IDE Architecture

> **2026-10-07 UI Release 收尾**：新 UI 与 R19 后端已合并为独立 Beta 包。长操作/错误反馈、首次 Web/API 配置、真实任务状态与刷新阅读位置已修；39/39 回归、48 个界面检查、全新 profile 真实打包 Webview、目录及 ZIP 回解 portable 均 PASS。最终交付为 `Nimora-Beta-Windows-x64-20261007-UI-Release.zip`，较早冻结 UI/取消/待构建段落为历史快照；不代表全部 Provider 或 Stable 资格。见 [UI 与发行收尾记录](UI_RELEASE_CLOSEOUT_2026-10-07.md)。

> **2026-10-07 R19 最终更新**：Human通过新原生审核身份完成正式确认；API实际Mission自治/三次工具唯一投递/Evidence/Practice归档/重启复核/独立审核/本轮root与Coordinator正式归档全部PASS，三个Mission completed、scope Workers0、root-scoped completion latch completed、文件和旧历史不变。原取消记录保留。独立包/portable/build/typecheck通过；冻结UI carrier不代表当前并行UI release或所有外部gate资格，整体RC仍开放。[正式结果](API_COMPLETION_RECOVERY_2026-10-07.md)优先于下方历史。

> **2026-10-07 R19 Runtime 当前事实**：真实DeepSeek API已通过Cognition→Work Order→严格三次READ/ADD/READ及唯一投递→durable Evidence→Practice正常归档→completion-candidate，重启单轮复核没有重播工具或Practice。API审核连接恢复与归档Practice启动检查已修，isolated build/typecheck及专项通过；独立R19 ZIP/CRC/回解/hash/两处portable通过。最终Human完成确认实际取消，没有完成命令，Root/Coordinator未归档，整体RC仍开放。冻结R16 UI carrier保护并行UI工作，未覆盖共享生成物。详见[恢复结果/合同](API_COMPLETION_RECOVERY_2026-10-07.md)、[完整现状](MULTI_PROVIDER_AUTONOMY_2026-10-06.md)。以下旧状态是历史快照。

> **R16 当前执行更新**：R15 全包/回解/portable 已通过；新 API Coordinator 回执已走通，但 Runtime `answer` 未投影到 canonical terminal `text`，两次 Root 回答被当成空内容而停止，文件工具0，原回合与Project保留、Workers正常退休。R16 已修正映射，真实完整 domain→Runtime→Cognition/Practice→三次工具/投递→Evidence→archive 组合fixture及39/39回归 PASS，正在正常构建。完整账号与RC尚未验收；[当前事实](MULTI_PROVIDER_AUTONOMY_2026-10-06.md)优先于下方较早快照。

> **2026-10-06 Multi-Provider V1 当前更新**：[生产资源策略/API 规划与执行/多 Profile/混合自治/后续轮次/观测合同](MULTI_PROVIDER_AUTONOMY_2026-10-06.md)已实现，第一方 typecheck/compile 与 R15 39/39 回归 PASS。R14 包/回解/portable PASS；真实 API Formation 后 Coordinator envelope 被拒绝，文件执行零，失败保留且两个角色正常退休。R15 正常重建中；完整 API、混合账号现场与 RC 仍开放。原启动和正式完成授权保持。以下较早快照以该记录为准。

Phase 11 并行实现记录：[`PHASE11_WO2_WO3_IMPLEMENTATION.md`](PHASE11_WO2_WO3_IMPLEMENTATION.md)（Worker 显式替换与普通用户入口；尚未声明 live acceptance）。

本目录是 Nimora IDE 的长期架构事实与演进依据。这里的目标不是把 2026-09 的实现永久固化，而是让后续开发者和 AI 能先知道“现在真实是什么、为什么会这样”，再安全地决定“下一步应该变成什么”。

2026-10-06 现有零件装配与验证：[COMPONENT_INTEGRATION_2026-10-05.md](COMPONENT_INTEGRATION_2026-10-05.md)、[NATIVE_CLIENT_TOOL_WORKER_2026-10-06.md](NATIVE_CLIENT_TOOL_WORKER_2026-10-06.md)、[COMPONENTS_REAL_ACCEPTANCE_2026-10-06.md](COMPONENTS_REAL_ACCEPTANCE_2026-10-06.md)。R9 DeepSeek 同 Project 两轮严格 READ/PATCH/READ、独立精确 instruction 审核及 Human 正式完成 LIVE PASS；六个 Mission 归档、六个 Workers 退休，第一轮文件与历史不变。API/受限 Copilot pool、Skills/Observation/MCP/退休归档/Personal Edge 已源码接线与隔离测试，剩余真实账号验收开放；Copilot 当前 modelCount=0。通知非阻塞/呈现恢复及 cleanup 收尾修复的新包现场另计。旧失败与 no-replay 身份保留；Stable 仍 HOST_PREREQUISITE_BLOCKED，不能宣称全部现场/发布缺口清零。

下一阶段已选方案：[NEXT_STAGE_PLAN_2026-10-06.md](NEXT_STAGE_PLAN_2026-10-06.md)。先完成 R10 有界现场资格验证和单 API 实链，再打通混合 Web/API 普通自治，随后多 Profile/总文与观测调度；Native 和 Stable 前置单独推进。该文件是方案与退出门，不是新增能力完成声明。

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
10. [`MISSION_WORK_ARCHITECTURE.md`](MISSION_WORK_ARCHITECTURE.md) — Project / Mission、文理闭环、人机共议与一次性 AI 的下一层工作组织模型。
11. [`MISSION_WORK_ROADMAP.md`](MISSION_WORK_ROADMAP.md) — 在现有 Task/Worker/Capability 地基上实现 Mission Work 的分阶段开发计划与 AI 交接规范。
12. [`MISSION_PARALLEL_ORCHESTRATION.md`](MISSION_PARALLEL_ORCHESTRATION.md) — 以 Mission 为并行单位的有原则分工、依赖 readiness、单 Mission 单 current Worker 与显式并行 assignment 边界。
13. [`CURRENT_ROUTE_RELAY.md`](CURRENT_ROUTE_RELAY.md) — ChatGPT Web Worker 使用稳定 MCP URL、由 ShunCode 自动吸收 Quick Tunnel 地址轮换的传输层设计与部署说明。
14. [`WORKER_CONVERSATION_LIFECYCLE.md`](WORKER_CONVERSATION_LIFECYCLE.md) — 网页/聊天 AI 的容量检测、同 Mission Worker 接班与 provider 对话清理；Coordinator + lifecycle 如何处理有限上下文。
15. [`P0_RELIABILITY_FOUNDATION.md`](P0_RELIABILITY_FOUNDATION.md) — P0 可靠性收口：非 owning Mission observation、provider-neutral Browser Worker 状态、故障 smoke、MCP 2026 compatibility 边界与 Phase 11 解冻后的生产接线清单。
16. [`PHASE12_PRODUCT_SHELL.md`](PHASE12_PRODUCT_SHELL.md) — Phase 11 并行期间隔离实现的 Nimora Beta Product Shell；Project/Mission 首页、Activity、Artifact、Decision 与现有安全操作入口，以及 Phase 11 解冻后的薄集成步骤。
17. [`PHASE12_UI_PRODUCT_PLAN.md`](PHASE12_UI_PRODUCT_PLAN.md) — Nimora 产品 UI 的正式规划：Project-first 信息架构、Mission/Worker 层级、Human Attention、Activity、Connections、Graph 与 Beta 验收标准。
18. [`PROJECT_COGNITION_PROPOSALS.md`](PROJECT_COGNITION_PROPOSALS.md) — Project-level Draft / Proposed cognition；供后续 Phase 文读取，但在 Human Confirmed / Committed 前不属于 Project truth。
19. [`TARGET_ARCHITECTURE.md`](TARGET_ARCHITECTURE.md) — 下一代目标架构与候选路线比较。
20. [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) — 从当前系统到目标架构的分阶段迁移。
21. [`TECH_DEBT.md`](TECH_DEBT.md) — 有事实依据的技术债务与优先级。
22. [`PHASE12_P0_P5_MISSION_AUTONOMY_INTEGRATION_2026-10-04.md`](PHASE12_P0_P5_MISSION_AUTONOMY_INTEGRATION_2026-10-04.md) — 本轮 P0–P5 的真实源码/测试进度、单页先规划、多 Mission 计划、Coordinator 与并行资源接线，及**尚未通过的自主反馈和 Beta 真实验收门**。

## 事实等级

本文档使用以下语义：

- **已验证事实**：可由当前源码、Git 历史、构建脚本、source map 审计或真实 E2E 重复支持。
- **历史事实**：来自 ShunCode 开源重建过程，并已尽可能由仓库产物交叉验证。
- **架构判断**：基于当前事实的工程判断，不等于不可改变的约束。
- **目标设计**：推荐的未来方向，需要按 `MIGRATION_PLAN.md` 分阶段验证，不允许一次性大改。

## 一条总原则

> 不为了保留而保留，不为了重构而重构。保留真正有长期价值的能力，并让每项能力待在长期最合理的位置。

Code-OSS / VS Code 是 Nimora 的长期基础，不以“去 VS Code 化”为目标；同时 Nimora 必须拥有清晰、可识别、可测试的自身架构，而不是把产品逻辑无限散落在 `src/vs/...`。
