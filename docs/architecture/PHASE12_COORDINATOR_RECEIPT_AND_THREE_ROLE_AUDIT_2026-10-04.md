# Phase12 · Coordinator 回执未确认防复发与三页分工实测（2026-10-04）

## 1. 本次真实事故，不能把网页“停止打字”当结案

核实对象仅为**原隔离 Dev profile 的原 Project**：Project `774ec5e8-835c-4239-829f-a5c70b0f7a40`，原 Cognition/root、Coordinator、Practice 三条 Mission 均保留。04:22 的原 WebMCP Extension Host 日志直接记录 `workerResolveCapability → sendToolResult → waitForDeepSeekProviderAdmission` 因 `provider-conversation-boundary-missing` 失败；Nimora 已保存 Practice 的 `terminalStatus=error` 和**单独**的 `coordinationFailure`（带精确两输入 ID），没有重发。随后04:23多次点击历史核实，在原 `assertReviewedReadContinuation` 中因 `isKnownSettled` 不成立被拒绝，旧提示误导为“Provider 仍运行或结果未收敛”。

同一 profile 的只读 SQLite+原 JSONL 审计证据：原三条 Mission 的 workspace 工具执行分别为 Cognition **3**、Coordinator **0**、Practice **47**；全 profile 52 个 TaskExecutionRequested/Started/Finished/ResultPrepared/Delivered 一一对齐。**TaskRuntime 的 Delivered 指本地工具结果已投递到宿主记录，不是 DeepSeek 已确认收到 Coordinator 的最终回执。**旧已消费输入、既有失败、`coordinationFailure` 与原真实产物均不得删除、伪造成 completed 或重播。

原隔离 Dev 的只读 CDP 页面状态：Coordinator 的 DeepSeek 对话 `workerTurn.state=cancelled`，pending host capabilities/deliveries 都为0，但 `lastDeliveryError` 仍是该边界错误；Practice 页同样为 cancelled、其原始发送 admission 已确认；另一 DeepSeek 首页 `workerTurn=null`。原 Coordinator 失败现场 admission 诊断显示 baseline 1 个稳定历史用户消息，而最新虚拟列表呈2个稳定用户消息、0个助手候选，**符合**助手历史气泡在结果提交时从虚拟 DOM 移走的场景，但现场不能独立证明虚拟化是唯一原因。此页面观察**不足以反推最后的 Provider 工具结果有没有被接收**，只能断言旧原生回执未确认，故旧 Manager 保留保护。工具结果可见和完整业务验收也须分开。

## 2. 源码修复与安全边界

- `extensions/shuncode-webmcp/webmcp-site-adapters.js`：只有原虚拟助手 tail 消失时，才允许改用**仍渲染且全文完全未变的最近历史用户消息**作退化锚点；origin、pathname、新用户消息唯一性、真实精确文本等 admission 检验不降级。不存在可靠原用户锚点时仍保留 admission 未确认；绝不按屏幕上有消息、超时或 URL 不变就猜测“已送达”。
- `extensions/shuncode-webmcp/arena-agent-bridge.js`：原结果回传遇到无法确认的 Provider admission，原 turn 终结为 error，记录精确原 `inputId/callId/occurrenceId` 的 `resultDeliveryUncertain`，留存 pending host 请求并暴露只读状态。此后本页直接拒绝任何新 Provider send；旧结果不能因重试 ACK 就重复触发一次 submit。旧实现兼容检查新增两个标识，以防保留页悄悄继续使用旧实现；真正旧页工作未收敛时不能强行替换其 runtime。

  进一步防复发：原不确定结果的**身份（不含输出）**写入该标签自身 `sessionStorage`，同一 DeepSeek 标签意外刷新后仍拒绝新 send，跨源码版本重注入时遇旧 runtime 的 `lastDeliveryError` 或 `resultDeliveryUncertain` 也拒绝悄悄覆盖未知历史。此状态不是自动恢复许可；旧页面可能发生人为清除存储等异常，因此 canonical Task/Worker 层仍有独立的 UNKNOWN 和唯一身份约束。
