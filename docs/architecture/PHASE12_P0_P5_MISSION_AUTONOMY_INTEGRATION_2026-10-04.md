# Nimora P0–P5 · 文理协调与 Mission 自主分工集成实录（2026-10-04）

> **最终晚间 follow-up：P0–P5 engineering + live autonomy acceptance 已完成到 Project completion candidate。** 16:50 后同一原 Project/三 Mission 完成了 canonical owner recovery，并继续真实跑过 capability-error → host-derived Evidence/Problem → Cognition Answer/修订 Work Order → fresh Practice continuation。随后又修复 exact-page visibility convergence、`cancelled` settlement、non-blocking Problem relation、Coordinator 600/600 历史压力和 Cognition 80×2000 字符历史压力。最后产品 `Run Web Autonomy` 在真实 DeepSeek 页上正常停止于 `completion-candidate` / `quiescent`；没有旧 input replay。当前只剩**设计上必须由 Human 阅读 Cognition completion review 后点击的正式 Project 完成确认**，不再是工程或 Provider acceptance blocker。完整证据见 [`PHASE12_MISSION_AUTONOMY_LIVE_HARDENING_2026-10-04.md`](PHASE12_MISSION_AUTONOMY_LIVE_HARDENING_2026-10-04.md)。

> **最终状态（2026-10-04 晚间）：P0–P5 ENGINEERING CLOSED；LIVE AUTONOMY ACCEPTANCE PASS；FORMAL PROJECT FINALIZATION WAITING HUMAN CONFIRMATION。** SOURCE/CORE/PRODUCT smoke、本地 durable evidence 与真实 DeepSeek Provider 路径已经在同一原 Project 中闭合到 completion candidate；Human final completion gate 仍保留。
>
> **并行保护：** 本轮仅修改仓库中的隔离源码、专项测试和文档；未重播原 Nimora-Test 的任何已消费请求，未删除旧 Project/Mission、重置历史失败或改变旧 Dev 的实时浏览器会话。原 Phase12 Coordinator → DeepSeek 最终回执是否被 Provider 确认，仍以 `PHASE12_COORDINATOR_RECEIPT_AND_THREE_ROLE_AUDIT_2026-10-04.md` 的 UNKNOWN 记录为准。

## 1. 用户观察、根因和责任边界

用户在产品面板输入需求后，尚未打开网页便被要求准备 **3 个 DeepSeek 网页**。追查原 `extensions/shuncode/src/extension.ts` 确定：旧入口先 `openDeepSeekPages(3)`，然后才调用临时 tools-free Formation Cognition。硬编码的三个角色是**临时规划页、Coordinator 页和初始 Root Target 页**，不是文对需求做出语义决策后创建的三个独立 Mission。旧 Formation 的结构仅能表达一个 root 加机械创建的 Coordinator；独立 Practice Mission 是后续显式创建的。

坚持原有层级法则：**总文决定跨 Phase 方向；长期文决定 bounded Mission 的职责、依赖、Work Order 和反馈修正；理实际操作并向上返回 Result/Problem/Evidence；Coordinator 只执行已授权的语义命令并可靠传递。** 计划向下，报告向上。Coordinator 不得从观察到的错误自行创造新方案、改变语义所有权或成为第二个长期大脑。

保留原有 `ProjectStore`、`TaskRuntime`、`MissionCollaborationStore`、`MissionCoordinatorService`、`MissionFeedbackService`、`MissionParallelReadinessService`、`MissionParallelAssignmentService`、`WorkerSessionManager` 的 owner 边界。不新建第二套调度日志、Mission Graph 或重放队列。

## 2. P0：现有 Beta 保护与验收审计

**审计已完成，真实新版本 E2E 未完成。** 旧独立发行版曾通过 Windows 可启动/first-party activation，但其全新网页建项因第二个 DeepSeek 页面不健康停在 1/3 健康；这一事实只代表旧发行代际。本轮更晚的原 Dev 事故文档另确认：三个 Mission 工具计数 Cognition 3 / Coordinator 0 / Practice 47，隔离 profile 的 **52/52 本地请求和本地结果投递**，却发生 Coordinator 的最终 DeepSeek Provider admission 边界错误，原上游 ACK 未确认，旧历史失败数量已变为七条，故不能据本地 delivered 声称完整收尾或归档成功。

