# Core 基线复原与组件收尾（2026-10-06）

## 2026-10-06 当前状态：DeepSeek 同 Project 两轮正式闭环 PASS，其它现场与 Stable 前置仍开放

Human 要求继续补齐现有零件。未来自动维护、Rescue、自动升级回滚仍不在范围内；历史 proof 身份不重放。当前不能宣布全部现场/发布安全缺口清零。

- 完整 Core 初始 1,177 条错误已收敛；最终 `npm run compile-client` PASS（Core 与内置扩展 0 errors）。实际日志：`shuncode开源/.build/nimora-component-validation/core-compile-client-startup.log`。严格检查另见 `core-round25.log`。
- 受影响 Node owners 938 passing、17 pending；不是全仓库所有测试。Chat/Sessions 真浏览器回归 168 passing；组件集合 35/35 suites PASS。第一方 extension typecheck/build PASS。pending 用例未冒称通过。
- Core 复原依据不可变提交 `df53daabb18cd157bdb08c7f01c34df936cf12f4`，记录逐文件原始源码/上游 SHA。本地 Branch、空输入 Merge、Bridge 卡片规则保留；生成的 AHP 文件不直接修改。Checkpoint 由实际 AgentService 的子 DI 创建，desktop/standalone 均使用其真实 owner。
- 原生 Copilot CLI Worker 已进入源码生产 pool：新版界面桥 + 服务端只读 schema 版本声明共同核对；fresh 专属会话冻结 exact custom tools，禁 builtin/MCP/自动发现与命令旁路；结果必须服务端 SDK receipt，客户端 echo 不算送达。输入/结果消费、取消、漂移与旧 server 拒绝测试 PASS。旧 host/未知 ABI/Claude/Codex backend 保持 unavailable，尚无新的真实原生 Provider E2E。
- R9 DeepSeek 同一 Project 两轮文件工作及正式完成已真实通过，六个 Mission 归档、六个 Workers 退休；API/原生 Copilot/Personal Edge/外部 Skill/现代 MCP/真实网站归档等其它现场仍开放，详见本节最后当前结论。
- R2 fresh 启动实际发现并修复 AgentHost network bootstrap 使用未注册 vscode-userdata scheme、管理连接误注册 renderer reverse proxy/BYOK 两处问题；新增实际 NativeEnvironment + 内存文件系统设置加载回归，见 `core-node-tests-startup.log`。这些修复要求 R3，不把旧 R2 当作最新源码发布包。
- Human 已登录并逐页共享，R3 已真实建项并执行 Root A；Project `b3697806-0173-4116-b4e5-5715c5997ff1`，Root `9a01deb7-de1e-463c-9510-a70eae0cda10`，runId `e77e160d-3665-49a9-a6b0-017f388bc10b`。四条 execution succeeded/prepared/delivered，各唯一：read_files、list_directory、apply_patch、read_files。仅一次 PATCH，结果原始 LF 字节正确，SEED SHA 不变。Cognition 已提出完成候选，Practice 已正式归档，root/Coordinator 未正式审核/归档，Root B 未开始。关闭前未取得外层 Promise 的 resolved 结果；以持久记录为准，不能重发。`root-a-audit.json` 和 canonical journals 保留。
- 本轮限定能力验收 FAIL_EXTRA_DIRECTORY_READ：Work Order 声明 read-files/apply-patch，但默认 profile 额外附加目录读取。已补可选 allowedCapabilityIds 上限，empty 保持零工具、required/optional 超限预拒绝；普通明确 Work Order 同时声明严格上限，输入物化与发送前漂移检查保留它。Capability/Input/User-entry/Autonomy 专项与 extension typecheck PASS，修复后 35/35 组件回归 PASS（regression-scope-ceiling.log）。R4 构建含修复；R3 旧实测偏差不改写，R6 已真实通过严格三次 READ/PATCH/READ 与范围／投递核对；独立完成审核 blocked，正式归档仍待通过。
- 历史 R4 复测：runId `aa0f4ae2-8d8e-466e-83db-7aa1bcc18082`，新工作区 `shuncode开源/.build/nimora-components-r4-deepseek-20261006/workspace`，当前 `ROOT_A_PLANNING_COMPLETED_JSON_REJECTED_NO_PROJECT`。仅沿用原隔离 user-data/extensions/shared-data 保留账户与历史，明确不是 fresh profile；新 Project/root/input 身份不复用旧 proof。R3 已在四个 Provider turn completed、零未决执行/投递时正常关闭，未 force kill、未清账本。Human 已信任 R4，新网页登录状态保留。首次规划在 exact 页面可见性 guard 退出，固定观测原 session 空 turn、没有当前工作区 Mission，控制器在 guard 通过前不进入 control/send；已保留失败消费与 unsettled reservation。隐藏通知并打开 exact 原页后可见，普通激活复核也可见，尚未单独证明遮挡根因。已在这些强前置下单次提交新的规划会话/输入继续操作，Human 已确认且 Provider 已 completed，JSON 解析失败，详见下节；当前 Provider 验收 `FAIL_PLANNING_JSON_BEFORE_FORMATION`，没有真实文件或两轮完成 PASS。
- 独立 Beta R10 ZIP 已创建并完成 CRC/回解/关键文件 SHA256 核对：`C:\Users\devil\Documents\Ai\shuncode\shuncode开源\.build\releases\Nimora-Beta-Windows-x64-20261006-Components-R10.zip`，372837362 bytes，5992 entries，SHA256 `8aa33dceb1d7bae6a15c0f4299b96124c007d5b168a42afea019fd3c1dd3bc99`。回解运行检查 PASS。R3 真实网页文件工作 PASS / 限定能力 FAIL_EXTRA_DIRECTORY_READ；R4 实测 FAIL_PLANNING_JSON_BEFORE_FORMATION，Stable 认证 HOST_PREREQUISITE_BLOCKED。
- 当前主机 MXC 报告 `appcontainer-dacl`，BaseContainer/BFS 前置缺失。live certification 脚本现在在任何准备/启动之前匹配 Stable gate 并明确报 HOST_PREREQUISITE_BLOCKED；没有修改系统 ACL、Program Files、驱动或电源，不将 osSandboxLiveCertifiedOnCurrentHost 设为 true。
- Windows Node 单元测试清理已修复；先前旧 SessionDatabase 落盘用例违反 node/AGENTS.md 的问题保留记录，临时目录已清理，现有 DB 单元用例用内存 SQLite；VACUUM INTO 的单元验证是绑定参数与错误传播合同，不冒称真实文件导出。

