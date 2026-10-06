# Multi-Provider Autonomy V1（2026-10-06）

**2026-10-07 R19 最终正式结果**：Human经产品原生入口完成新的独立审核/最终确认，canonical三个Mission归档、scope Workers0、三份Handoff digest/内容核对、Coordinator先于root收敛均PASS。确切workspaceState本root completion scope `phase=completed`，四项instruction与inputId/evidenceDigest匹配新durable审核artifact；completionKey `62df687a-d882-4adb-967b-85a130d9183b`。原inspector cancelled outcome与取消时报告保持，没有改旧promise或重播原review。Practice journal与SEED/RESULT/旧26本journal/3文件/R9历史保持。实际API跨R14 Formation→R17 Work/Evidence→R19 recovery/审核/Human/正式完成PASS；当前指纹混合/第二账号/Native/Stable等外部门仍独立开放、整体RC_NOT_QUALIFIED。报告`multi-provider-r19-qualification-final.json`；下方取消/等待状态均是历史快照。

**R19 最新 owning result**：独立public review最终resolved/cancelled，原生完成确认已取消、没有发送完成命令。Root/Coordinator仍ready且各1Worker，Practice归档/3次成功工具/实际文件不变。取消记录保留，下一次必须是新的Human决定和新审核身份；不把completed审核回合当正式归档PASS。现时报告`multi-provider-r19-qualification-at-cancellation.json`，RC_NOT_QUALIFIED。下方“等待确认”是之前快照。

**R19 实测推进**：Human批准启动后，真实API单轮复核返回completion-candidate且新增WorkOrders/Missions/finalizeIds均0，原Practice journal字节不变，文件/历史保持。独立API审核回合completed，public review尚等最终Human确认，不计正式root归档。R19 ZIP372881858 bytes/5995 entries，SHA256 `e8bbb57e0c6bd58d8634c6dc153d0ab3672cb82a9594459727d79f3a95fb92c3`；CRC/回解/hash/两处portable PASS，无profile内容/current release变化。以下“包校验进行中／等待启动”已是历史快照。

**2026-10-07 R19 最新恢复状态**：R18 carrier已完成ZIP/CRC/回解/portable，启动却在原生确认前被`autonomyStartClaims`拒绝，因为误将已归档Practice当成活动root失效；没有新Provider输入或文件工具，Human报告“没看到弹窗”与此一致。R19仅要求root/Coordinator未finalized，完整scope digest继续包括已归档Practice，权限/no-replay/漂移检查不变。隔离compile/typecheck、归档Practice consent专项和普通自治/later-root回归PASS；source-built R19 carrier/原目录portable PASS，ZIP校验进行中。原R17三次工具/Evidence/Practice归档保持，R19同Project/root启动已提交一次并在native confirmation等待，正式审核尚未执行。没有UI文案/布局/样式改动或共享生成物写入。

**2026-10-07 R17 真实结果 / R18 当前工作**：R17 新 carrier 的 ZIP CRC/回解/hash/两处 portable PASS，372882113 bytes/5995 entries，SHA256 `92c2ad0e0a4b3acc8f82d1c85fec7f638aecb9e8c24f7dd98e67d4d20dd78de8`。Human 原生启动后，同一 R14 Project/root 的 fresh inputs 完成真实 DeepSeek API 两轮自治：唯一 Work Order→三次 READ/ADD/READ→三对唯一 Prepared/Delivered→Evidence→Cognition reconciliation→Practice archived/Worker retired→completion-candidate。实际文件和 canonical patch-only 参数 digest、旧26本journal/3文件及R9历史核对PASS。Root/Coordinator 尚未正式完成：public review 在发送前因重启丢失临时 Formation planner 连接而拒绝，原结果保留。R18 后端入口现在按当前 root 持久 planner policy 准备 API tools-free reviewer，不发送模型请求/文件工具；已有 uncertain/running/bound/unhealthy/backend-drift连接不替换，Web 原连接要求不变。隔离编译/typecheck、新恢复专项、完成入口/正式归档owner/实际API Runtime回归PASS；独立 carrier 继续验证。不改并行 UI 源码或共享产物；extension.ts只改后端 completion reference 一行，包使用冻结R16 UI版本的同一行变化。详见 [恢复合同](API_COMPLETION_RECOVERY_2026-10-07.md)。