未尝试重新装载或终止当前 Dev 的实时旧 Provider 会话，也未执行需人类登录、共享或安全授权的现场操作。新源码构建及后续真实 Beta 安装/运行是**另一独立验收门**，不得沿用旧 ZIP 的哈希为本次新版本背书。

## 3. P1：先规划，后按计划形成 Mission

本轮源码变更：

- `extension.ts` 的 **Web 新建项目**先要求 **1 张**真实、健康且得到原生共享授权的 DeepSeek 规划页。tools-free Cognition 完成后，先将有界规划 JSON、确切工作区及需求/规划 SHA-256 写入既有 workspace memento，才要求额外页面。若后续页面不健康，可用**相同需求与相同规划摘要**继续，而非重新发送已消费规划；不同需求/摘要拒绝覆盖。Planner 在实际创建 WorkerSession 后通过 `WebMcpWorkerAssignmentCandidateSource.reservePlanningPage(exactPageId)` 从可分配资源清单排除，即使第一次共享的页面还没有可选 `pageSessionId` 也不得被 Coordinator/Root 抢用；随后从**除规划页以外**的资源中仅准备 2 张，分别用于初始 Root+Coordinator。故当前初始物理角色总数仍为 3，但不再是规划前硬门槛。无身份/无授权的网页一律不冒充就绪。
- `mission-user-entry.ts` 的 Formation Cognition 输出现在可选 0–8 个 `additionalMissions`。为简单需求可显式给出 `[]`；需要多个子 Mission 时，初始 root 必须是持续存在的 `cognition`。计划包含稳定子 key、目标、plane、missionType、完成条件和明确依赖。新 API Chat 及网页入口均连接同一规范，确认对话展示额外 Mission 的目标；非 Cognition root 或未接通可信 Host 的多 Mission 意图在持久化前停止。
- 新增 `src/mission-cognition-plan.ts`：整个图先检验 8 个子项上限、语义边界、重复、引用缺失、自依赖和循环依赖；形成后仅通过原 `MissionCoordinatorService.ensureMission()` 用确定性 operationKey 创建子 Mission，再通过 `MissionCollaborationStore.recordRelation(depends_on)` 落实真实关系，并通过已有 ParallelReadiness 派生当前 frontier。相同身份证明的重试为幂等；同 operationKey 不同内容碰撞拒绝；部分持久结果须先对账，不能默认全部回滚或盲重试。

最初分解仍由 tools-free **建项 Cognition** 提议；后续长期 Root 文现在通过同一 canonical Cognition root 接收 durable Practice Evidence/Problem，输出严格 Cognition decision，并可继续修订 Work Order、创建必要子 Mission、回答 Problem 或授权子 Mission Finalization。初始图形成仍**不等于**全部子 Mission 被授权立即执行；依赖 frontier、Worker readiness 和 capability gate 仍分别检查。

## 4. P2：Coordinator 文理反馈闭环

新增 `src/mission-autonomy-loop.ts`，把反馈从“已有接口”接成 production owner：Practice 只能返回严格 `nimora-practice-report` JSON；Nimora 不把 Provider 自述直接当 Evidence，而是按本轮 `targetInputId` 从真实 Task executions / artifacts / terminal 派生 Evidence，再将 Finding/Problem 写入原 `MissionCollaborationStore`。长期 Root Cognition 读取 bounded canonical Missions/Exchanges，返回严格 `nimora-cognition-decision`，可 Answer 精确 Problem、下发新的 Work Order、提出必要的 additional Missions、授权子 Mission Finalization 或提出 Project completion candidate。

Coordinator 新增 host-bound `deliverParallelExplicitMissionInputs`，仍由 exact semantic command 决定目标；`deliverFeedbackContinuation` 也可重新走 Phase8 capability/context materialization，因此文回答 Problem 后原 Practice 可以继续实际工具工作，而不是仅收到纯文本。所有 Cognition 决策在 durable mutation 前先做 Mission/Problem/Evidence/capability/scope preflight。