### 变更日志（2026-10-06）

完成 Core 版本/实现/调用方复原与编译；补齐原生 Copilot 的受限 SDK 工具和 host-requested result receipt；修复恢复错误覆盖历史、SDK 历史时间戳、系统通知、终端滚动输出和 Chat usage 重复累加。补入 stale server/version/candidate/no-replay 负向验证，更新组件回归为 35 suites。构建独立 Beta；回解后启动实际发现 AgentHost 设置 scheme/管理 reverse channel 问题并修复。按 Human 的 DeepSeek 优先选择启动全新隔离验收实例，原 installed distribution/旧证据不覆盖。

新增现场变化：Human 登录后，以明确 awaiting-share / Task=0 结果为前置单次继续，真实 Project/Practice READ/PATCH/READ 与四次唯一投递成立。审核发现额外目录读取，按原范围记 FAIL，未重放或事后扩权；补严格 capability ceiling 与 empty/超限/发送前漂移回归，构建 R4。同步记录实际文件 SHA、完成候选、Practice 归档与尚未正式完成的 root/Coordinator。Stable host 前置、R4 fresh live、同 Project 后续轮次和其它真实 Provider/人工治理验收继续公开保留。

继续验收变化：R3 已在确认所有真实 turn 与工具投递收敛后正常关闭；R4 新 run/workspace 复测保留同隔离配置的登录与历史，未复制或清理 cookies/journals，不冒称全新 profile。创建新 fixture、明确能力和字面文件路径限制，打开正常 workspace trust 页面；新请求在产品 Human gate 之后发送，旧失败结果保留。

