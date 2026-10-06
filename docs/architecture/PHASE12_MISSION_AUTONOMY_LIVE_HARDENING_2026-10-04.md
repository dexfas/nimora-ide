# Phase12 Mission Autonomy · 真实 DeepSeek 闭环加固记录（2026-10-04）

> **最终晚间更新：P0–P5 工程链与真实 Web Autonomy acceptance 已闭合到 Project completion candidate。** Practice 的真实 capability failure 已按 failed+delivered 形成 host-derived Evidence + Problem，owning Cognition 随后生成 fresh Answer / 修订 Work Order；同一 Practice 接收并执行了后继 fresh input，旧 input 没有重播。现场继续通过了 exact-page visibility 收敛、Extension Host 重启后的原三页 same-Mission owner recovery、历史失败 orphan-only 审核、`cancelled` terminal settlement、non-blocking Problem 持久化、Coordinator/Cognition durable-history bounded projection。最后一轮产品 `Run Web Autonomy` 在大量历史事实存在时正常停止于 `completion-candidate` / `quiescent`，未再出现 48k Coordinator prompt 或 24k Cognition instruction overflow。

> **状态：SOURCE / FOCUSED REGRESSION / LIVE AUTONOMY ACCEPTANCE PASS；formal Project finalization WAITING HUMAN CONFIRMATION。** 这不是工程 blocker：产品有意要求独立 Cognition completion review 先产生审核摘要，再由 Human 点击“确认完成 Project”。本文不把该治理确认伪装成 agent 已执行；任何 UNKNOWN、历史失败或已消费 Provider input 仍没有被重放或改写为成功。

## 1. 本轮实际证明到哪里

沿用原 Project `774ec5e8-835c-4239-829f-a5c70b0f7a40`、原 Cognition Mission `6882f1fc-98c4-4228-918f-4bff780a7fb5`、Coordinator Mission `7fa7e64e-7bc3-47cc-b3fa-716a5174b52d`、Practice Mission `9eb0182e-dfe2-46b3-bced-407561b08609`，通过同 Mission fresh Worker replacement 进行实际 DeepSeek 运行。

本轮 live 已真实观察到：

- Cognition 的实际 Provider prompt 不再包含 WebMCP 工具教程；它以 tools-free 普通响应返回严格 `nimora-cognition-decision` JSON。
- Cognition 收到 canonical capability catalog 后，不再猜 `read-file`，而是实际选择 `workspace.list-directory`、`workspace.read-files` 等真实 semantic id。
- Coordinator 的 host-bound exact command 在单个 host capability result 被确认送达后即可机械 `completed`；不再等待一段没有语义权威的 Provider follow-up prose，也没有出现第二个 tool call。
- Practice 在真实 DeepSeek 页中执行了 `list_directory`、`read_files(需求.txt)`、`report_progress`，TaskRuntime request/result/delivery 全部持久化；同一 Practice Worker 从 `https://chat.deepseek.com/` 自动演进到 `/a/chat/s/<conversation-id>` 后继续后续工具调用，证明 persistent Worker conversation lineage 可以安全延续。
- 该 Practice turn 形成了 host-derived durable Evidence：`autonomy:evidence:v1:818c3cbf59e44d28567faf11e2bf4145b02bc843551ba7aede554ab51b703c68`，创建于 `2026-10-04T07:13:52.918Z`，引用 completed turn `nimora-worker-turn:345d9cd7-0cb9-4ec4-8e10-435c7c433827`，记录 3 个 host executions；Finding/relations 随后写回 owning Cognition。

因此，**文→Coordinator→理→Reality Evidence→文** 已不再只是 core smoke；至少一轮真实 Provider/host/tool/Evidence 路径已经现场发生。尚未完成的是这些后续 hardening 全部装载后的最终无错误收敛与 Project completion review。

## 2. Live 暴露并已修复的工程缺口

### 2.1 Cognition 不应猜 capability id

`MissionAutonomyLoopService` 现在把 `capabilityRegistrySnapshot()` 的 canonical id / risk / approval / openWorld 元数据写入 bounded Cognition prompt。`requiredCapabilityIds` 只能从该 catalog 选择，不能缩写、alias 或创造 id；catalog 只说明标识与 policy 元数据，不自动授予权限。

### 2.2 Coordinator 的机械完成边界

Coordinator WorkerInput 新增 host-only `terminalAfterHostCapabilityResult`。仅当它是 exact host-managed 单 capability turn、已有一个 capability call、host result 已确认送达、无 pending delivery / pending host capability 且 Provider 不在 streaming 时，WebMCP 才机械 terminalize。普通 Practice 工具回合保持原稳定文本/工具生命周期规则。