`test-shuncode-mission-autonomy-loop` 已验证：同一 Coordinator 回合并发 A/B 两个 Practice；B 的现实不匹配形成 durable Problem/Evidence；下一轮 owning Cognition 读取该事实、持久 Answer、只继续 B；A/B 分别在 Cognition 授权后 Finalize/Archive；root 保持活动并继续受正式 Project completion gate 约束。**P2 工程闭环 PASS；真实 DeepSeek Provider 的新一轮现场 ACK 仍属于 Phase12 live acceptance，而不是把旧 UNKNOWN 改写成成功。**

## 5. P3：有原则的多 Mission 并行

在现有并行领域上，本轮把 `parallelReadiness`、`parallelAssignments` 和 `plannedWork` 接入生产 Composition，并为网页分配扩展 `exactCandidateIds` 狭窄接口：多个现成、就绪且无依赖阻塞的 Mission 可调用原每-Mission `assignInitialRestricted()` 并发分配，但要求提供 **每个 Mission 不同的 SHA-256 WebMCP 网页身份**。重复页、重复 Mission、缺失资源或不满足 readiness 一律拒绝/保持未分配，不发送执行工作单。

新增 `extensions/shuncode/src/nimora-planned-worker-assignment.ts`、产品命令 `shuncode.nimora.assignReadyWebMissions` 和面板“分配就绪 Mission”按钮：检查当前可信工作区、仅正式 Web Project、单一活动 Cognition root、原规划网页仍可证明、Project 范围内无 UNKNOWN；选择明确未被占用的 DeepSeek 页面并逐 Mission 唯一匹配，Human 确认后才并发绑定，面板报告真实结果。新页面仍须原生网页共享；不自动创建、发送或静默加权。

本轮进一步把并行**执行**接入生产：一个 Coordinator semantic turn 可对至多 8 个互异 Mission/WorkerSession/input 身份做有界 fan-out，并通过 `Promise.all` 同时观察 Target transport；重复 Mission、Session、input、总 instruction budget 越界均在发送前拒绝。`MissionAutonomyLoopService` 先读 `MissionParallelReadinessService` frontier；ready-unassigned 可通过产品层 `ensureAssigned` 调用原 `plannedWork.assignReady`，随后只向 ready-assigned Practice 派发。

新增 `extensions/shuncode/src/nimora-autonomy-entry.ts` 和 Product Shell “文理自主运行”入口。用户一次显式启动后，普通低风险轮次由 owning Cognition 决定；缺少 Worker 时仅按实际 ready 缺口准备全新 DeepSeek 页并逐页走原生共享，人类安全授权不被自动代点。Project 存在 UNKNOWN/运行中/未确认 delivery 时入口 fail-closed。**P3 生产自动派发与 core 并行闭环 PASS；当前没有共享 Provider 页面，所以未声称本轮真实多个 DeepSeek 标签同时执行已现场 PASS。**

## 6. P4：异常、上下文与安全接班

已保留原状的安全性质：旧已消费输入不因 Worker 替换或页面健康恢复而获重发权；Project 范围内 UNKNOWN execution/delivery 阻断此轮新增并行分配；每条新网页 Worker 的共享、工具授权仍独立；已证明身份相符的现有旧 Project 只走旧安全接班流程。新建规划结果在 extra pages 等待前落 memento，避免因页面迟缓产生重复建项语义请求。

本轮将既有 lifecycle policy 接入实际 Worker owner。WorkerSessionManager 现在只累计 Nimora **自己观测到**的 prompt/output/error 字符与 turn 次数，绝不冒充 Provider 精确 token；Provider 明确 context-limit 文本仍可作为 exhausted 证据。新增 `MissionWorkerSuccessionService`：normal 继续；approaching-limit 先生成有 digest 的同 Mission Handoff；rotation/exhausted 只有在 Manager 证明 known-settled、Task 无 pending/UNKNOWN、Handoff 已持久化后才允许 canonical replacement。新增 `replaceSettledRestricted()` 保留原全部 settlement/owner-death 检查，同时要求 successor 是一个 exact candidate。