R4 继续实测：Human trust 已完成；首次规划请求在 native exact-page 可见性检查被拒绝。没有绕过 guard：固定观测证明旧 session 未出现 turn，当前工作区无 Mission，原 fixture 不变；正常隐藏普通通知/打开 exact page 后可见。按明确发送前失败前置保存新的单次继续消费，保留旧页/旧 unsettled reservation，进入正常新页/新输入产品确认；随后 completed-but-invalid-JSON 拒绝，不把这一步当现场闭环通过。

### 2026-10-06 Web Cognition JSON 实测收敛

R4 Human 确认后，新的真实规划页 6c0b2f83-f4cf-4a90-99e9-67a44652ab6e / pageSession 5a6de86c-9e99-4328-b440-504b19382b0e 已收到请求并 completed；产品在 JSON.parse offset 639 拒绝。R4 当前 ROOT_A_PLANNING_COMPLETED_JSON_REJECTED_NO_PROJECT / FAIL_PLANNING_JSON_BEFORE_FORMATION，零新 Project/Mission、零文件执行，SEED SHA 不变，只有 SEED.txt。失败与消费证据见 planning-json-failure.json 和原 outcome，禁止重发原输入。页面 JSON 是普通段落，字符串内引号缺少转义；原始 Provider 字符串不可得，Markdown 改变转义属于推断。

第一方源码已把建项、later-root、完成审核统一到完整回复/单个 fenced JSON code block 解析。仅已确认 completed 的 tools-free 回合遇到 SyntaxError，允许同一受管理会话一次新的格式纠正输入；fresh inputId、零 capabilities、回复 hash/长度观察，不截取子串、不补引号、不修复语义权限。第二次失败停止，UNKNOWN/failed/缺 terminal/工具调用不进入纠正。语义与治理仍由原 owners 校验。专项/typecheck/build 与 35 suites 回归已验证；新包现场验收另计。

初次 R5 standard 打包末步因 PATH 没有真实 SDK signtool 失败，日志保留；第二次后台构建及后续回归在等待期间中断，不能算 PASS。继续时观测 R4 测试实例已退出、原因未核实，没有强制结束它，也没改 installed ShunCode。当前已使用本次进程的真实 Windows SDK PATH 重新完整构建。R5 run c9d8a118-53e4-42b0-9b6e-fc8d47d5963f，当前 ROOT_A_VALID_JSON_WORKER_POLICY_REJECTED_NO_PROJECT / FAIL_UNPROVEN_WORKER_POLICY_BEFORE_FORMATION；沿用未改动、Human 已信任的 R4 fixture 工作区与原隔离 profile，明确不是 fresh workspace/profile；新的规划/Project/root/input 身份不复用 R4。

变更日志：保留 R4 completed-but-invalid-JSON 现场失败；补 Web JSON 字符保真和一次有界纠正合同及正负向验证，覆盖三类产品 Cognition 入口；完整打包和实链状态按真实日志更新，不热改 R4 包或伪造 Project/执行/完成。

### 2026-10-06 规划 backend 观测接线

R5 Human 已确认并共享，真实新页 466b76ca-43be-4a85-ad7f-bdcdc5b92f67 / pageSession 62057ddd-909e-4414-80cb-dcd637342917 completed，JSON 正常解析；随后因模型 workerPolicy 要求 reasoning=true 被预检拒绝。当前 ROOT_A_VALID_JSON_WORKER_POLICY_REJECTED_NO_PROJECT / FAIL_UNPROVEN_WORKER_POLICY_BEFORE_FORMATION，零 Project/Mission、零文件执行，原 SEED 不变。planning-policy-failure.json 保留 consumed 失败，不改写原回复或删除硬要求。

专用 planner 正确排除在 assignment pool 之外，但 Formation 当时没有单独的已选 DeepSeek backend 观测。现由原 owner 在解释前和预检前 refresh descriptor + health，核对 exact adapter identity、idle/无 Task/非 unsettled，再提供 owned-tools-free-planner backend 数据；reservation 保留，不伪造可分配 candidate，不授工具，不替代实际新页 assignment。提示明确 transport requiredCapabilities 不能照抄整个向量，Cognition 推理不等于 reasoning 事件流。真正 unsupported reasoning=true、未知 model、Provider 不匹配、不健康/漂移继续拒绝。专项、typecheck/build 与 35/35 suites PASS（regression-planning-backend.log）；R6 包和实链结果另计。R6 run 21dcf62b-0600-4c62-a0b9-2cce4b8f21da，当前 ROOT_A_FILE_PASS_COMPLETION_REVIEW_BLOCKED_MISSING_CONTEXT / ROOT_A_BOUNDED_FILE_PASS_FORMAL_COMPLETION_BLOCKED，原隔离 profile 和未改动 R4 fixture 保留，新请求/Project/root/input 不重放旧身份。