- `src/worker-session-manager.ts`：保持 `isKnownSettled` 的严格规则（idle、无租约、无清理、无待回传结果、无不确定旧回执）**完全不变**；新增 lock-consistent 只读 `inspectSettlement`，把事实拆分给 UI，绝不清空未知租约或把 error=completed。
- `nimora-reviewed-read-continuation.ts` 与 `nimora-reviewed-practice-entry.ts`：strict 正常发新请求仍需原有一切执行、权限及 Provider 完成证据；单独新增只有**原 Practice error + 与已消费输入精确对应的 coordinationFailure + 人工核实失败能力**才可访问的历史本地事实审核，可接受 live 或 orphan 的已知 Owner 形态但只读，不是新请求准入、不修补原回执、不自动移交 Worker。
- `extension.ts` 和 `nimora-product-shell.ts`：保留旧请求已消费、将最后一次本地工具结果审核与上游 DeepSeek 确认明确区分；协调回执未确认的项目面板不再把“继续执行 Mission”作为默认下一步，而是提供**仅查看回执/三个角色结案诊断**。诊断只读取当前三个持久已分配 Worker 的 lock-consistent Manager lease/pending/UNKNOWN 和原生页面 health，无法推断时显示 unknown。只有人工单独审核历史事实与通过安全 Worker 恢复/替换后，才能再次发**新的**已审核输入。

源码验收：新隔离 Edge 回归 `scripts/shuncode-webmcp-coordinator-result-boundary-smoke.mjs` 对旧助手 DOM 重挂载正确返回、全部历史锚点全失时 fail-closed、新输入阻断、无二次提交和**同标签刷新后仍隔离旧回执**均 PASS；原完整 WebMCP 浏览器 smoke、旧 READ/Practice smoke、Worker manager smoke、同名 occurrence/ACK-lost 二次执行保护、历史虚拟列表 Edge smoke、UI Webview Host、TypeScript typecheck 与 extension-only build 均通过。仅代码测试，**不是本次原未知 Provider 回执被真实修复或已通过新输入验收**。

## 3. 三个 DeepSeek 页面：架构上协作不是三个页面同时写代码

真实输入接入见 `src/mission-user-entry-application.ts`：严格解析原 Project/三个 Mission 已分配 Worker 的当前持久和 live Session、确保无 UNKNOWN 工具，然后**发 Coordinator 一次新的语义命令** `deliverExplicitMissionInput`。Coordinator 通过协调 driver 把确切 `targetMissionId/targetSessionId/inputId` 指向 Cognition（读取和需求分析）或 Practice（实现/测试），观察 Target 的结果，再回传并收尾。Coordinator **不是**一个具有工作区工具的“第三个同时写文件者”，工具计数0属于其角色和特意限制；Cognition本轮3次READ，Practice本轮47次工作区工具，显示有真正的任务分层和权限边界。第三页在本轮执行中空闲也是可能的正常编排结果。三个独立的 durable Worker 并不意味着三个网页同一时刻全忙。

但**“端到端分工已可靠实现”尚不能验收通过**：已有真实 Coordinator→Practice 的路由和后者工具执行，最后 Coordinator→DeepSeek 的 Provider 回执/最终收尾恰恰在本次事故中未确认。不能用架构存在、三个 Worker 已分配、52/52 本地投递、Practice 有输出代替最终跨页收尾成功或 root Mission 完成。需要在原项目上安全核实失败、对账旧 Provider 会话、进行人类授权的新输入，观察完整 Coordinator 路由→Target 工具→Coordinator 回执和最终关闭，才能正式判定这条端到端能力 PASS。若用户的产品目标是三个页面**真正并行研究/写代码/相互评审**，则属于尚未实现且需要另立工作单的并行编排设计，不能把当前协调+认知+实践的按需路由冒充成并行。

## 4. 原现场恢复原则和当前未完成项

此次源代码修复**不直接清理旧动态会话或原生 DeepSeek 标签**。原事故保存的 `coordinationFailure` 不能覆盖；52/52本地 TaskRuntime 不代表 Coordinator 上游 ACK。先经产品新“本地工具事实审核”和“只读结案诊断”双入口核查仍未收敛的是哪个 Owner lease/pending/UNKNOWN；必要时在原宿主确实死亡、旧页面隔离且审核证据齐全后，用户对**同一 Project/Mission 的新 Worker**执行显式 replacement（严格机器死亡证明、无需新 Project、不重播旧输入）。未经新用户确认、旧 Manager/provider 现场审计和真实无 active/UNKNOWN 证明，不对当前 Dev 强行 reload/reinject，也不擅自授予写入/终端权限。