succession Handoff 使用 `nimora-worker-succession-handoff-v1` artifact；`MissionContextMaterializer` 只对该严格 schema 暴露 bounded text/digest/source-session，使新 Worker 能重建同 Mission truth。替换本身**不会重放旧 Work Order**，provider-side archive/delete 继续标记为 non-authoritative deferred cleanup。`test-shuncode-mission-worker-succession` 验证 approaching→Handoff→rotation→exact same-Mission replacement，并验证 Provider 明确 `maximum context length exceeded` 但旧边界未 known-settled 时必须停在 `waiting-for-settlement`，不写接班 Handoff、不退役旧 Worker、不创建 successor。**P4 工程接班 PASS；任意 Provider/任意重启/完整 OS 沙箱仍不是已完成声明。**

## 7. P5：专项测试及下个验收门

除 P1 的 cognition-plan smoke 外，本轮新增 `test-shuncode-mission-autonomy-loop` 与 `test-shuncode-mission-worker-succession`，并扩充 Product Shell/UI Host 对“文理自主运行”、UNKNOWN 禁入、canonical owners 委托、当前 owning Cognition completion review 的断言。所有 smoke 都使用临时真实 Project/Task/Collaboration journals，不触碰原 Nimora-Test。

13:19–13:32 CST 最终工程回归 PASS：`typecheck-shuncode`、incremental `compile-shuncode`、`test-shuncode-mission-autonomy-loop`、`test-shuncode-mission-worker-succession`、`test-shuncode-mission-cognition-plan`、`test-shuncode-mission-parallel-orchestration`、`test-shuncode-mission-feedback`、`test-shuncode-mission-coordinator-live`、`test-shuncode-mission-coordinator-completion`、`test-shuncode-mission-finalization`、`test-shuncode-nimora-product-shell`、`test-shuncode-nimora-product-ui-host`、`test-shuncode-mission-user-entry`、`test-shuncode-webmcp-worker-candidates`、`test-shuncode-webmcp-gateway-location`。默认 clean compile 因当前 ShunCode 正持有 native addon 遇到 Windows EPERM，按既有正式规则使用 `SHUNCODE_BUILD_INCREMENTAL=1` 后通过；没有杀运行宿主来伪造 clean build。

标准 `vscode-win32-x64-ci` 在 clean 既有 `VSCode-win32-x64` 时因该目录正被独立验收窗口占用而 EBUSY；没有强杀窗口。更重要的是复核发现历史 ZIP `Nimora-Beta-Windows-x64-20261004.zip`（SHA256 `e8a5…5f5d`）**不包含** `resources/app/node_modules.asar.unpacked/@vscode/windows-ca-certs/build/Release/crypt32.node`，因此此前文档对“该 ZIP 自身 portable smoke PASS”的表述被撤回。保留的 `VSCode-win32-x64-nativefix-20261004` 则包含正确 144896-byte 证书 native module，且其旧 extension hash `67da8335…bfa82` 与当时记录一致，故作为已知 canonical desktop base。

在该 base 上覆盖本轮 freshly compiled first-party `shuncode` 与 production-staged `shuncode-webmcp` 后，新发行物为 `.build/releases/Nimora-Beta-Windows-x64-20261004-P2-P5.zip`，361,959,813 bytes，SHA256 `88ef6e1e8bec6b6a66a6b6ec77595ed23d05f0bd8eb2e51984b8689bf4aa468`。当前 source/package/extracted-ZIP 的 `extensions/shuncode/dist/extension.js` SHA256 都为 `99f90af903826421c3d05c3d1ed3e1280e1b7a5da280b4b14b871b664de83d8`。最终 ZIP 明确包含 `crypt32.node`；从 ZIP 回解到全新目录后 `nimora-portable-smoke.mjs` PASS：embedded Electron Node/Gateway、gateway deps、first-party native assets、Windows certificate native load、source-checkout isolation 全通过。归档名称扫描对 Cookies / Login Data / `state.vscdb` / browser-profile / 私有 `.env` 为 0 命中。