变更日志：修正 R5 pending 快照为 completed-but-policy-rejected，补选定 Web backend 的独立事实观测与严格正负向预检，保留真实未知/unsupported 拒绝；未降低权限、安全 gate 或改变 installed distribution。

R6 当前持久身份：Project b63a6b3f-aef3-4b74-a499-b76776af7e20，Root A 77055b8c-8994-4906-96b0-e8660a6a58ca，Coordinator d64d0425-e622-4bf1-b303-f96f58c1ba2a，Practice 1f67ba21-9832-4d64-b783-65b4a5bfef38。formation-audit.json 已核对 canonical ProjectCreated/formationReceipt 与唯一三个 Mission。Human 已启动自治；root-a-audit.json 证明严格 READ/PATCH/READ 三次唯一 succeeded/prepared/delivered、零 UNKNOWN/pending/duplicate、一次补丁、SEED 未变、原始 LF 字节正确，结果 SHA 6807825997e3b87bb13461a111e7a25f213bdf99c692b0d4be469dd982d85cbe；Practice 已归档。只读 workspaceState 证明自治 terminal completion-candidate；外层 start-a 仍 pending 在结束信息提示，不能重放。独立 review-a 已明确 resolved/blocked，未发送 completeManagedScope、Root/Coordinator 未归档、Root B 未开始。当前 ROOT_A_FILE_PASS_COMPLETION_REVIEW_BLOCKED_MISSING_CONTEXT / ROOT_A_BOUNDED_FILE_PASS_FORMAL_COMPLETION_BLOCKED；文件 PASS 不代替正式完成 PASS。

### 2026-10-06 完成审核证据收敛

R6 的独立 tools-free 完成审核把运行 ID 错当 SEED 内容要求，并拒绝；实际 canonical context 要求 seed=<SEED 实际首行>，READ/补丁/复读及审核者字节比对一致。核对产品投影发现 Mission context/constraints 与 inputAccessPolicies 未送给 reviewer；遗漏是源码事实，模型为何推断该字面值只限观察，不声称已证明其内部原因。原拒绝、消费及 completion-review-blocked.json 保留，未自动语义重试、未重发文件补丁、未手工完成。

第一方完成审核现在带上当前每条 Mission 的 durable context 和 inputAccessPolicies；later-root 使用本轮 context，不从最初 formation 推断新目标。提示要求当前 criteria/context 与实际 READ 推导内容值，Project 标题/ID/旧聊天不是额外验收标准；路径策略与实际 diff 用于核对变更范围。仍保留 48000 字符整包上限，超限拒绝而非截断；确认后重新编码整个证据检查漂移，UNKNOWN/未收敛继续拒绝。完成审核专项覆盖动态 seed/context、later-root B 路径、确认期间约束漂移预拒绝和超限不发送；typecheck/build、runtime 与 Web assembly PASS。完整新包及真实审核结果另计。R7 run 85568fd4-23fc-493b-b244-8dd0716a45bd，新 fixture 工作区 C:\Users\devil\Documents\Ai\shuncode\shuncode开源\.build\nimora-components-r7-deepseek-20261006\workspace，当前 ROOT_A_FILE_PASS_TWO_COMPLETION_REVIEWS_REJECTED_MISSING_INSTRUCTION / ROOT_A_BOUNDED_FILE_PASS_FORMAL_COMPLETION_NOT_ACCEPTED；保留原隔离 profile/全部旧失败 journal，不重放 R6 输入。

变更日志：R6 有界文件验收 PASS，独立完成审核 blocked 保留；补齐当前 Mission 的内容约束与路径证据接线及漂移/大小负向验证，构建后才做新的 live 验收，不热改 R6 运行包。