**当前已接通的源代码恢复动作：** 当存在确切的原 Coordinator `coordinationFailure`，旧原生“恢复原三个网页”命令和继续 Cognition 的直接入口均严格拒绝**复用旧 Coordinator 对话**，绝不因其显示 cancelled 就清理回执。若仍有任一原 live Worker，会显示只读诊断而非替换；等用户单独核实历史失败、原宿主确实结束并且所有三角色不再由当前进程持有后，Product Shell/原生操作菜单才显示“旧宿主退出后，审核全新三页 Worker 接班”。真正进入前仍须原三张页面不在共享资源清单，复核原本地 Task 事实和完整三角色历史、两次人类确认，底层逐个证实机器原 Owner 已死亡，每一步持久 checkpoint。**仅在三个全新 Session 全部绑定成功后**，才将旧 `coordinationFailure` 完整归档在 durable `replacement.previous.coordinationFailure`，并清空本代新 Worker 的协调故障标志；失败中途保留原故障及 partial assignment，禁止点按钮重试。旧 `dispatchIdentity`、原失败和输入消费记录继续保留。此入口代码及 UI/三页替换/READ/Practice 回归、typecheck/bundle 已通过，但尚未执行本次真实旧现场的历史审核或新三页迁移。

**状态：Phase11 已验收内容不变；Phase12 Coordinator→Provider 回执与本次原事故安全恢复仍 OPEN。**

## 5. 2026-10-04 同一原 Dev 的安全恢复预检（原会话尚未关闭）

用户批准继续**取证、核实和准备安全接班**，但仍须分别批准原生新页面共享及正式 Worker 接班。本次所有源系统观察均为只读，未自动执行原历史审核按钮、关闭标签、关闭 Dev、发送 Provider 请求或修改 canonical Journal。

新增仅写入忽略目录的原现场快照工具 `.build/phase12-current-takeover-20261002/phase12-safe-recovery-preflight-20261004.mjs`，实际取证文件同目录 `phase12-safe-recovery-preflight-20261004.json`。它通过 SQLite `readOnly` 捕获**精确原 Project** 的原 memento、三个当前/旧 Worker 身份及未确认回执，记录整个隔离 Profile 的七条 Task JSONL 的逐文件哈希、全部原 Extension Host/诊断日志 41 份文件哈希，并读取测试目录三个实际交付文件的 SHA256；绝不通过重放任务来产出证据。按真实 `TaskExecutionRequested.payload.execution.executionId` 对照 `TaskExecutionDelivered.payload.executionId`，发现全 Profile **52/52 精确一一匹配、无多投漏投**；本地 TaskRuntime 结案并不能证明 Coordinator 上游 DeepSeek 的最终回执。

关键新增事实：原 Cognition 有 3 次完成的工具执行、Coordinator 0 次、Practice 47 次；Practice **现有七次失败**（均有本地投递记录），而旧 `failureReview.failureCount=6` 已经过时。第七次失败属于已消费的原 Practice input 的 `get_command_output`，本地错误为 `Unknown command_id: cmd_1`。不能沿用旧审核指纹、隐藏新增失败或改变原 `coordinationFailure`。下次产品正常加载后须重新审核**七条**，且审核弹窗必须使用原任务快照和同意前后的精确 digest 双重检查。

CDP **仅观察**到旧的三个 DeepSeek 标签仍属于当前隔离 Dev：Coordinator `workerTurn=cancelled` 且保留 `provider-conversation-boundary-missing`，Practice `workerTurn=cancelled` 且原始发送 admission 已确认，第三页 `workerTurn=null`；三个页面的当前 pendingHostCapabilities 和 pendingDeliveries 均为 0。这不能证明旧 Coordinator Provider ACK 已确认，也不能单独证明其他网络工作完全停止，因此没有启动任何热重载或旧 Provider 重发。

修复一处新的接班体验缺陷：上一版本的产品历史审核在新的 Extension Host 中仍默认索取原有的三个**实时内存会话**，导致正常重启后可能再次拒绝审核七条历史失败。现在产品执行同一原状态的审核时，只有三条旧 Session 在新宿主中**全部**不存在，且三个 Mission 的 live Session 清单全部为空，才能自动选择原本已有的 **orphan-only READ-ONLY history review** 门禁；只要任何旧 Session 部分存在，就仍须以 live 条件检查并 fail-closed。新增对实际 `reconcileReviewedPractice` UI callback 的执行回归：旧审核指纹覆盖1个而实际有2个失败时，重启后的 orphan 历史核实会准确显示2个、两次门禁一致并仅更新失败审核记录；原 Coordinator 不确定回执不变，且没有发送新输入；部分旧 Session 残存的反例拒绝审核写入。该 1→2 回归是隔离模拟，真实原项目的 6→7 须由本人完成正式人工确认。