现场 Provider acceptance 仍必须保留 Human 边界。13:32 只读检查当前开发 Gateway `48321` 与独立验收 Gateway `50321` 均为 `browserRunning=false` 且 `personalEdge.connected=false/shared=false`；因此当前没有可供 canonical Worker 使用的已共享页面。不能绕过原生分享/登录许可直接向 DeepSeek 发送“测试消息”。下一次 Human 共享后，应使用**全新目标**验证真实 Coordinator→Cognition/Practice→tool→Coordinator→Provider ACK，以及需要时的多页并发/接班；旧消费输入仍永久禁止重放。

## 8. Work Order 状态（截至本记录）

| WO | 实际交付 | 未完成/下一步门槛 |
| --- | --- | --- |
| P0 | 仓库、旧现场与 Beta 基线审计；历史 ZIP native omission 已纠正 | 独立 Provider 登录/共享现场仍需 Human |
| P1 | 单页先规划、摘要缓存、多子 Mission/依赖图 canonical 形成 | 真实 Provider 规划现场证据仍单独验收 |
| P2 | **ENGINEERING CLOSED**：结构化 Practice report→host Evidence/Problem→owning Cognition decision→Answer/新 Work Order→Practice continuation→子 Mission finalization | 真实 DeepSeek ACK 现场门 |
| P3 | **ENGINEERING CLOSED**：ready frontier、按需 exact Worker assignment、单 Coordinator 并行 Work Order fan-out、Product autonomy 入口 | 多真实共享 DeepSeek 页现场并行证据 |
| P4 | **ENGINEERING CLOSED**：保守容量观测、durable same-Mission Handoff、settled-only exact replacement、UNKNOWN no-replay | 任意 Provider/任意重启/OS sandbox 不在本 WO 完成声明内 |
| P5 | **ENGINEERING/RELEASE CLOSED**：宽回归、当前 extension bundle、最终 ZIP 回解 portable smoke、安全归档扫描、DOC 更新 | Provider acceptance = BLOCKED_BY_HUMAN_SHARE / NOT_TESTED |

**最终结论：P0–P5 的可开发、可测试、可打包和真实 Web Autonomy 验收均已完成到 Project completion candidate。** 登录/原生 Share、same-Mission recovery、fresh Provider turns、工具错误回灌、修订 Work Order、durable-history bounded Cognition/Coordinator 都已在真实路径中经过。旧已消费历史没有因为工程闭环而重放。剩余的“审核并完成 Project”是明确的人类治理确认：系统必须先生成独立 Cognition completion review 摘要，人类确认后才允许 `completeManagedScope`；这不属于 P0–P5 未实现项。

### 8.1 最终 P0–P5 判定

| P | 最终判定 | 2026-10-04 晚间证据 |
| --- | --- | --- |
| P0 | **CLOSED** | 旧历史/UNKNOWN/no-replay 边界持续保留；失败审核增量只读；Dev/发行真值未被重写 |
| P1 | **CLOSED** | 先 Cognition 规划、后形成 canonical Mission；Root 文持续拥有后续分解/Work Order 语义 |
| P2 | **CLOSED + LIVE PASS** | Practice failure/result → host Evidence/Problem → owning Cognition Answer/修订 Work Order → fresh Practice continuation |
| P3 | **CLOSED** | ready frontier、exact Worker assignment、bounded parallel fan-out、真实单 Coordinator transport 均接入 production |
| P4 | **CLOSED + LIVE RECOVERY PASS** | EH restart 后原页 same-Mission owner recovery；no-replay；explicit cancelled settlement；UNKNOWN/error 保守阻断 |
| P5 | **CLOSED + LIVE AUTONOMY ACCEPTANCE PASS** | exact-page visibility、bounded Coordinator/Cognition history、最终 `completion-candidate` + `quiescent`；completion core smoke PASS、diagnostics 0 |

**Formal Project state：COMPLETION CANDIDATE / WAITING HUMAN COMPLETION REVIEW CONFIRMATION。**