这维持了角色原则：**Coordinator 运输/执行已经授权的命令，不需要 Provider 再生成一句“我完成了”来获得新的语义权威。**

### 2.3 DeepSeek conversation URL 是同 Worker lineage 的一次性 canonical 演进

fixed browser control 的 send/poll 结果现在返回 page-proven `controlLineage`。Transport 仅接受同 `pageId/sessionId/site/origin` 下的 DeepSeek 初始演进：`/` 或 `/chat` → `/a/chat/s/<conversation-id>`；接受后立刻把新 href 写回当前 runtime session authority。之后下一次 send 仍执行 exact-href 双重校验，若再跳到另一个 conversation 则 fail-closed。

这修复了“第一轮成功后 DeepSeek 自动生成 conversation URL，第二轮却被永久旧 href 拒绝”的持久 Worker 缺口，同时没有放宽 conversation substitution 防线。

### 2.4 DeepSeek Provider 写入必须由 extension-host 全局节流

新增 `deepseek-provider-write-gate.js`：所有 DeepSeek `send` 与 host result `resolve` 共用 extension-host FIFO，而不是每个网页各自 sleep。默认不同 Provider 写入起点至少间隔 6 秒；若明确识别“消息发送过于频繁 / too many requests / rate limit”，仅为**未来独立授权的写入**记录 30 秒 cooldown，并把 cooldown / last-start 写入 globalState。失败的原写入绝不自动 retry，因此不破坏 UNKNOWN / no-replay 法则。

### 2.5 Autonomy Evidence 可以证明 Practice 已收敛，不能伪造旧 reviewed dispatchIdentity

fresh Worker replacement 现在可以在旧 reviewed takeover projection 落后时，验证一个更新的 `autonomy:evidence:v1:*`：Evidence digest、exact target input、唯一 completed worker turn、Task executions/session/result identity、zero duplicate、全部 delivered、Evidence 之后无新 execution、历史失败审核均须一致。满足时只把它当 canonical Reality proof；**不重写或伪造旧 `dispatchIdentity`。** 若证据不完整仍回落到原 reviewed gate 或 fail-closed。

### 2.6 `finalizeMissionIds` 只能来自明确 child allow-set

真实 Cognition 曾在“项目看起来完成”时把 root/Coordinator 一起放进 `finalizeMissionIds`。原 host preflight 正确拒绝，但 prompt 契约不够明确。现在每轮计算 `finalizableMissionIds`：仅当前 scope 内非 root、非 Coordinator、未 terminal 的 child Mission。Cognition 的 `finalizeMissionIds` 必须是其子集；若集合为空必须返回 `[]`。Project 完成只能表达为 `projectCompletionCandidate=true`，随后继续受正式 managed-scope completion gate 检查。

host 侧原有“root/Coordinator finalization 一律拒绝”仍保留；系统没有通过静默删除非法 id 来替模型纠错。

### 2.7 fresh replacement 的 single-flight 必须覆盖第一次人类确认窗口

最新现场还发现 Product replacement 的 `reviewedTakeoverInFlight` 原先在**第一次 modal 确认之后**才设置。两个快速重复入口可以同时通过初检并等待人类确认；第一个推进 durable state 后，第二个把该真实变化误报为“授权期间 Project 或工作区已改变”。

源码已将 single-flight reservation 前移到整个 replacement lifecycle 开始处，并由外层 `try/finally` 覆盖 eligibility、第一次 consent、逐页 Share、第二次 owner-mutation consent 和三角色 attach；取消/错误仍释放锁。此修复已 typecheck，通过原 fresh replacement smoke，但当前正在运行的 Dev Host 尚未 reload 这一最后源码改动，因为 live replacement 已进入 partial checkpoint，不能为了热加载而丢掉已批准页。

## 3. 当前 live checkpoint，不冒充最终通过

16:46–16:48 CST 的最新 replacement attempt 为 `0b44ae2f-4890-470f-a959-23add68b4ce3`：

- `phase = replacing-new-workers`
- `nativeApprovedPageIds = [89708241-0cd2-42e0-8ae4-a5e1a1673633]`
- `assigned = {}`，所以**尚未发生任何 canonical Worker owner mutation**
- previous Coordinator / Cognition / Practice session 分别仍为 `790f07ef-c4c2-4346-bc25-e2a8be2bcec3` / `748a902d-fc66-4f7d-918c-4c7bf092ff8b` / `7dce14ae-8720-4e8b-b4ad-8a1d1670500a`