R7 两次完整构建的源码编译/Core bundle 完成，但 package 阶段直连 GitHub 的 Electron v42.7.1/SHASUMS256.txt 超时；第三次诊断确认 UND_ERR_CONNECT_TIMEOUT，失败日志全部保留。最后通过 GitHub 官方 release asset API 下载同一 checksum 文件，实际 SHA256 52ed282a72bdec2a51490c16c76f6630c86ccb89622766519759da39a45d6b70 与官方 digest/size 一致；仅本构建进程换下载入口，原 checksum/signature 检查保持，未改系统代理/依赖源码。标准 vscode-win32-x64-ci 在相同已完成编译输出上 PASS（package-components7-official-asset.log）；不把原完整命令的失败改成通过。R7 ZIP/回解及 portable 均 PASS，详情见 package-components7-report.json 与 COMPONENTS_REAL_ACCEPTANCE_2026-10-06.md。R6 原 Provider 全部 terminal、工具全部 settled、循环持久 completion-candidate、独立审核 blocked 后才正常关闭；原正式 root 完成未伪造。R7 初次打开时未受信任，初次观测零新请求／Project／Mission；当前 trust 与操作状态见下条；原 profile 与所有 journal 保留。

R7 Human 已完成 trust 与新规划页共享；首次 start-a 因 exact-page 可见性 guard 在发送前失败，固定 observe 证明原 session 空 turn。正常打开 exact 原页后 visible=true，尚未证明布局根因；保留原 consumed/unsettled reservation，在强前置下仅一次新的规划输入继续。Project 80ba455b-bc4b-4f09-9ca0-351b0641d011，Root A 646fed18-d98d-4776-8208-32271f3984ba，Coordinator a7eca038-de26-4114-aacf-80a5f86b5ea7，Practice 5ae13ff9-44ee-49f7-8edb-0d71f959aa33。formation-audit.json 证明 canonical ProjectCreated 与三个 Mission；root-a-audit.json 证明恰好 READ/PATCH/READ 三次 succeeded/prepared/delivered、零 UNKNOWN/pending/duplicate、一次 add-only patch、SEED 未变，原始 LF 结果 SHA e5e68325b2c572827c5560d8e8aa200fd5fa18bba04f2c3ffa57dbdfc6fc55b7。Practice 已归档；只读 workspaceState 的 autonomyOutcome 为 completion-candidate，外层 continuation Promise pending 不能重放。

独立 review-a 与一次新的 review-a-fresh 均已 completed 回复 ready，但仅 verdict/summary，缺少必需 instruction；strict parser 两次拒绝，未进入 Human 完成确认、未消费 completeManagedScope，Root/Coordinator 未归档、Root B 未开始。不是文件失败，也不是正式完成 PASS。两个独立 completionKey 和原回复／失败保留，详见 completion-instruction-rejection.json、first-review-rejected-workspace-state.json。当前 ROOT_A_FILE_PASS_TWO_COMPLETION_REVIEWS_REJECTED_MISSING_INSTRUCTION / ROOT_A_BOUNDED_FILE_PASS_FORMAL_COMPLETION_NOT_ACCEPTED。Native server connected/schema v1，copilotcli modelCount=0，仍无真实原生模型验收。

变更日志：R7 真实文件工作与能力范围验收 PASS；保留两次完成审核输出缺字段拒绝，停止相同审核。源码将含非 JSON 占位符的 ready 示例改为有效完整 JSON，直接带本轮四个身份字段，明确只替换 summary／严格复制 EVIDENCE.instruction；不由 host 补字段，不增加自动语义重试，不降低身份、证据重读、Human 或 no-replay guard。新增缺 instruction 时零确认／零保存／零执行与本轮示例身份核对；专项、typecheck、build、Runtime 与 Web assembly PASS。下一独立包现场另计，R7 原包不热改。

### 2026-10-06 完成指令契约新包