以下 R17“打包中”、R16“等待启动”等段落是历史快照，以本条和最新 immutable evidence 为准。

**2026-10-07 Runtime 当前更新**：R16 原启动和同包新继续均在 Coordinator 参数 gate 停止，文件工具0；精确观察证实 `deliverParallelExplicitMissionInputs` 参数为 host-realm plain、唯一 own key=`dummy`。R17 API 单命令使用输入绑定的 `invocation_id` 显式 wire 编码，严格 admission 后解码为 canonical `{}`，原 gate/Provider 回执/权限边界不变。独立编译/typecheck及14/14受影响Runtime检查 PASS；当前UI consent测试与冻结R16界面文字不同，原失败保留并交由UI工作，不改该UI测试或源码。R17 carrier正在打包，仅阶段化新 source-built extension与对应TS；R16 Core/UI/Runtime/WebMCP保持原字节，旧包与共享UI构建输出未改。真实完整API/混合/RC仍待资格结果。详见 [wire合同](API_COORDINATOR_WIRE_ENVELOPE_2026-10-07.md)。

下段 R16 状态是当时构建快照，后续现场失败和 R17 更新以本条及 evidence 为准。

当前状态：**生产接线、第一方 typecheck/compile、39/39 受影响回归通过；R14 完整包、回解及 portable 通过。R14 真实 API 已完成 Formation、Root/Coordinator 分配和一次 Cognition 解释，但后续 Coordinator 空参数合同被拒绝，文件执行为零。R15 完整包/回解/portable 通过；真实 Coordinator 回执成立，但 API terminal 缺少 text 导致两次 Cognition 被视为空回复，文件工具仍为0。R16 已修正终态映射、真实组合 Runtime fixture 与39/39回归通过，完整新包、ZIP CRC/回解/关键 hash/两处 portable 已通过，当前原 Project 现场继续等待原生 Human 启动确认；完整 API Mission、混合账号现场与 RC 尚未通过。**

此记录更新《下一阶段完善计划书》的工程执行事实。自动维护、Rescue、自动升级回滚继续不在本阶段范围。此前 R9 同 Project 两轮正式完成与 R13 有界 API 文件链的历史证据保留，不能代替本轮入口现场验收。

## 普通产品路径

Product Shell 的主要入口为“按资源偏好新建 Project”，Connections 提供资源偏好和多 API 配置管理。用户只需提供目标并选择允许的资源：

| 模式 | 需求解释、Cognition、Coordinator、完成审核 | Practice |
| --- | --- | --- |
| DeepSeek 网页 | DeepSeek 网页 | DeepSeek 网页 |
| API 全流程 | 已配置 API | 已配置 API |
| 网页总文 + 混合执行 | DeepSeek 网页 | 网页或 API |
| API 总文 + 混合执行 | 已配置 API | 网页或 API |

初始偏好仍为 DeepSeek 网页、串行。API 全流程不要求浏览器命令、网页共享或额外网页工具开关。API Chat 保留为高级兼容入口；普通 API Mission 使用与网页相同的 Project/Task/assignment/Phase 8/execution/delivery owners。

“建项并启动”和“下一轮开始并启动”各使用一次原生启动确认，展示总文、执行资源、并发和 API 费用范围；不再叠加同范围的启动弹窗。一次性授权由 owning closure 持有，公开 `resources` 参数只是草案，`approved=true` 不具备授权作用。工作区信任、工具权限、新网页共享、正式完成、网站归档仍由原生 Human 入口控制。