当前原生 `ShunCode Dev` 信息框是前述重复 replacement 请求留下的错误提示；Extension Host 日志在 16:48 记录两次 `授权期间 Project 或工作区已改变，未打开网页。`。平台安全层拒绝 agent 再自动点击该 Windows 原生 `OK` 控件，因此本轮没有绕过它、没有重置 partial checkpoint、没有重启宿主来伪造“恢复”。用户关闭该只读错误提示后，应从同一个 `replacing-new-workers` attempt 继续 canonical resume；不能新建重复 attempt 或重放历史 Provider input。

## 4. 最终 focused regression（本轮源码）

以下命令在最新源码上退出 0：

- `typecheck-shuncode`
- `node scripts/shuncode-reviewed-fresh-worker-replacement-smoke.mts`
- `test-shuncode-mission-autonomy-loop`
- `test-shuncode-deepseek-provider-write-gate`
- `test-shuncode-webmcp-fixed-control`
- `test-shuncode-webmcp-command-transport`
- `test-shuncode-webmcp-browser`
- `test-shuncode-mission-coordinator-live`

其中 autonomy smoke 明确覆盖 bounded Cognition correction、parallel Practice fan-out、host-derived Evidence、Problem→owning Cognition→Answer→revised Practice、child finalization 和 root completion gate；Provider gate smoke 覆盖 FIFO spacing、rate-limit cooldown 与 zero automatic replay；WebMCP tests 覆盖 exact fixed control、canonical href progression、conversation substitution rejection、Coordinator single host-result terminal semantics及原发生命周期负例。

## 5. 仍需完成的唯一现场链（已完成，以下为历史计划）

当前不能声称“最新全部修复后的 Phase12 live acceptance PASS”。恢复同一个 partial replacement 后，需要：

1. 核实已批准的新页并补齐剩余两张 fresh DeepSeek 页；
2. 通过现有第二次明确 consent **仅替换 Worker，不发送任务**，完成 Coordinator→Cognition→Practice canonical attach；
3. 以全新 Cognition round 运行 `文理自主运行`，确认最新 `finalizableMissionIds` 契约在真实 Provider 中生效；
4. 观察 Cognition→Coordinator→Practice→Evidence/Problem→Cognition 的新一轮收敛；
5. 若 Cognition 提出 `projectCompletionCandidate`，再走正式 completion review；不得用 child-finalize 或 Coordinator 自己代替 Project completion authority。

上述 1–5 项均已在晚间继续工作中跨过：三角色 canonical owner 已在原页面上恢复；fresh Autonomy 重新启动；Practice failure → durable Evidence/Problem → Cognition Answer/修订 Work Order → fresh Practice continuation 已真实发生；`finalizableMissionIds` 继续保持 child-only；Owning Cognition 最终提出 `projectCompletionCandidate` 并因没有更多 Work Order 进入 `quiescent`。

## 6. 最终 live hardening：重启恢复、页面可见性和 no-replay

### 6.1 settled Mission restart recovery

Extension Host reload 后，旧 durable Worker owner 不再被误当作当前 live owner。通用三 Mission recovery 只在以下事实全部成立时允许把**原 DeepSeek 页面**重新绑定给新 Host：Project/Root/Coordinator/Practice identity 精确一致；旧 owner 由机器证明已死亡；Task interaction/execution/result delivery 全部 terminal+settled；原 pageId/resourceIdentity/pageSessionId 唯一且仍是同一 provider-native 会话；页面 turn 不再 running。

恢复动作只产生旧 Worker retire + 新 Worker attach，不重建旧 input、不重执行工具、不重发 Work Order。历史 `failed + delivered` execution 可以通过 orphan-only read-only review 更新 failure digest；`requested/executing/unknown/pending delivery` 仍 fail-closed。

### 6.2 exact-page visibility convergence

真实恢复后的第一轮 Autonomy 曾在发送前被 `did not become visible after exact-page activation` 安全门拒绝。根因是旧实现 activate 一次后立即 re-list 一次，没有给 integrated-browser visibility state 有界传播时间。

`ensureExactSharedBrowserPageVisible()` 现改为 2.5 秒总预算 / 100ms poll 的 exact-page 收敛：只观察同一 pageId；每次 fresh re-list 都重新检查 URL/origin；page disappearance、URL/origin drift 立即失败；只有同一 exact page 真正 `visible=true` 才进入 provider mutation。没有 fallback 到“当前可见页”或第二次 provider gesture。

修复后真实 Autonomy 已越过该 gate，Cognition completed、Coordinator/Practice 实际进入新 turn，并产生新的 Task executions。

### 6.3 Provider `cancelled` settlement

旧 WorkerSessionManager 只有 `completed` terminal 会移除 `unsettledReplacementSends`，导致 provider 已明确 `cancelled`、无 pending capability、无 delivery uncertainty 的旧 turn 仍永久阻塞新的 Work Order。