R8 完整标准 vscode-win32-x64 构建 PASS（package-components8.log），本构建进程沿用同一 GitHub 官方 checksum asset 下载入口，保留原 checksum 与真实 SDK signature 检查，不改系统代理或源码依赖。source/package extension SHA d58d9e8a7e5b0ea40ec2c7870690ebe85f06489a188e18473ccf4b47e2a38201；ZIP 372833877 bytes／5992 entries，SHA 53ef216cdbd269e9a717f37b16417da6145c4bbfcedecd03637bf90dd6c6746f，CRC／回解关键 hash PASS。目录与回解 portable 运行结果见 portable-components8.json／portable-components8-from-zip.json，不能代替真实账号验收。

R8 run 109d026c-a0b0-4844-b737-97acc562e689，新工作区 C:\Users\devil\Documents\Ai\shuncode\shuncode开源\.build\nimora-components-r8-deepseek-20261006\workspace，SEED SHA 3998a1d568bbdc9bbbf00c43f966dd0d9f3e4b859b60a19bde22d81319c02ec3，fixture ID 继续与 run ID 独立；原隔离 profile/cookies/journals 保留，非 fresh profile。当前 ROOT_B_BLOCKED_BEFORE_PRACTICE / ROOT_A_FORMAL_PASS_LATER_ROOT_FORMATION_PASS_B_DECISION_REJECTED；Project ac6327c8-f5b1-4ce9-97b7-e80647ef819d，Root A 5ba8afb5-1a74-4d7e-be28-4a8b001e3372，Root B 9037a562-3d29-44ca-aa4f-087b742cd0bb。 Human 已完成 R8 trust，建项/后续轮次/审核命令已启用。 网页共享与正式完成仍走原产品 gate。R7 只在真实回合 completed、工具全部 settled、循环持久 completion-candidate、两次审核明确 rejected 且完成消费为空时正常关闭；原失败页固定空 turn、原 Root/Coordinator 未完成不改写，不 force kill／清账本／重发输入。

变更日志：修正完成审核 ready 输出示例，严格缺字段拒绝与所有治理保持；专项/typecheck/build/Runtime/Web assembly 和 35/35 组件回归 PASS。完整新包与原包分离，真实 Provider 两轮和其它现场／Stable 前置继续公开保留。

### 2026-10-06 R8 第一轮正式完成与后续轮次决策修复

R8 Project ac6327c8-f5b1-4ce9-97b7-e80647ef819d 的 Root A 5ba8afb5-1a74-4d7e-be28-4a8b001e3372 已通过恰好三次 READ/PATCH/READ、独立 ready 审核含精确 instruction、Human 确认与 canonical 完成消费。Root/Coordinator/Practice 均已归档、Workers 退休，文件保留；证据 root-a-audit.json、root-a-completion-audit.json。普通 startNextProjectGoal 在同一 Project 创建 Root B 9037a562-3d29-44ca-aa4f-087b742cd0bb，later-root-formation-audit.json 证明当前活动 root 选择、旧 A 三本 journal 与文件 hash 未变。

R8 第二轮自治已由 Human 启动并共享独立页面，但首次 Cognition 决策错误目标 root；一次有界纠正的 DOM paragraph 字符串内嵌引号不合法，strict JSON 拒绝。持久自治为 blocked，尚无 Practice B、文件工具或 B 结果，第一轮 completion scope 保持 completed；root-b-blocked-audit.json 保留事实。无法取得 Provider 原始字符串，Markdown 改转义只是推断。原消费与失败保留，R8 不热改、不重发。

Canonical MissionAutonomyLoopService 的结构化回复现在要求一个完整 fenced JSON code block；Host 接受完整裸 JSON 或完整单个 json/无标签 fence，不截取子串、不修引号、不扩大字段／权限／长度或纠正次数。提示明确 Work Order 仅能指向现有活动 Practice；无合适 Practice 时先通过 additionalMissions 建立。修复创建子 Mission 后 workOrders 为空直接 quiescent 的断点：下一有界轮次重新读取 canonical id 再决策，仍最多八轮，没有后台任务。专项真实 owner 组合测试证明空后续 root -> 建立 Practice -> canonical id -> 一次 Work Order -> 证据/child finalization，root 正式完成 gate 保持；多个代码块／前后 prose／坏转义／未知字段与超限拒绝，八轮上限通过。typecheck、compile、组件 35/35 PASS，新包真实验收另计。