完成后的同一 Project 可以开始下一轮；资源偏好可作为下一轮默认值，**上一轮付费授权不跨 root 继承**。新轮次重新明确确认，走现有 `ProjectRootOperationService`、独立 root-scoped 完成审核与历史。Provider 返回的后续轮次约束不能写入资源授权前缀。

## 资源合同及 owner

`src/mission-resource-policy.ts` 定义 `NIMORA_RESOURCE_POLICY_V1:`，由 Human 产品入口写入 root 的持久 `context.constraints`，包括：版本、授权 revision、web/api/mixed、planner、Provider/model 偏好、并发 1/2 和角色模型/能力硬要求。Provider 的初始规划不能授予该前缀；宿主移除 Provider 前缀后插入自己的合同。后续 root 的 Provider 前缀直接拒绝。

`TaskRuntime.replaceMissionConstraintsStrict` 在原 Task 独占 lane 比较旧约束、追加原 `TaskContextUpdated` journal 并复读确认。重复/冲突 policy、过期比较和持久失败停止；没有第二套资源授权数据库或 Mission 生命周期。

配置偏好保存在 globalState，既有 root 的持久授权不随偏好变化。公开启动命令不得覆盖已有 root policy。分配、接班、角色续用和发送前重核当前 workspace、root、policy、Worker kind 与模型/能力硬要求。授权类只允许已接入的 Web/API；native 仍使用其独立资格门。

候选选择仍由 `MissionWorkerAssignmentService` 负责：硬过滤、候选刷新、精确身份、配置 materialization、单 Mission 单 current Worker、资源独占及失败停止。混合模式只有尚未创建/发送的 `no-admissible-candidate` 可以准备一个新网页再选择；创建结果不明、运行中或 UNKNOWN 不触发自动 fallback。

Practice Work Orders 按用户上限分成 1/2 个独立 Mission 的批次；批次之间复读 Coordinator 会话，并在不完整结果后停止。最多 8 轮的原自治上限、Evidence/Problem/Answer、子 Mission finalization 与独立 Root 正式完成保持。

## API Profile 与凭据

`NimoraApiProfiles` 使用原生密码输入及 SecretStorage。globalState 的 `nimora.apiProfiles.v1` 最多保存 8 个非秘密 Profile：稳定 profileId、非秘密 revision、名称、HTTPS endpoint、model、协议及 enabled。支持 chat-completions、openai-responses、anthropic-messages。

密钥使用 profileId/revision 绑定的 SecretStorage 项；先保存密钥再提交公开 metadata。已创建 Worker 冻结原 endpoint/model/key 配置，不因编辑、禁用或 key 轮换替换凭据。旧 revision 的秘密保留以支持被冻结会话；本阶段不自动删除它们。

候选池最多包含 8 个 Profile 和旧单配置。candidateId 只由公开配置及不含凭据派生的随机 generation 生成；密钥变化更新 generation，不输出凭据 hash/fingerprint。stale discovery 不能替换配置。会话选项仅在 adapter 内短期持有，不写 prompts/journals/诊断或 ZIP。

adapter capability 向量描述协议/事件传输支持，**不是每个模型的质量或所有功能认证**。`capabilityRequests=true` 也不等于工具执行许可，仍须 exact schema、Work Order 路径及 canonical grants。

## 规划、审核与 API Coordinator

原 `NimoraWebCognitionPool` 兼容名称保留，实际支持 tools-free 网页/API planner。API planner 不开页、不占网页资源；Web planner 继续精确预留自己的 pageId。两者都没有 workspace tools。会话身份、kind/provider/model 与无 Task 绑定重核；未知或拥有未决回合的 planner 不被悄悄替换。

Project 完成审核与恢复按该 Project 当前 root 的持久 planner policy 选择后端；全局偏好不能把已确认 API 审核改为网页。已归档上一轮且原 planner 已知空闲时，新的 Human 资源确认允许正常退休该 tools-free planner，再选择新后端。