现在仅增加 `cancelled` 为 explicit settled terminal；`error` 仍保持保守 UNKNOWN/fail-closed。专项 succession smoke 新增 cancelled 正例，并保留 provider error/UNKNOWN 反例。live 复验确认上一轮 cancelled 后，新 fresh Practice input 可以继续发送；旧 cancelled input 没有重播。

## 7. durable collaboration 与历史膨胀收口

### 7.1 non-blocking Problem 不是 Finding

`MissionCollaborationStore` 的 `informs` relation 只允许 Finding basis。Autonomy 原先把 `blocking:false` Problem 也强行建成 `informs`，真实 live 因契约不匹配停止。现在：

- blocking Problem → durable Problem exchange + `blocks` relation；
- non-blocking Problem → durable Problem exchange，本身可被 Cognition 读取，但不伪造 Finding-backed relation。

专项 Autonomy smoke 已加入 non-blocking Problem 正例。

### 7.2 Coordinator history projection

Coordinator 的职责是执行一条 host-bound semantic command，不需要把整个 durable collaboration graph 重新灌给 Provider。旧实现把完整 `inspectManagedScope()` JSON 塞入 prompt，真实历史累积后达到 59,499 chars，超过 48,000 上限。

`buildMissionCoordinatorWorkerInput()` 现在只投影：Project/root/Coordinator identity、总 missions/relations/exchanges 计数、当前 semantic command 直接引用的 Mission/Exchange 及其必要 relation。Host 内仍保存 original exact command 作为唯一执行 authority；projection 不是语义重写。压力回归用 600 exchanges + 600 relations 证明 prompt 仍低于 48k，未引用历史不进入 Coordinator prompt。

### 7.3 Cognition bounded working set

随后 live 暴露第二个长期上下文问题：完整 durable exchanges 逐条进入 Cognition instruction，超过 24,000 chars。现在每个 Cognition round 获取：

1. bounded Mission status/goal/completion criteria；
2. 全部未回答 Problem（最多 16，超过则要求更高层 reconciliation）及其必要 Evidence；
3. 最近 12 条相关 exchange，并带必要 reply/evidence；
4. Evidence 只传 bounded summary + identity，不传完整命令输出/引用正文；
5. durable history 总量/selected/unresolvedProblems 计数。

完整历史仍保留在 canonical store，不因 prompt 压缩而删除。80 条 × 2,000 字符历史 Finding 压力测试证明所有 Cognition input 均保持 <24,000。

## 8. 最终真实结果

最后一轮产品 `Run Web Autonomy` 在上述修复装载并完成 owner recovery 后正常运行。Workbench 产品通知明确显示：

- **Owning Cognition 已提出 Project 完成候选**；
- **自主循环结束：quiescent**；
- 原因：**Owning Cognition emitted no further Work Orders**。

这意味着 P0–P5 所要求的真实产品链已经从“源码存在”推进到：恢复后的真实 Web Worker、长期 durable feedback、错误回灌、修订 Work Order、history-bounded Cognition/Coordinator 和 completion candidate 全部处于同一生产路径。

完成链核心 smoke `shuncode-mission-coordinator-completion-smoke.mts` 退出 0，覆盖 explicit completion readiness、可信 terminal 后 Coordinator/root death 与 partial-crash recovery。最终 ShunCode diagnostics = **0 error / 0 warning**。最新 `mission-autonomy-loop` smoke 也退出 0，明确覆盖 bounded Cognition correction、parallel Practice fan-out、settled capability-error → durable Problem/Evidence → fresh Cognition decision without replay、child finalization 和 root completion gate。

## 9. 剩余边界不是工程缺口：Human completion confirmation

Product Shell 当前在 active Web Project 上提供 **“审核并完成 Project”**，实际调用 `shuncode.nimora.reviewProjectCompletion({projectId})`。该路径仍先：

1. 机械检查唯一 root / Coordinator、Worker identity 和 Provider settlement；
2. 通过 exact Coordinator command 给 owning Cognition 发送 `project-completion-review`；
3. 只有 Cognition 返回可信 `completed` terminal 和有界审核摘要后，才向 Human 展示摘要；
4. Human 点击“确认完成 Project”后才执行 `completeManagedScope`，归档 root/Coordinator/所属 Worker 并保留文件、Handoff 和历史。

本轮没有替 Human 盲点最终确认。故当前结论是：

> **P0–P5 ENGINEERING CLOSED / LIVE AUTONOMY ACCEPTANCE PASS / PROJECT COMPLETION CANDIDATE REACHED.**
>
> **Formal Project finalization = WAITING HUMAN REVIEW + CONFIRMATION BY DESIGN.**