准备了**当前不会执行**的受保护启动脚本 `.build/phase12-current-takeover-20261002/phase12-safe-relaunch-original-dev-20261004.ps1`，它只在原隔离 Profile 完全没有 ShunCode 进程且调试端口 49362/49363 全部停止、原快照存在时，才重启原 `.build/electron/ShunCode.exe` 使用原 Profile/扩展/测试工作目录。实际运行 `-PreflightOnly` 结果是 `BLOCKED: original Dev still has 14 process(es) or 2 debug listener(s)`，因此**没有启动第二个实例，也没有终止旧进程**。扩展最新代码已重新通过 READ/Practice、三新页 replacement、Product Shell、typecheck 及 extension-only bundle；仅代表磁盘构建，不代表旧 Dev 已加载，更不代表 WebMCP 页面 runtime 已实际换新。

**接下来需要人手交界：** 用户先保存正在编辑的文件与任何未发送网页草稿，在**仅原隔离 Extension Development Host** 中正常关闭旧三个 DeepSeek 内置标签，然后正常退出这个 Dev 窗口；不要关闭日常 ShunCode 主窗口或删除原测试目录。收到确认后，重新运行同一启动脚本前必须复核旧进程和两个端口均归零，使用原 Profile 启动；通过正常 Nimora 产品入口对七项真实失败做人工历史审核，然后在旧网页身份确实从原生共享清单消失时，逐页申请共享新的三张 DeepSeek 页面，并经两次产品确认、精确资源身份、机器死亡证明和逐角色持久 checkpoint 执行接班。该流程只保留原 Project/三 Mission，原已消费输入不能重播；之后全新任务的独立人类权限授权和完整协调收尾才是最终 Phase12 验收。旧 Dev 当前仍运行，故此阶段明确 **未执行上述后续动作**。

## 6. 2026-10-04 10:09 CST — 用户已关闭旧窗口，修复版真实启动，七项审核弹窗等待用户

上一节是当时的预检历史，**已由本节的新事实接续，不得将上一节“旧 Dev 仍运行”当成当前状态**。用户明确回复「已关闭」后，现场实测原隔离 profile 的 ShunCode 进程 **0**、调试监听端口 **0**、原取证文件仍存在；只读原 SQLite 对照原快照，Project/三 Mission 当前 Session ID、原协调失败和旧六项审核均完全一致。受保护脚本已修正为先清理 MCP 继承的 `ELECTRON_RUN_AS_NODE` 等 Extension Host 环境变量，再通过**仓库原生 `scripts/code.bat`**，沿用原 `nimora-live-e2e-20261002b` profile 和原 `Nimora-Test` 文件夹真实启动，仅一个 `[Extension Development Host]`。10:05 的新 EH 日志证明 `shuncode.shuncode` 与 `shuncode.shuncode-integrated-browser-bridge` 已激活；尚无本轮新 Provider 请求。

窗口恢复器额外自动带回了**恰好一张旧 Coordinator DeepSeek 页面**：与事故取证完全一致的 URL path `/a/chat/s/2d7269e2-365b-42b3-830f-4cabda8bef38`。在精确隔离 Dev CDP 中同时验证：确实只有这一个 DeepSeek 页、原工作台只有 Welcome 编辑器标签、该旧网页**没有任何未发送输入草稿**；由于它是独立集成浏览器页而不是 Workbench 编辑器，按同一旧页精确 path 只关闭**这一张**（正常页面关闭，runBeforeUnload 开启），随即再次确认 DeepSeek 页面 **0**。没有刷新、续发或重新注入这张旧 Coordinator 页面。

在同一 Dev 的正常 Workbench 命令面板执行 `Nimora: Open`，得到一个由本轮 EH 创建的唯一 Nimora Product Shell。之后通过官方 `Nimora: Web AI Worker Status & Tool Ownership` 入口，原生操作菜单**真实显示原项目**「核实本地执行事实 · 个人任务管理器项目」及「只读诊断 Coordinator 未确认回执」；点击**审核入口**只打开确认框，没有批准。最初 CDP 无法观察 `.monaco-dialog-box`，随后 Win32 **只读窗口枚举**证明同一原 Dev PID 下确实出现独立的前台系统对话框 `ShunCode Dev`，有「仅保留历史执行事实」和「取消」两个原生按钮。这不是按钮无反馈或业务 preflight 失败，而是原生系统模态确认窗口，等待**用户本人审核七条**并点击确认。