变更日志：R8 A 正式完成 PASS、同 Project B 建项 PASS、B 决策拒绝明确保留；补 Mission 结构化传输和 decomposition 下一轮接线，所有 no-replay／Human／UNKNOWN guard 不降级。原页面无发送的诊断表明 hideToasts 后仍 invisible、随后 native activate 可见；不足以证明最初布局根因，当前未修改可见性 guard 或 Core。

### 2026-10-06 历史阶段快照：Mission 决策与 decomposition 修复 R9 包

完整标准 vscode-win32-x64 构建 PASS（package-components9.log，2.82 min）；保持同一官方 Electron checksum asset 和真实 SDK 签名验证。extension SHA ae3682621db0dfe84813291cb94306b6e7013e341a9b998f22ced6a8216d609e，ZIP 372828868 bytes／5992 entries，SHA f0d2fffdc47718a674728bd6b5a304cfebfabb633e81ea11d9b78b36ef030d97；CRC、回解关键 hash、目录与回解 portable 均 PASS，零私有 profile 入包。验证记录 autonomy-wire-validation.json。

R9 run 4f016890-ce4d-4467-9fcc-953aeeca16af，新 fixture 工作区 C:\Users\devil\Documents\Ai\shuncode\shuncode开源\.build\nimora-components-r9-deepseek-20261006\workspace，SEED SHA 54d8fa81ffcaccd4b2926a95584244636b35b20d023b3bb8578fc7b19e8137a6；当前 ROOT_A_AND_ROOT_B_FORMAL_COMPLETION_PASS / PASS_DEEPSEEK_SAME_PROJECT_TWO_ROOTS_FORMALLY_COMPLETED。初次观测 trusted=false，建项／later-root／审核命令未启用；initial-trust-gate.json 核对当时零新 Project/Mission journal、零新 Provider 输入、仅不变 SEED。当前 Human 已信任，trusted-status.json 证明三个命令启用，已单次 start-a 通过正常产品入口；网页共享由 Human 完成，实际 Provider/Formation 状态只按现场证据更新。原隔离 profile/cookies/journals 保留，非 fresh profile。原 R8 exact PID 27900 仅在所有实际 Provider completed、唯一历史失败规划页固定空 turn、执行/投递全部 settled、A 完成 journal/hash 保持、B blocked 已持久化后正常关闭；B 未完成不改写，不 force kill／清账本／重放旧请求。新 PID 29424，网页共享与完成仍需原生 Human gate。

变更日志：R9 完整独立包与回解运行 PASS；启动新的真实验收目录，初次工作区信任 gate 保持。此初始阶段尚未证明完整两轮现场；最终结果见下方当前验收结论，其它 Provider/Stable 仍未通过。

### 2026-10-06 历史阶段快照：R9 发送前通知遮挡实证与源码修复

R9 首次 start-a 在 exact page ebe99dd3-eb25-4a80-a724-9e246248c160 / session 3a0c19be-930b-4ca6-85e1-b2f6f365de9d 的 native visible guard 退出；原固定 observe 为首页、空 turn，零当前工作区 Mission/Project 和文件工具，SEED 与文件集合不变。原失败消费／unsettled reservation 保留。visibility-presentation-diagnosis.json 逐步证明 native activate 单独仍 visible=false，随后仅 notifications.hideToasts 即 visible=true，页面/会话/URL 不变、没有 Provider 输入。已证明通知浮层遮挡；尚未识别具体通知内容或发起组件，不冒称某一 toast 来源。强前置核实后单次 continue-a-after-pre-send 采用全新规划会话／输入，当时等待原生 Human 新页共享；随后两轮已正式完成，见下方当前结论，不重发原失败输入。

WebMCP canonical extension.js 的 exact-page visibility owner 增加一次通知呈现恢复：在激活后的新鲜共享身份/URL 核对仍不可见时执行 notifications.hideToasts，再在原期限内重读真实 visible；不会隐藏/确认 modal Human 授权、共享页面、导航、发送 Provider 或绕过 guard。通知仍保留在通知中心。node --check、fixed-control（toast 恢复／modal 仍阻塞／URL 漂移／命令失败）和 internal-browser/Web assembly PASS。另修复 retired cleanup 调用可见性 owner 时误用位置参数，改为 exact 身份对象；实际 Extension callback DeepSeek/ChatGPT 接线及漂移预拒绝专项通过，未对真实账号执行归档。