R14 现场暴露了 Coordinator 的空参数调用拒绝：原 renderer 同时展示完整 semantic payload，API Runtime 在投递后也继续暴露同一个命令。R15 将正文留在 trusted host，仅向 Coordinator 展示命令 kind、payload SHA256 和 `{}` 调用要求；payload 摘要不是授权或 receipt。

API 单命令 Runtime 要求一次且仅一次 external call；宿主结果投递后撤掉工具，继续向 Provider 发送原结果并等待实际 tools-free response。不能把写入本地管道当 Provider 完成。返回第二个调用、多个初始调用、非法 JSON/null/array 或宿主错误均停止，没有第二次命令执行；非法 JSON 不再被转换成可获得空参数权限的 `{}`。

R15 的独立新输入还暴露了 API semantic terminal 映射遗漏：Runtime 的 `answer` 没有投影到 Mission driver 只读取的 owning terminal `result.text`。Formation/reviewer 原来能读 answer，但 autonomy 不会拿 presentation delta 代替终态事实，故正确停在空回复拒绝。R16 从实际完成的 Runtime answer 映射 canonical terminal text，保留原回合，未放宽 JSON/权限检查。

组合 fixture 已用真实 ProjectStore/TaskRuntime/Collaboration/assignment/WorkerManager/CoordinatorLiveDriver/Phase 8/host execution/Runtime 子进程，串联 Cognition JSON→一次 Practice Work Order→三次 READ/ADD/READ唯一投递→durable Evidence→下一 Cognition 决策→Practice archive→Root completion candidate。只用本地HTTP模型替身；该测试专门覆盖此前分段fixture未覆盖的终态契约。

## 观测与软排序

`WorkerPerformanceObservations` 是非 owning、有界（256 项）观测，记录 Worker/model、整回合时间、terminal 状态、时间和 `managed-provider-turn` 来源；不保存原始聊天或秘密。采样汇总为 Worker/model 的近一天、最近 8 个成功回合中位数，至少 2 个样本才可用；它不是按任务难度归一的模型评测，也不是 Profile 独立延迟认证。

排序先保留模型/Provider 偏好；所有 admitted candidates 都有有效延迟样本时才在同级 tie 上使用延迟，否则按 candidateId 确定性排序。观测异常不能改变回执，未知也不能被当成 0。**cost、quality、quota 明确为 unknown。严格金额预算、配额计费、模型质量评测和成本最优调度尚未实现，不对外宣传这些保证。**

## 验证与限制

| 验证 | 实际结果 / 限度 |
| --- | --- |
| 第一方 typecheck、compile | PASS |
| R14 最终整批回归 | 38/38 PASS |
| R15/R16 受影响整批及 Coordinator 合同 | 各39/39 PASS；R16 包含真实完整API domain/runtime组合 fixture |
| 公开 autonomy API/mixed 入口 fixture | API 无浏览器、混合 Practice、取消零发送、root policy/CAS/restart/drift、角色硬要求 PASS；不是账号 live |
| 真 Runtime RPC + 两 Profile HTTP fixture | 并行独立 Mission、冻结 model/key、轮换 stale 拒绝、唯一 READ/PATCH/READ、Prepared/Delivered 与重启一致 PASS；本地模型替身 |
| Runtime 单命令负向 fixture | 非法 JSON/null/array 零 host call；投递后无工具；非法第二调用零重放 PASS |
| Manager 边界 | 发送前策略拒绝零 Provider 调用；观测异常保持 completed PASS |
| 自治串行上限 | 两 Practice 分成 [1,1] 批次、非法 3 并行在 Provider 前拒绝 PASS |
| R14 ZIP/portable | 372870187 bytes、5995 entries、CRC/回解/关键 hash/两处 portable PASS |
| R14 API ordinary live | Formation 与初始角色成立；后续 Coordinator envelope 拒绝、三个 Mission 文件工具 0；Root/Coordinator 已正常退休；原失败不重放，不记完整完成 |
| R15 API continuation | Coordinator 单命令/无工具回执走通；终态 answer/text 缺口使两次 Root JSON 被视为空回复并停止，工具0，角色正常退休，失败保留 |
| Native discovery | R14 connected / clientToolWorkerVersion=1 / copilotcli modelCount=0；无真实模型请求 |
| Stable sandbox | 当前 appcontainer-dacl，HOST_PREREQUISITE_BLOCKED；未启动 sandbox 或修改主机 ACL |