10:09 的最后只读复核：旧 `failureReview.failureCount=6` **仍未改动**、`coordinationFailure` 仍存在、`phase=mission-sent`、真实 Practice 七条失败仍全部本地投递且全隔离 Profile 52/52 executionId 精确匹配，当前 Provider 标签仍是 **0**。**尚未发生七项人工审核、机器死亡证明下的三角色新 Worker 替换、新三页共享或任何新输入。**下一步仅由用户看清原生确认框的七条失败（新增一项为旧 `get_command_output` 误用 `cmd_1`）后，亲自点「仅保留历史执行事实」，助手再只读核验现有持久审核从6更新为7且 `coordinationFailure` 保持不变。随后经原生菜单查看旧宿主隔离状态、申请全新三页逐张共享和两次独立人类确认，禁止跳过任何保护。

## 7. 2026-10-04 11:46 CST — 七项审核已确认，三张全新 DeepSeek Worker 已真实完成接班

用户完成原生「仅保留历史执行事实」后，原 SQLite 只读核验显示 `failureReview.failureCount` **6 → 7**，新 digest 为 `6a7141a016e7cf12a1fb42d7546b50634cc0867ebc9350cba774622fd2fe1885`；原旧 Coordinator 的 `coordinationFailure` 仍原样保留，TaskRuntime 仍然 `Requested/Started/Finished/ResultPrepared/Delivered = 52/52/52/52/52`，DeepSeek 页面仍为0，证明人工历史审核没有触发旧输入重放或工具执行。

随后原生 Worker Status 菜单真实显示「原宿主退出后审核全新三页 Worker 接班」。用户批准第一道「审核并打开三个新页面」后，产品流程最终完成了**三张新空白 DeepSeek 页面原生共享、第二道 Worker 替换确认、机器旧 Owner 死亡证明和三角色逐条持久接班**。当前持久接班状态：

- Coordinator Mission `7fa7e64e-7bc3-47cc-b3fa-716a5174b52d`：旧 `0cb308d7-8385-4abd-823c-0922a50921ae` 于 `2026-10-04T03:46:10.742Z` 以 `human-reviewed-explicit-new-page-worker-replacement` 退休；新 `24a6f3f7-573a-46c8-a2f3-6bebdb1fa0ed` 于 `03:46:11.769Z` attached，adapter `eb3094eb-14ad-4b3f-9938-3466daed5be8`。
- Cognition Mission `6882f1fc-98c4-4228-918f-4bff780a7fb5`：旧 `d738915a-00cf-4ed2-8d77-47ce7a8a39d7` 于 `03:46:11.785Z` 退休；新 `b2e1352b-f50d-40e6-a397-20c06cb1c265` 于 `03:46:12.001Z` attached，adapter `5af06526-0529-450f-9bfc-8289387e7947`。
- Practice Mission `9eb0182e-dfe2-46b3-bced-407561b08609`：旧 `c20f2b46-2dad-4e75-a60b-0f6f7909876e` 于 `03:46:12.028Z` 退休；新 `c8f540be-0b9b-4b4d-9bd5-8ba9460c1d68` 于 `03:46:12.253Z` attached，adapter `05c94b48-87dd-4cef-b43a-eb163fb8c49a`。

新三页的现场只读 CDP 状态完全一致：三页 URL 均为根路径 `/`，WebMCP `version=25`、`siteAdapter=deepseek`、`enabled=true`；`pendingDeliveries=0`、`pendingHostCapabilities=0`、`workerTurn=null`、`lastDeliveryError=""`、submit diagnostic idle、无 occurrence identity error。也就是说，**三页已经绑定为 Worker，但还没有收到任何新业务输入**。TaskRuntime 在接班后仍然保持 52/52/52/52/52，明确证明接班动作本身未发送历史请求或自动执行工具。

接班持久状态的 `replacement.approvedPages.length=3`、`mutationStarted=true`、`assigned` 三角色均存在；旧 Coordinator 未确认回执完整归档于 `replacement.previous.coordinationFailure`，而新一代 `practice.coordinationFailure` 已清空。Product Shell/原生 Worker Status 已不再显示旧连接恢复或旧 Coordinator 诊断，而显示「运行实现与测试 Mission」，说明当前产品已认可三条新 live Worker 归属。

**重要验收边界仍不变：** 这次只证明“旧事故已安全审计 + 新三页已安全接班 + 未重播旧任务”。它**还没有证明修复后的新 Coordinator→Target→工具→Coordinator→Provider 整条新业务链一次完整成功**，也没有改变既有的按需三角色调度模型。下一次必须由用户批准一个**全新的业务目标**，再观察实际路由到 Cognition 或 Practice、工具执行和最终 Coordinator 回执是否全部收敛，才能把 Phase12 的端到端防复发能力正式判为 PASS。