source SHA 97de445a8cfe3fde4ba405d1bc389fd7d1020b4d29a1cc66081103257c4390e1，当前 R9 包 WebMCP SHA 16de8e0dbcdaa2ce88bbca362c6b0bb89ddbd01297e02343dd4ad4d60bed9b79；源码修复尚未装入 R9，绝不热改活动包。记录 visibility-toast-validation.json；新版打包/live gate 另计。

变更日志：保留 R9 首次未发送失败，正常呈现恢复与一次全新规划继续；补发送前的通知浮层呈现恢复及 cleanup 参数接线，既有 identity／visible／Human／no-replay guard 保持。当时完整 R9 两轮尚未通过；最终两轮结果见下方当前结论。其他 Provider/Stable 验收仍开放。

### 2026-10-06 当前验收结论与收尾变更

R9 run 4f016890-ce4d-4467-9fcc-953aeeca16af 已在同一 Project 5c291faf-842a-448e-8e09-11e40c0fb0d5 真实完成两轮。Root A ada435ca-9bdd-4cdb-a88f-a09aeced3786、Root B f2cbcb7c-0c36-434b-acc6-216926f2d5d2 各恰好 READ/PATCH/READ 三次唯一 succeeded/prepared/delivered；六条执行无 UNKNOWN/未决投递。两轮各经独立 Web Cognition ready+精确 instruction 和产品 Human 确认完成，completionKey 分别 ec5cf29f-fccf-4999-973b-318d39d88ed8 / 89b916f6-6615-4e4a-b488-3d125c5deb6c；六个 Mission 归档、六个 Workers 退休。B 从普通 later-root 入口创建，初始无 Practice，经自治 decomposition 建立 Practice 并继续下一轮。SEED、第一轮文件及三本已归档 journal 在 B 完成后保持不变。two-root-final-acceptance.json、root-a/b-audit.json、root-a/b-completion-audit.json 是不可变证据。此前 R3–R8 失败不改写；R9 首次未发送页及原消费保留。

源码收尾：WebMCP 在 exact-page 激活和身份核对后一次隐藏普通 toast，再重读真实 visible；modal Human 授权、共享、身份/URL、发送与 no-replay guard 保持。退休会话 cleanup 改为传递 exact-page 身份对象，实际 callback 隔离正负向测试 PASS，尚未归档真实账号。Nimora 自治 terminal 信息提示改为非阻塞，durable outcome 保存后直接返回，避免用户未关闭通知时产品建项 busy 一直占用；启动 modal 仍等待 Human。未关闭终止通知也正常返回及取消启动零分配/零运行测试、typecheck/build、组件 35/35 PASS。R9 活动包未装这三项收尾修复，不热改；R10 已独立打包，CRC/回解关键 hash 与 portable 结果见 package-components10-report.json；新版呈现/命令返回的真实网页验收另计。

剩余现场：真实 API Worker、原生 Copilot（当前 server schema v1 但 modelCount=0）、Personal Edge、外部 Skill 人工信任、现代 MCP 账号路由、真实退休会话归档；本次有界文件验收不代表所有工具/并发/接班/重启分支均 fresh live PASS。Stable 仍 HOST_PREREQUISITE_BLOCKED（BaseContainer/BFS 缺失），不得降低安全 gate。未来维护/Rescue/自动升级回滚仍不在本轮范围。

变更日志：R9 同一 Project 两轮正式闭环 LIVE PASS，旧文件与归档历史不变；补终止通知非阻塞、发送前普通 toast 呈现恢复和 cleanup 参数接线；分开记录源码/回归/新包与 live 状态，未修改历史账本或活动包。


详情：`NATIVE_CLIENT_TOOL_WORKER_2026-10-06.md`。原始日志与逐文件复原记录位于 `.build/nimora-component-validation/source-baseline/`；本记录不替代真实 Provider 或 Stable sandbox 认证。