R14 ZIP SHA256：`c97de72e06bce71b7df1eb913f71669726f41f0018a642b2072b2b27ff04c111`；主扩展 `3ed0e8e91eb148596e8a2fe7116e32656baef4b17743c781d1d2fc554d450fee`。诊断包不自动替换 current release 指针。

原记录包括：`.build/nimora-component-validation/multi-provider-r14-final-regression.json`、`multi-provider-r15-final-regression.json`、`package-components14-report.json`、两份 portable 报告，及 `.build/nimora-components-r14-multi-provider-20261006/acceptance.json` / `evidence`。R14 run `44f36ffd-10c0-4a68-8338-57e9e35b1ea6`，Project `7ae0485e-b3cd-4d3e-b73f-74957984813a`、root `ec0569a5-60fc-4eb6-9abb-c47994ec3729`、Coordinator `5f93e90f-575f-4bbc-b73b-935d9dd24e37`、Practice `66297dd5-21ae-4b20-b7db-48ba88b0dbfa`。

外部缺口单独保留：完整 API 自治/正式完成的同包 live、混合网页/API 的精确账号现场、第二个真实 API Profile、ChatGPT fresh/Skills trust/Personal Edge/现代 MCP/两站退休 archive、Native 有可用模型的请求/SDK receipt、Stable 合格 Windows isolation tier。账号或主机前置缺失不冒充工程 PASS，已组装但未现场命中的支路不归为“未接线”。

回滚使用 canonical source 正常重建，保留历史 policy、Mission/journals、keys、旧包和已消费输入；不清 latch、不换凭据、不重放失败 Provider 回合，不热补发行物或修改 Program Files。

R15 ZIP：372875586 bytes /5995 entries，SHA256 `4a7ed2db73226518745946bc728483bed53d4ee3ae78077da35fe6fbcd31b5d8`；主扩展 `67fc7db61feb88d415044a2c5d0a26ef54a94cef5210412ba6597d0b0109bb6f`，构建/回解/portable PASS。R15 run `36d3bf6d-a114-4eef-87d9-c1b9341f8cfe` 使用同一 R14 Project/root/workspace 的新输入；原29本journal装载前不变，旧R14失败不重放。`.build/nimora-component-validation/multi-provider-r15-qualification-initial.json`只锁定R15时点，后续R16状态另记，current release指针未变化。


## R16 构建和加载（2026-10-06）

R16 ZIP 372880669 bytes / 5995 entries，SHA256 `09a810f071cd2aaa51b64b46770893962873e23037166a7a5c5d823633785cbf`；主扩展 `6a3288bd3d5cfc99fe04d74b039c2c3690b649200ab8c04663e4950182e8ceab`。完整 gulp 构建、CRC、回解、关键文件 hash、原包与回解包 portable 均 PASS；无用户 profile/登录库/密钥内容。run `a5e28f17-634b-4dc6-925b-3aaf0a6987b3` 使用同一 R14 Project/root/workspace，R15 已正常关闭，29 本 journal 装载前原样。public runWebAutonomy 已单次提交新的输入流程，原生授权待确认；不重播 R14/R15 已消费输入。此处未认证真实完整 API Mission、混合账号或 RC。
