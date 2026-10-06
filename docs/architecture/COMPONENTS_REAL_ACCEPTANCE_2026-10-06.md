# 新组件真实验收准备（2026-10-06）

> **R19 正式验收通过（2026-10-07，API scope）**：新Human原生审核身份产生Root/Coordinator正式归档及Workers正常退休；三个Mission completed、current scope Workers0、3次成功唯一工具投递、Handoff digest与本root completed completion scope都已审计PASS，Practice账本/文件/历史保留，旧取消不改。完整记录`native-formal-completion-audit.json`、`native-completion-scope-state-audit.json`及最终资格报告`multi-provider-r19-qualification-final.json`。整体RC/混合fresh账号/第二真实Profile/其它外部资源/Native/Stable门仍独立；下方取消状态是历史快照。

> **2026-10-07 R19 最新资格**：真实API三次READ/ADD/READ各唯一Prepared/Delivered、durable Evidence、Practice归档与重启复核PASS；独立carrier包/CRC/回解/hash/两处portable PASS。最终完成确认实际取消，Root/Coordinator未归档；报告`multi-provider-r19-qualification-at-cancellation.json`明确RC_NOT_QUALIFIED。旧失败/取消/已消费身份与历史保留，不把fixture、completed reviewer turn或冻结R16 UI carrier当整个当前UI/所有Provider现场认证。详见[恢复与实际状态](API_COMPLETION_RECOVERY_2026-10-07.md)。

> **R16 当前执行更新**：R15 全包/回解/portable 已通过；新 API Coordinator 回执已走通，但 Runtime `answer` 未投影到 canonical terminal `text`，两次 Root 回答被当成空内容而停止，文件工具0，原回合与Project保留、Workers正常退休。R16 已修正映射，真实完整 domain→Runtime→Cognition/Practice→三次工具/投递→Evidence→archive 组合fixture及39/39回归 PASS，正在正常构建。完整账号与RC尚未验收；[当前事实](MULTI_PROVIDER_AUTONOMY_2026-10-06.md)优先于下方较早快照。

> **2026-10-06 R14/R15 当前更新**：R14 ZIP 372870187 bytes /5995 entries，SHA256 `c97de72e06bce71b7df1eb913f71669726f41f0018a642b2072b2b27ff04c111`；完整构建、CRC/回解/两处 portable 和最终38/38回归 PASS。沿用 profile/key/trust，新子目录由实际工作区信任继承（未修改信任配置）。普通 API 原生启动后形成 Project `7ae0485e-b3cd-4d3e-b73f-74957984813a`，Root/Coordinator API 分配与一次 Cognition 解释成立，但下一 Coordinator 回合 envelope 拒绝，全部文件工具0。原失败输入保留，两个角色已正常退休；完整 Mission 不记 PASS。R15 源码加固和39/39回归通过，正常重建中。Native connected/v1/modelCount0、Stable appcontainer-dacl 前置阻塞均重新实测。详细合同及证据见 [Multi-Provider 记录](MULTI_PROVIDER_AUTONOMY_2026-10-06.md)，旧证据仍保留。

当前状态：**R9 两轮、R10 第一轮正式完成与later-root入口PASS；R13真实API协调与新的有界文件Work Order PASS。** 原错误参数导致的失败完整保留，整个Practice有5次执行（4成功1失败），原Root B的总体验收/正式完成未通过。普通混合调度、Cognition自主拆解、完整新API Mission的Evidence/Finalization、网站归档及整体qualification仍开放；Stable主机前置阻塞。以下记录保留各轮当时事实。

## R13 真实 API 新 Work Order PASS（限定范围）

R13 run `98151f07-ca99-45aa-a7f5-ac30c2f22c94`；包372845992 bytes /5993 entries，SHA256 `d2cb395fa641f31141781ee52157f4fba205271836e6921e8466e3049e5d528f`，主扩展 `552b90f2cb73425cae3ea9c42ae15e65483e0430146a991f8b942dd766d70dd8`。完整构建4.2分钟、CRC/回解/关键SHA、包与回解portable PASS，两个协议修复都已实际装载。仍在原可信工作区、原隔离profile，用原生SecretStorage配置，未读key到脚本/输出或重新录入。

生产pool分配API Coordinator session `07758b9f-f001-472f-a45d-4a8d7f21aaf2`；inspect input `f661bdba-4ad6-4898-ab7c-f200ca475fab`单次canonical语义调用且completed。显式ensure创建Practice `99cb48ff-4be1-42d6-b6d7-14b65c91e06e`，生产assignment绑定API session `9f39eaa7-7c25-4013-859f-fb126ee11c02`，Phase8实际只投影read_files/apply_patch与两个字面路径。此为公开生产命令诊断，不是普通Shell混合分配或Cognition自主拆解。

原Target input `3c85fc53-5bc7-4b05-9cb8-18ab18991fc0`先成功读SEED；验收AI误将新文件expected_versions写成null，Human正常批准patch后，正确参数校验拒绝，未修改文件。错误结果已唯一投递，Driver中断Target并停止，未自动重试。不能为过验收放宽正确协议，也不删除这次失败。

明确新Work Order使用Target input `65e7ae0d-1e7b-480b-95ab-07dadbb2d271` / Coordinator input `2e89df56-eaa8-4226-943d-f84b1f9d1c16`，在原失败已知结束、B不存在、SEED/A不变后只提交一次。新增文件省略不适用的expected_versions，Add File内置存在性检查防止覆盖；现有文件版本参数仍只接受sha256字符串。新input严格3次：SEED完整读、仅新增B、两文件完整复读；3次succeeded、3对各唯一Prepared/Delivered、零duplicates/UNKNOWN/pending，Target与Coordinator都completed。B文件95 bytes/两行LF，SHA256 `065b6f8df6e93f2fa18dfd5eacad4732e732656ca993b2ee69036b45c74a4d04`。SEED/A、A三本归档journal、R9三文件/六本journal/37份evidence不变。

**PASS只覆盖这个新input。** 整个Practice有5次执行（4成功、1失败），原Root B的“恰好3次”标准仍不满足；未修改criteria、提出原Root完成候选或调用正式完成/Support Finalization。文件Artifacts与执行回执真实存在，但Cognition的Mission Evidence闭环/Finalization仍未证明。两个API测试Workers正常退休，当前Project零活跃Worker、UNKNOWN和未决投递；三个B Missions保持ready。证据：`.build/nimora-components-r13-api-schema-20261006/evidence/api-bounded-work-order-audit.json`、两个原/新outcome、retirement与事后taskCenter快照。合并启动确认源码与包已具备，本轮未重新建项，故其fresh UI live另计。

## R12 新名称映射包复测与第二处修复

R12 run `b0a51cd2-971d-4a19-8792-a0ec80b33077`，ZIP SHA256 `6d8752b0fd86e823f8d62110ff92b4cea0ee73c9fd9eec93ff669cfd5c345150`，372849864 bytes /5993 entries，完整构建/CRC/回解/包与回解 portable PASS。主扩展 `86e0b3d3f00a532dfa7c5b5f51daecfdddce0cc0aedb34c9461417b049fa541a`；正常关闭 R11 后仍在原可信工作区、同 profile 验证，五本历史 journal/SEED/A 不变。

API session `a83d5c56-21ce-49cf-b917-0f0ee0f26a23`，fresh input `4ed496ac-fb61-410f-92bf-e3d566662d08`。Provider 接受函数名拼写，随后拒绝原 `{const:{}}` 参数 schema 没有显式 object 类型；terminal=error，零语义命令和文件执行，B 文件仍不存在。原失败及输入消费保存；已知结束后正常退休该 Worker。密钥不重录，权限/信任不重复提出。

canonical Coordinator renderer 增加 object type、空 properties、additionalProperties=false 并保留 const:{}；host 仍只接受精确 empty own-data object。RPC fixture 现直接使用真实 renderer 而非自行构造 schema，并核对出站参数、wire alias、canonical 调用与回执，READ/PATCH/READ fixture 和严格原型/重复/权限拒绝专项仍通过。typecheck/build 与35组回归 PASS；R13 完整构建中，复测必须新输入，不能重放 R11/R12 原失败。合并启动确认已在 R12 源码/包中，但本轮没有重新新建 Project，故普通 UI 一次确认流程的 fresh live 仍未证明。

## R11 同工作区装载与 API 首测（当前进度）

R11 run `59c8e373-cfa9-4a55-a72c-e669d2339287`；ZIP 372840820 bytes / 5992 entries，SHA256 `f5a3bbaabe78fbd8c92d14a1c359fe8199b2cacbd5de9f13ca2ef09a0cece6f1`。完整构建、CRC/回解/关键 SHA、包与回解 portable PASS。主扩展 `70b922643bd4b24e9e9a6a635a7c80ac2c5b6cbdf02e2f3ab3afd4637b7d5291`，WebMCP `0d206513e169eedd7c2b458d2e8b7fa3248c9bb1f6a7bf51242e1e7c8f98dcfe`。同一 R10 可信工作区和原隔离 profile 保留，public trust=true；重载后共享资源列表为空，未伪造旧共享。退休 DeepSeek 页原快照无可核实 archive/menu 控件，未发送网站归档命令。

公开设置为 `https://api.deepseek.com` / `deepseek-flash`（当日官方模型文档）；原生 `shuncode.setApiKey` 密码框只提交一次，Human 确认填好。API candidate/assignment 从原 SecretStorage 配置建立本轮 Coordinator Worker，未读取密钥到诊断输出。LM registered modelCount=0 是 legacy slot 隐藏发现行为，不能代替 candidate 或真实账号健康结果。

现有 Project `884a3928-e0fe-49b7-ac5d-85275cfcd05f` / root B `0296f78c-6d24-40cf-af98-7b2535f2bc63` / Coordinator `e7af969a-67bd-4735-b40d-7850c3234a1e`，绑定 API session `927fb9c0-1eed-47f0-a15f-d944f4447145`。真实只读 inspect 输入 `40e7833c-f62d-4d2a-be6c-e4b627153d44` 被 Provider 拒绝：函数名必须符合字母、数字、下划线或连字符规则，而 canonical 协调能力名含点号。terminal=error，语义命令未执行，零文件执行、B 文件不存在；保留 original-rejection 与 consumed 记录。确定收敛后正常 owner 退休该 Worker，未重发输入、未抹掉互动历史。

canonical API adapter 现只在 Provider 协议层建立稳定合法 wire aliases；回到 host broker 时映射回确切 canonical 名，结果必须匹配 pending call 原名称。未知别名/原不合法名称/错误结果名称拒绝，不扩大工具能力。真实 Runtime RPC 与本地 HTTP fixture 验证 dotted semantic schema、调用、下一请求历史和回执；原 READ/PATCH/READ fixture 仍通过，**该 fixture 不是账号 live PASS**。typecheck/build、专项与最新 35/35 suites PASS。普通 Web 新建 Project 的合并启动确认及一次性 scope 授权同时已通过专项，尚未装入 R11。R12 正在标准构建，真实复测使用新输入。

R11 证据位于 `.build/nimora-components-r11-retired-cleanup-20261006/evidence/`。装载后四本 journal 整体未变，Coordinator 旧前缀精确保留且只新增本轮合法事件；SEED/A 文件不变。R9 六本完成 journal、三文件和37项 evidence 复核不变。总体 qualification 仍 OPEN。

页面状态已由 sign_in 收敛到登录后的聊天页。首个 start-a 返回 awaiting-share 时 Task=0；只在核对该明确结果和 exact page healthy 后单次继续。旧消费记录保留。R3 关闭前四张网页均 auth=false/composer=true/ready=true，Provider turn completed；没有未决工具执行/投递。外层建项 Promise 未取得 resolved 结果，以 canonical journals 为准，不重放。

## R4 新工作复测进度

Human 要求继续后，已正常关闭 exact R3 测试进程，启动 R4（主 PID 30460）。新 runId `aa0f4ae2-8d8e-466e-83db-7aa1bcc18082`；新工作区 `.build/nimora-components-r4-deepseek-20261006/workspace`，新 SEED SHA256 `9f3bcc06b6f434732c27ed852eb8154e6b2d95e5569665b0d5b3cca031c8338b`。沿用原隔离 user-data/extensions/shared-data 保存登录和历史，不宣称 fresh profile；旧 Project/root/consumed proof 不成为新工作身份。`evidence/history-before-r4.json` 保存旧 canonical journals 的 hash 快照。

Human 已确认信任 R4 新工作区，建项/自治/later-root/完成审核命令已启用。第一次 start-a 在 exact page 可见性检查退出：`e9dab414-b392-413a-a8ce-23b52357c3f0` 已共享、登录保留、composer=true、ready=true，但激活后 24 次观测仍 visible=false。此时未形成 R4 Project，也未修改工作区；固定 observe 确认原 session `6b72ebe7-0e8e-4c7f-aa61-f9374fb7a51d` 没有 Worker turn。控制器源码在此 guard 通过前不调用固定 control/send；原调用保持 consumed/failed，不能盲目重发。

隐藏普通通知并在主编辑区打开同一 exact page 后，visible=true；普通 activate_browser_page 再核对也为 true。尚不足以单独判定是通知遮挡或编辑区布局导致，不能修改/绕过 native visible guard。依据原 exact 前置失败、空 turn、零当前工作区 Mission 和不变 fixture，已单次提交有独立消费记录的继续操作；使用新的规划会话/输入，保留旧 unsettled session/页面 reservation 与全部失败证据，不清除其 no-replay。Human 确认后，新规划页实际收到请求并完成回复。

新页 `6c0b2f83-f4cf-4a90-99e9-67a44652ab6e`、pageSession `5a6de86c-9e99-4328-b440-504b19382b0e`、对话路径 `/a/chat/s/9916fd5b-fe2b-4344-aa53-cb362ee1d8c7`，固定资源观测为 completed。2026-10-05T19:15:14.122Z 产品在 `interpretThroughWeb` 的 JSON.parse 处拒绝（offset 639）。零当前工作区 Mission、零文件执行、仅 SEED.txt 且 hash 不变，记录 **FAIL_PLANNING_JSON_BEFORE_FORMATION**。原请求已消费，不能重新提交它。证据为 `continue-a-after-pre-send-outcome.json`、`planning-reply-page.json`、`planning-json-failure.json`。

页面只读快照显示回复为普通 paragraph，字符串内嵌数组的引号没有 JSON 所需转义。无法从 DOM 证明 Provider 原始字符串，Markdown 渲染改变转义只是推断。修复放在第一方 Web Cognition：要求单个 fenced JSON code block；site adapter 已有 code/textContent 保真逻辑。Host 仅解析完整回复或完整单个代码块，不截取子串、不自动补引号。只有已确认 completed 的无工具回合出现 JSON SyntaxError，才允许同一受管理规划会话发送一次新的格式纠正输入（fresh inputId、零 capabilities），保留回复 hash/长度观察；UNKNOWN、failed、缺失 terminal、工具请求不进入纠正。语义错误仍由原 Formation owner 拒绝；第二次格式失败立即停止，不建立 Project。该修复不是 R4 的热补丁，需要下一独立构建实测。

专项覆盖转义保真、完整 fence、纠正输入身份不同、两次上限、无子串提取、语义校验不重试、工具/传输失败隔离。extension typecheck/build、capability/task-runtime 检查及修复后 35/35 组件集合通过，日志 `regression-web-json.log`。源码测试不能代替新的真实网页验收。

R4 fixture 与 A/B 请求明确要求两个工具、两个字面文件路径和三次唯一 READ/PATCH/READ；也要求工具限制进入 Mission completion criteria，不能以旧 R3 默认 profile 的额外工具作为验收范围。原始证据：`.build/nimora-components-r4-deepseek-20261006/evidence/`，包括 start-a-outcome、planner-no-input-after-reveal 和 continue-a-after-pre-send-consumed。修复后文件工作与正式两轮完成均尚未现场通过。

## R5 修复包与继续验收

完整 standard `vscode-win32-x64` 构建已通过（`package-components5-resumed.log`）；此前一次缺少 SDK signtool、一次等待期间中断的尝试保留，不算成功。R5 包内扩展与最新构建输出 SHA256 一致：`d780c167e1eee57c79814ff75ffdf066f3810e813642c2279f318808db2f0b61`。新 ZIP 为 `.build/releases/Nimora-Beta-Windows-x64-20261006-Components-R5.zip`，372837695 bytes、5992 entries、SHA256 `974ed238989f81548df482dae0f17e47f009a482214d5a4ed9d4b636c1c337d7`，CRC、回解关键 hash、目录及回解 portable 检查均 PASS。受影响组件恢复后 35/35 PASS（`regression-web-json-resumed.log`），不替代真实模型验收。

继续时观测 R4 测试进程已退出，退出原因未核实；本轮没有强制关闭它。R5 runId `c9d8a118-53e4-42b0-9b6e-fc8d47d5963f`，主 PID 28464。沿用原隔离 profile 和**未改动的 R4 fixture 工作区**，明确不是 fresh profile/workspace；SEED hash 仍为 `9f3bcc06b6f434732c27ed852eb8154e6b2d95e5569665b0d5b3cca031c8338b`。工作区没有 R4 Project/Mission，因此新请求可从正常入口形成新的 Project/root/input，不接管或重放 R4 失败身份。新请求要求写入 R5 标识结果，范围仍只有两个工具与两个字面文件路径，旧消费及账本不清理。`history-before-r5.json` 保存启动前 journal hash。

新实例工作区 trust=true，start/later-root/review 命令全部注册。`start-a` 单次提交，Human 已确认并共享；新页 `466b76ca-43be-4a85-ad7f-bdcdc5b92f67` / pageSession `62057ddd-909e-4414-80cb-dcd637342917` 的真实回合 completed，JSON 已正常解析。产品随后在 Worker provider 预检拒绝：模型声明完整 requiredCapabilities 向量，其中 reasoning=true，而实际 WebMCP adapter reasoning=false。记录 **FAIL_UNPROVEN_WORKER_POLICY_BEFORE_FORMATION**，仍零 Project/Mission、零文件执行，SEED hash 和文件集合未变。证据在 `.build/nimora-components-r5-deepseek-20261006/evidence/planning-policy-failure.json`；原请求消费保留，不重发或手工改写回复。产品确认来自 `createWebProject` 的 modal Human 入口。同配置跨包启动仍有旧主题字体资源路径拒载，未冒称 UI 日志零错误。

进一步核对发现：正常 candidate enumeration 排除了专用规划页，因此 Formation 提示中缺少已选 DeepSeek backend 的观测；提示中的 Native 候选能力向量与模型声明一致，但不能断言模型内部为何选择它。现在由原规划 owner 单独 refresh descriptor + health，前后核对 exact managed/adapter identity、idle、无 Task、非 unsettled，得到 `owned-tools-free-planner` backend 观测；页面仍保留在规划 reservation 中，不作为可分配候选。解释前提供该数据，建项预检前再次读取，只用于 Worker 形状/model 预检，不授予工具，不跳过实际新页 assignment。

同时说明 requiredCapabilities 是事件/传输形状需求，不能把整个候选 capability 向量照抄为硬要求；Cognition 推理不自动需要 reasoning 事件流，文件语义能力仍用 requiredCapabilityIds。预检可接受原健康规划 backend 的真实支持证明；unsupported reasoning=true、未知模型、错误 Provider、不健康/漂移会话继续拒绝，不删除硬约束。新增正负向测试和 35/35 受影响回归 PASS（`regression-planning-backend.log`），typecheck/build PASS；R6 独立构建和真实验收待继续。

## R6 修复包与当前操作

standard 完整构建通过（`package-components6.log`）；source/package 扩展 SHA256 一致 `ae9563386744216b58ab49476fac7b30cb5212ff93efe83bb640e9417fcd17b5`。R6 ZIP `.build/releases/Nimora-Beta-Windows-x64-20261006-Components-R6.zip`，372828050 bytes、5992 entries、SHA256 `8be469043c80e8e26f837091991eaef26e9937099bbb7b856b5f329f348f5dc5`，CRC/回解关键 hash、目录及回解 portable 检查均 PASS，不含 profile。没有绕过构建检查或修改旧包。

R5 原操作明确 rejected、所有 enabled Provider turn completed、零未决 execution/UNKNOWN/delivery、当前工作区无 Mission，才正常关闭 exact R5 窗口，没有 force kill。R6 主 PID 6764，runId `21dcf62b-0600-4c62-a0b9-2cce4b8f21da`，同一已信任 R4 fixture 与隔离 profile 保留，旧 canonical journal hash 在 `history-before-r6.json`。新请求、结果标识为 R6，仍只允许 read-files/apply-patch、两个字面文件路径和三次唯一 READ/PATCH/READ；旧 R4/R5 失败输入不重放。

当前 `start-a` 单次提交，trust=true、start/later-root/review 命令已注册。规划页已 completed，Root/Coordinator 两张新页已共享；JSON 与 backend 预检实际通过，canonical ProjectCreated 含 formationReceipt。Project `b63a6b3f-aef3-4b74-a499-b76776af7e20`，Root A `77055b8c-8994-4906-96b0-e8660a6a58ca`，Coordinator `d64d0425-e622-4bf1-b303-f96f58c1ba2a`，Practice `1f67ba21-9832-4d64-b783-65b4a5bfef38`。`formation-audit.json` 核对唯一新 root、持久 receipt、三个 Mission 和未变 SEED；这一步是 FORMATION PASS，不是文件或完成治理 PASS。

Human 已确认启动自治，实际恰好三次 READ/PATCH/READ 各 succeeded/prepared/delivered，零 duplicate/UNKNOWN/running/pending。只有一次 add-only patch；SEED SHA 未变，结果原始 LF 字节正确，SHA256 `6807825997e3b87bb13461a111e7a25f213bdf99c692b0d4be469dd982d85cbe`。`root-a-audit.json` 核对实际 canonical execution/input policy 与工作区文件集合，记录限定文件与能力 PASS；Practice 已正式归档。只读 workspaceState 的 `autonomy-terminal-workspace-state.json` 证明循环已产生 completion-candidate；外层 start-a 仍 pending 在完成信息提示，不重放它。

独立 `review-a` 已单次完成且明确 blocked：reviewer 把运行 ID 推断成 SEED 内容要求，未发送 completeManagedScope，Root/Coordinator 未归档、Root B 未开始。canonical root context 实际要求 `seed=<SEED 真实首行>`，READ/patch/read 与审核者字节比对一致。`first-review-outcome.json`、`completion-review-blocked.json` 保留拒绝和原约束；源码事实是审核投影漏带 Mission context/constraints 和 inputAccessPolicies，不能把模型内部推断原因说成已证明。

修复在第一方 `nimora-project-completion.ts` 与正常 completion composition：每条 Mission 的当前持久 context、路径策略一起提供，later root 从本轮 context 读取，不复用初始 root 的验收标准。提示要求实际 READ 推导动态值，不从 Project 标题/ID/旧对话增加内容标准；路径策略与 canonical diff 核对变更范围。保留整包 48000 字符上限及确认后整个证据重读，不截断、不自动语义纠正、不强制通过。专项覆盖动态 seed、本轮 B 路径、确认期间 context 漂移拒绝及超限零发送；typecheck/build/runtime/Web assembly PASS。完整 R7 standard 构建和新的现场审核另计，不热改 R6 包，不重发其补丁。

变更日志（2026-10-06）：R6 严格文件链现场通过；保留独立完成审核 blocked，补当前 Mission context 与路径策略证据接线和负向验证，正式完成/第二轮维持未通过状态。

## R7 完成审核修复包与新验收入口

两次完整 standard 构建均完成扩展编译与 Core bundle，但 package 阶段因 Electron `v42.7.1/SHASUMS256.txt` 的 GitHub 直连超时失败（`package-components7.log` / `package-components7-resumed.log`），失败不计 PASS。诊断日志确认 `UND_ERR_CONNECT_TIMEOUT`。通过 GitHub 官方 release asset API 获取同一文件，实际 SHA256 `52ed282a72bdec2a51490c16c76f6630c86ccb89622766519759da39a45d6b70` 与官方 asset digest/size 一致；只在本次构建进程改下载入口，未生成/伪造校验文件、未禁用原 checksum 或签名校验、未改系统代理。标准 `vscode-win32-x64-ci` 在已完成的同源码编译输出上通过（`package-components7-official-asset.log`）；真实 Windows SDK PATH 仅作用于该 shell。没有热改旧包或 installed distribution。

R7 目录、ZIP CRC/回解关键 hash、回解 portable 检查全部 PASS。ZIP `.build/releases/Nimora-Beta-Windows-x64-20261006-Components-R7.zip`，372827784 bytes、5992 entries，SHA256 `172dcfcfa5a6c403fd6ef336d91f724d25f246df31f5a9280893a3c097a455d7`。source/package 扩展 SHA256 一致 `b89abb674db121434e8fde8a6760966b799668fb81fa2c3fc770d1edd2de8431`；profile 不进入 ZIP。完整编译尝试与最后标准 packaging 的结果分开记录，不将失败尝试写成通过。

R6 原循环 terminal completion-candidate 已存 workspaceState，独立 review-a resolved/blocked，所有 enabled Provider turn completed、零执行 UNKNOWN/running/pending，才正常关闭 exact PID 6764；外层信息提示 Promise pending 的记录保留，无强制结束或完成伪造。旧 Root/Coordinator 未正式归档，原账本/文件/消费仍保留。R7 主 PID 30360，runId `85568fd4-23fc-493b-b244-8dd0716a45bd`，新的 `.build/nimora-components-r7-deepseek-20261006/workspace` 与新 SEED（SHA256 `a5811ba0d112fb8a4a1c691d5774f25da67ebd656d759222bdc38b9c8b406639`）。SEED 首行的 fixture ID 刻意独立于 run ID，内容仍必须由真实 READ 推导。沿用原隔离 profile 保存登录与历史，明确不是 fresh profile；启动前 old journals 的 hash 在 `history-before-r7.json`。

Human 已完成 trust 和新的规划页共享。第一次 start-a 在 exact page 可见性 guard 退出，没有进入 control/send；原 page/session 空 turn、零新 Mission/不变 fixture 的证据保留。正常隐藏通知并打开原 exact page 后可见，尚未证明具体布局根因。仅在这些前置下单次新的继续操作，保留旧 consumption 与 unsettled reservation；新的规划回合、Project 与 Worker 绑定成功。

持久身份：Project `80ba455b-bc4b-4f09-9ca0-351b0641d011`，Root A `646fed18-d98d-4776-8208-32271f3984ba`，Coordinator `a7eca038-de26-4114-aacf-80a5f86b5ea7`，Practice `5ae13ff9-44ee-49f7-8edb-0d71f959aa33`。`formation-audit.json` 核对 canonical receipt；`root-a-audit.json` 实际核对恰好三次 READ/PATCH/READ succeeded/prepared/delivered 各唯一、无 UNKNOWN/pending/duplicate、一次 add-only patch、SEED 未变、结果原始两行 LF 正确。A 结果 SHA256 `e5e68325b2c572827c5560d8e8aa200fd5fa18bba04f2c3ffa57dbdfc6fc55b7`。Practice 正式归档，自治持久 terminal completion-candidate；外层 continuation Promise pending 不成为重发理由。

独立 `review-a`（05:57:10Z）和一次新的 `review-a-fresh`（06:03:10Z）已分别 rejected。两个 completed assistant 回复均是合法 JSON 的 ready/summary，但完全没有 instruction。strict parser 两次拒绝，没有进入 Human 完成确认或发送 completeManagedScope；Root/Coordinator 未归档、B 未开始。`first-review-rejected-workspace-state.json` 只读证明完成消费为空；原页面、失败、两个新的 completionKey 和 `completion-instruction-rejection.json` 保留。再次审核是原审核终态明确／无完成命令消费／全部 Provider 回合 completed 后，通过正常入口发出的新无工具审核，未重发文件操作。此后停止相同提示的审核。

源码把非 JSON 的 instruction 占位符换为完整有效 ready JSON 示例，带本轮实际四个身份字段；要求只修改 summary，复制顶层 EVIDENCE.instruction，不允许使用旧 review 或 Mission prose。strict parser、Human、全证据重读、原 owner 和 scope no-replay 不变；host 不补漏字段，没有自动语义重试。专项新增缺 instruction 零确认／零保存／零执行和本轮示例身份核对；typecheck/build/Runtime/Web assembly PASS。R7 原包不热改，新独立构建的现场结果另计。

变更日志（2026-10-06）：R7 有界文件主链 PASS；保留两次完成审核缺字段拒绝，修正输出契约示例并验证拒绝路径，正式完成与第二轮仍未通过。当前 R7 manifest 为 ROOT_A_FILE_PASS_TWO_COMPLETION_REVIEWS_REJECTED_MISSING_INSTRUCTION / ROOT_A_BOUNDED_FILE_PASS_FORMAL_COMPLETION_NOT_ACCEPTED。

## R8 完成指令输出契约与新工作区

完整标准 `vscode-win32-x64` 构建 PASS（`package-components8.log`），仅本进程沿用同一 GitHub 官方 checksum release asset 下载入口，原 Electron checksum 与真实 SDK signature 验证保留；没有 R7 热补丁或系统代理修改。源码/包扩展 SHA `d58d9e8a7e5b0ea40ec2c7870690ebe85f06489a188e18473ccf4b47e2a38201`。ZIP `372833877` bytes、`5992` entries，SHA `53ef216cdbd269e9a717f37b16417da6145c4bbfcedecd03637bf90dd6c6746f`，CRC/关键 hash/回解 PASS。目录和回解后的实际 packaged Electron/Gateway/Windows certificate native 运行均 PASS（`portable-components8.json` / `portable-components8-from-zip.json`），无 profile 进入包。

新 run `109d026c-a0b0-4844-b737-97acc562e689`，工作区 `.build/nimora-components-r8-deepseek-20261006/workspace`，SEED SHA `3998a1d568bbdc9bbbf00c43f966dd0d9f3e4b859b60a19bde22d81319c02ec3`；fixture ID 与 run ID 独立。沿用原隔离 profile 保留登录和全部账本，不是 fresh profile。R7 全部实际回合 completed、唯一失败原页固定空 turn、零 UNKNOWN/running/pending、自治 completion-candidate 持久化、两次 review 已 rejected 且完成消费为空后，才正常关闭 exact PID 30360；未 force kill、未删除 journal 或修改 R7 未归档 Root/Coordinator。新主 PID 27900，启动前 old journal hash 见 `history-before-r8.json`。

Human 已完成 R8 trust，trusted=true 且 start/later-root/review 命令启用。start-a 单次提交后，已确认并共享的新页 `064142ea-d19a-469f-8409-036385af0510` / pageSession `c5a66a46-b6ae-4bc2-8770-84915fa6895f` 在发送前可见性 guard 被拒绝；固定 observe 显示原会话 turn 为空，零 R8 Mission/不变 SEED。正常 hideToasts 和 public vscode.open 到 exact 主编辑区后 visible=true，尚未证明具体布局根因。原失败消费／unsettled reservation 保留，未进入 control/send。`pre-send-visibility-failure.json` 与 before/after 固定观测保留。

仅在原发送前失败、空 turn、零本轮 Mission/结果、不变 SEED 和实际恢复可见的强前置下，单次 `continue-a-after-pre-send` 通过正常产品入口提交新的规划会话／输入。此新规划已形成 Project 并正式完成第一轮，第二轮决策 blocked，完整两轮验收尚未通过（补记如下）；新请求不重发原 input，旧 no-replay/页面 reservation 不清理。限制仍为 exact READ/PATCH/READ、两种能力和本轮两条字面路径。

变更日志（2026-10-06）：R7 两次审核缺字段失败保留；修正有效 JSON 示例，专项/typecheck/build/Runtime/Web assembly 和组件 35/35 PASS。R8 完整构建、ZIP 与回解运行检查 PASS，正常切换已收敛 R7 到新 fixture，实际账号两轮验收待继续。

## R3 Root A 实测与修复

本节是历史 R3/R4 记录；当前运行状态见上方 R6 与下方 R7。

- Project：`b3697806-0173-4116-b4e5-5715c5997ff1`；Root A：`9a01deb7-de1e-463c-9510-a70eae0cda10`；Coordinator：`90da37f4-a630-4230-8da0-6e493ab4e383`；Practice：`382152f8-650d-431e-95cb-5eeccafe88e7`。
- input：`433f0a96-76d8-4d62-82e5-b0316281ced7`；managed session：`a7a1c94f-992e-43ad-96dc-b0e07cce4697`。Canonical journals 确认 read_files → list_directory → apply_patch → read_files，四条 succeeded/prepared/delivered，各唯一，无未决投递。一次 patch 只创建 ROOT_A_RESULT.txt；两个文件均完整读取并验证。
- SEED SHA256：`d3bdbdcbe70f15226631541f88d1249a8702de0394a2954231b32dbe94dfe387`；结果 SHA256：`e1c994d09e292e5ef5ec164a3e0b21adbbd06f102e79d0a39845195d6ca93382`。审核脚本直接比较原始 LF 字节、SEED hash 和工作区文件集合。证据：`evidence/root-a-audit.json`。
- 页面只读摘要核对：Cognition 的 Work Order 声明 requiredCapabilityIds=[workspace.read-files, workspace.apply-patch]；默认 Practice profile 仍附加了 list-directory。`required` 原来是必须提供项，不是上限。这是具体组装缺口，不能事后扩大验收范围来消除失败。
- 新增可选 allowedCapabilityIds 上限，明确空数组保持无工具；required/optional 超出上限在读取 owners 前拒绝。输入物化保留上限，发送前重新物化检查漂移；普通 profile 调用不受影响。Product/Autonomy 的明确 Work Order 把声明能力同时作为上限，禁止额外默认工具。既有 grant/path/execution/delivery owners 不变，不增加权限。
- Capability/Input/User-entry/Autonomy 专项 PASS，extension typecheck PASS；`.build/nimora-component-validation/regression-scope-ceiling.log` 为修复后的 35/35。源码修复不能改变 R3 已发生的目录读取，也不能代替 R4 fresh live acceptance。

历史 R4 实例使用上级 `VSCode-win32-x64-components4-20261006`，R3 原包及记录保留。ZIP 为 `.build/releases/Nimora-Beta-Windows-x64-20261006-Components-R4.zip`，372827280 bytes，5992 entries，SHA256 `c50f890a79c0ea80ce86ec7c8ae20caec56b70e8d2e75aea9bac6bbba93963f4`。CRC/回解关键文件 hash、目录与回解包 portable 均 PASS；source/package extension SHA256 一致为 `f358a6ed245387fbde807d30dc8756b9a01ed3097c239bbeca6f067d17c60de4`，确含能力上限修复。没有用这些检查替代真实 Provider 复测。R2 启动暴露的 AgentHost 设置 scheme 和管理连接 reverse channel 两处问题已在 R3 修复，R4 保留；旧候选均不覆盖。

验收 runId：`e77e160d-3665-49a9-a6b0-017f388bc10b`。工作区为 `.build/nimora-components-r2-deepseek-20261006/workspace`（目录名保留最初准备代次），包含审核者准备的 `SEED.txt`；Root A/B 请求保存在同级 `ROOT_A_REQUEST.txt` / `ROOT_B_REQUEST.txt`。R3 使用同一新建独立 user-data/extensions/shared-data；切换时工作区仍未信任、产品命令尚未启用，未发送工作输入，原记录未清理。随后 Human 确认信任，命令已注册。`evidence/start-a-command-consumed.json` 在提交前记录一次消费，`start-a-command.json` 证明已提交普通 `shuncode.nimora.startWebProject`，不得再次运行 start-a。网站登录、逐页共享和产品治理仍由 Human 完成。

证据：`.build/nimora-components-r2-deepseek-20261006/evidence/`。R3 实际 server discovery 为 connected / clientToolWorkerVersion=1 / copilotcli modelCount=0；这是服务端合同和 SDK 启动验证，没有 Copilot 模型工作验收。定向启动回归 8 passing；Node owners 938 passing / 17 pending、浏览器 168 passing、组件 35/35 是此前受影响集合的独立结果，不相加冒充整个仓库的统一全量。

保留 installed ShunCode、所有旧 profile 和 consumed proof。新验收只能创建新的 Project、root、input、绑定和操作身份。跨 R2/R3 同配置启动发生过旧路径主题字体缓存被 `vscode-file` 拒载；这是已记录的配置缓存现象，不能将定向 AgentHost 错误消失写成全部 UI 日志零错误。

## 现场流程

1. 使用当前修复后的发行包与独立 user-data/extensions/shared-data、新 workspace。R3 原实例/账本保留；不能热改其结果。需要账号的登录、网站验证和个人 Edge 共享必须在应用中完成，密钥仅进正常 SecretStorage，不写报告/仓库/聊天。
2. 在普通 Nimora 产品入口形成新 Project。第一轮只允许 `SEED.txt` 和 `ROOT_A_RESULT.txt`；没有 terminal/network 权限。SEED 是审核者准备的 fixture，不是 Worker 产物。要求 Practice 做完整 READ → 一次带版本保护 PATCH → 完整 READ，结果只含指定两行。
3. 等待真实 Cognition 判断 completion candidate，再走产品完成审核。限定两种能力的成功验收应恰有三次 execution，均有唯一 Prepared/Delivered，零 duplicate/UNKNOWN/pending；任何额外能力保持失败记录。核对证据/产物 hash 和正式 archived history，不能仅凭文件正确确认整轮通过。
4. 在**同一 Project** 使用「下一项工作」形成 later root。第二轮只允许 `SEED.txt` 和 `ROOT_B_RESULT.txt`，使用新的身份/Worker/授权。核对 Root A 的历史与 consumed completion scope 不变；Root B 能独立完成审核；普通入口不再因多个历史 root 拒绝。
5. API Worker 使用产品内配置的真实账号与当前模型，走 production candidate/assignment；工具调用必须经过原 Mission grant/path/execution/delivery，不回到本地 file MCP。实际完成一次 READ/PATCH/READ，并保留真实模型/路由/唯一投递证据。
6. Copilot AgentHost 验收前检查 Root server schema v1 和 bridge v1 同时存在，以及所选模型确实可用。真实模型仅能请求 external custom schemas；文件执行仍由 canonical Mission executor 完成。客户端 echo 不能当 receipt，SDK 服务端 receipt 才允许 delivered。没有 builtin/MCP/SDK 命令执行证据；其它 native backend 保持 gated。
7. Modern MCP 用 fresh Target-bound route 验证协议、调用和唯一投递。不得重用任何历史 Phase11 Skill/proof 指定的 Target、Practice 或已消费身份。
8. 外部 Skill 必须由本轮 root 重新选择来源/内容信任，后续 root 不继承。对内容漂移/disabled/revocation 的发送前拒绝保留证据。
9. 个人 Edge 由用户本机配对并主动共享新标签页，验证授权页操作、切换/解除配对后的旧命令拒绝。使用无个人资料的测试页。网站会话清理只选 fresh 已退休且空闲的测试 Worker binding，经产品确认后核实网站实际归档；未确认或结果不明均保留 consumed/no-replay，不 fallback delete。

## 主机与证据界限

当前主机只有 `appcontainer-dacl`，Stable 要求 BaseContainer 或 AppContainer+BFS。live certification 在准备/启动之前拒绝当前主机；不做 ACL 绕过，不改 osSandboxLiveCertifiedOnCurrentHost。需要符合要求的主机再重新验收；Beta 功能通过不能代替这个门。

每个现场结果报告都应列清新身份、真实 Provider、授权 scope、execution/delivery 数、hash、失败/UNKNOWN 和完成治理状态。任何结果不明只核对已持久身份，不能重新发送原 request。出现失败也必须保留账本与证据；禁止把历史 profile 复制后清空 journals 来伪装 fresh。

## R8 真实完成与第二轮决策修复补记

### 2026-10-06 R8 第一轮正式完成与后续轮次决策修复

R8 Project ac6327c8-f5b1-4ce9-97b7-e80647ef819d 的 Root A 5ba8afb5-1a74-4d7e-be28-4a8b001e3372 已通过恰好三次 READ/PATCH/READ、独立 ready 审核含精确 instruction、Human 确认与 canonical 完成消费。Root/Coordinator/Practice 均已归档、Workers 退休，文件保留；证据 root-a-audit.json、root-a-completion-audit.json。普通 startNextProjectGoal 在同一 Project 创建 Root B 9037a562-3d29-44ca-aa4f-087b742cd0bb，later-root-formation-audit.json 证明当前活动 root 选择、旧 A 三本 journal 与文件 hash 未变。

R8 第二轮自治已由 Human 启动并共享独立页面，但首次 Cognition 决策错误目标 root；一次有界纠正的 DOM paragraph 字符串内嵌引号不合法，strict JSON 拒绝。持久自治为 blocked，尚无 Practice B、文件工具或 B 结果，第一轮 completion scope 保持 completed；root-b-blocked-audit.json 保留事实。无法取得 Provider 原始字符串，Markdown 改转义只是推断。原消费与失败保留，R8 不热改、不重发。

Canonical MissionAutonomyLoopService 的结构化回复现在要求一个完整 fenced JSON code block；Host 接受完整裸 JSON 或完整单个 json/无标签 fence，不截取子串、不修引号、不扩大字段／权限／长度或纠正次数。提示明确 Work Order 仅能指向现有活动 Practice；无合适 Practice 时先通过 additionalMissions 建立。修复创建子 Mission 后 workOrders 为空直接 quiescent 的断点：下一有界轮次重新读取 canonical id 再决策，仍最多八轮，没有后台任务。专项真实 owner 组合测试证明空后续 root -> 建立 Practice -> canonical id -> 一次 Work Order -> 证据/child finalization，root 正式完成 gate 保持；多个代码块／前后 prose／坏转义／未知字段与超限拒绝，八轮上限通过。typecheck、compile、组件 35/35 PASS，新包真实验收另计。

变更日志：R8 A 正式完成 PASS、同 Project B 建项 PASS、B 决策拒绝明确保留；补 Mission 结构化传输和 decomposition 下一轮接线，所有 no-replay／Human／UNKNOWN guard 不降级。原页面无发送的诊断表明 hideToasts 后仍 invisible、随后 native activate 可见；不足以证明最初布局根因，当前未修改可见性 guard 或 Core。

## R9 Mission 结构化回复与后续轮次修复包

完整标准构建 PASS（package-components9.log，2.82 min），ZIP 372828868 bytes、5992 entries，SHA `f0d2fffdc47718a674728bd6b5a304cfebfabb633e81ea11d9b78b36ef030d97`；扩展 SHA `ae3682621db0dfe84813291cb94306b6e7013e341a9b998f22ced6a8216d609e`。CRC/回解关键 hash、目录与回解 portable 全部 PASS，无私有 profile 入包。

新 run `4f016890-ce4d-4467-9fcc-953aeeca16af`，新工作区 `.build/nimora-components-r9-deepseek-20261006/workspace`，复用原隔离 profile 保留登录与所有历史，不是 fresh profile。原 R8 exact PID 27900 已在所有实际 Provider completed、失败规划页固定空 turn、工具全部 settled、A 完成 journal/hash 未变、B durable blocked 后正常关闭；B 未完成保持，未 force kill／清账本／重发。新 PID 29424。初次 trust gate 确认零新 Project/Mission/Provider 输入和不变 SEED；Human 随后信任，三个产品命令启用，start-a 已单次提交，首次请求因通知浮层的 native 可见性 guard 在发送前拒绝；原空 turn/不变 fixture 已核实，原消费保留，已单次新的规划会话继续并等待新页共享。尚无本包完整两轮现场 PASS。

变更日志（2026-10-06）：Mission JSON wire encoding 和 decomposition continuation 修复的新包与历史运行包分离；隔离回归通过，正式 Provider 和 Stable gate 继续独立报告。

## R9 发送前通知遮挡历史阶段补记

### 2026-10-06 历史阶段快照：R9 发送前通知遮挡实证与源码修复

R9 首次 start-a 在 exact page ebe99dd3-eb25-4a80-a724-9e246248c160 / session 3a0c19be-930b-4ca6-85e1-b2f6f365de9d 的 native visible guard 退出；原固定 observe 为首页、空 turn，零当前工作区 Mission/Project 和文件工具，SEED 与文件集合不变。原失败消费／unsettled reservation 保留。visibility-presentation-diagnosis.json 逐步证明 native activate 单独仍 visible=false，随后仅 notifications.hideToasts 即 visible=true，页面/会话/URL 不变、没有 Provider 输入。已证明通知浮层遮挡；尚未识别具体通知内容或发起组件，不冒称某一 toast 来源。强前置核实后单次 continue-a-after-pre-send 采用全新规划会话／输入，当时等待原生 Human 新页共享，随后已完成两轮正式验收，不重发原失败输入。

WebMCP canonical extension.js 的 exact-page visibility owner 增加一次通知呈现恢复：在激活后的新鲜共享身份/URL 核对仍不可见时执行 notifications.hideToasts，再在原期限内重读真实 visible；不会隐藏/确认 modal Human 授权、共享页面、导航、发送 Provider 或绕过 guard。通知仍保留在通知中心。node --check、fixed-control（toast 恢复／modal 仍阻塞／URL 漂移／命令失败）和 internal-browser/Web assembly PASS。另修复 retired cleanup 调用可见性 owner 时误用位置参数，改为 exact 身份对象；实际 Extension callback DeepSeek/ChatGPT 接线及漂移预拒绝专项通过，未对真实账号执行归档。

source SHA 97de445a8cfe3fde4ba405d1bc389fd7d1020b4d29a1cc66081103257c4390e1，当前 R9 包 WebMCP SHA 16de8e0dbcdaa2ce88bbca362c6b0bb89ddbd01297e02343dd4ad4d60bed9b79；源码修复尚未装入 R9，绝不热改活动包。记录 visibility-toast-validation.json；新版打包/live gate 另计。

变更日志：保留 R9 首次未发送失败，正常呈现恢复与一次全新规划继续；补发送前的通知浮层呈现恢复及 cleanup 参数接线，既有 identity／visible／Human／no-replay guard 保持。此阶段尚未通过完整 R9 两轮；最终两轮 PASS 见下方当前结论，其它 Provider/Stable 仍开放。

### 2026-10-06 R10 有界资格验证启动时快照（后续进度见下节）

Human 授权开始后，R9 exact PID 29424 在六个 Mission 完成/Worker 退休、所有真实回合 completed、原失败页固定空 turn、零未决执行/投递且旧 hash 不变时正常关闭。R10 PID 10328，run `80ac8146-46cd-4bc0-921b-d75250ac7971`，新 fixture 位于 `.build/nimora-components-r10-deepseek-20261006/workspace`；原隔离 profile/cookies/journals 保留，非 fresh profile。主扩展/WebMCP 与 R10 report hash 匹配，未热改任何包。初始 trusted=false、产品命令未启用，尚未发送新的工作请求，只有不变 SEED；当前等待原生 Human trust。R9 三文件、六本已完成 journal 与37个旧 JSON evidence 保留核对，证据见 R10 `r9-preservation-baseline.json`、`history-before-r10.json`、`initial-trust-gate.json` 和 `r9-close-consumed.json`。R10 UI/cleanup live 与其它通道仍未通过；Stable 保持 HOST_PREREQUISITE_BLOCKED。

### 2026-10-06 R10 第一轮、真实通知恢复与后续入口进度

Human 已完成 trust 和逐页共享。R10 Project 884a3928-e0fe-49b7-ac5d-85275cfcd05f / Root A c91ad791-4f2a-4066-b009-e961175ce145 的严格三次 READ/PATCH/READ 和独立 ready+instruction/Human 正式完成 PASS，三个 Mission 归档、三个 Worker 退休；SEED 不变，A 结果 SHA ab15b2dd2cd9592afec9f6ced6046818ae23a7424ed1405cc3fbfdc05458747f。公开 start 在08:03:56Z返回 completion-candidate，review 在08:14:53Z返回 completed。窗口 focus 后受控普通通知使 exact planner true→false，正常审核入口恢复 true并完成审核；未触发的早期尝试/脚本错误保留。不独立声称用户从未关闭过 start 终止通知，该性质由 unresolved-notice 回归保护。

同一 Project 的 startNextProjectGoal 仅提交一次，08:32:43Z 返回 ready-for-autonomy。Root B 0296f78c-6d24-40cf-af98-7b2535f2bc63、Coordinator e7af969a-67bd-4735-b40d-7850c3234a1e 初始无 Worker/interaction/execution，未启动自治，B 文件不存在。A 两文件/三本归档 journal、R9 三文件/六本 journal/37份旧证据核对不变；证据为 R10 later-root-and-ui-audit.json。

archive-a 原公开命令08:18:43Z在目标筛选拒绝，未进入选择/确认/网站副作用。实际共享页面是 completed，产品与 WebMCP 执行前两处只接受 idle。两个 canonical owner 已修为显式 idle/completed，保留退休绑定、identity/URL、未决 Task/投递、Human 与 no-replay；running/UNKNOWN/failed/interrupted/缺状态、可见性准备后变 running均阻止归档。类型检查、编译、组件35/35、真实 callback 模拟、JS语法及 diff check PASS。R10 包不热改；R11 标准构建进行中，网站归档未验收，整体资格验证仍开放。下一步沿用已信任 R10 工作区/Project/profile加载新包，避免新的目录 trust。多后端功能与 Stable 状态不变。

### 2026-10-06 R9 完成时验收结论与收尾变更（历史包状态）

R9 run 4f016890-ce4d-4467-9fcc-953aeeca16af 已在同一 Project 5c291faf-842a-448e-8e09-11e40c0fb0d5 真实完成两轮。Root A ada435ca-9bdd-4cdb-a88f-a09aeced3786、Root B f2cbcb7c-0c36-434b-acc6-216926f2d5d2 各恰好 READ/PATCH/READ 三次唯一 succeeded/prepared/delivered；六条执行无 UNKNOWN/未决投递。两轮各经独立 Web Cognition ready+精确 instruction 和产品 Human 确认完成，completionKey 分别 ec5cf29f-fccf-4999-973b-318d39d88ed8 / 89b916f6-6615-4e4a-b488-3d125c5deb6c；六个 Mission 归档、六个 Workers 退休。B 从普通 later-root 入口创建，初始无 Practice，经自治 decomposition 建立 Practice 并继续下一轮。SEED、第一轮文件及三本已归档 journal 在 B 完成后保持不变。two-root-final-acceptance.json、root-a/b-audit.json、root-a/b-completion-audit.json 是不可变证据。此前 R3–R8 失败不改写；R9 首次未发送页及原消费保留。

源码收尾：WebMCP 在 exact-page 激活和身份核对后一次隐藏普通 toast，再重读真实 visible；modal Human 授权、共享、身份/URL、发送与 no-replay guard 保持。退休会话 cleanup 改为传递 exact-page 身份对象，实际 callback 隔离正负向测试 PASS，尚未归档真实账号。Nimora 自治 terminal 信息提示改为非阻塞，durable outcome 保存后直接返回，避免用户未关闭通知时产品建项 busy 一直占用；启动 modal 仍等待 Human。未关闭终止通知也正常返回及取消启动零分配/零运行测试、typecheck/build、组件 35/35 PASS。R9 活动包未装这三项收尾修复，不热改；R10 已独立打包，CRC/回解关键 hash 与 portable 结果见 package-components10-report.json；新版呈现/命令返回的真实网页验收另计。

剩余现场：真实 API Worker、原生 Copilot（当前 server schema v1 但 modelCount=0）、Personal Edge、外部 Skill 人工信任、现代 MCP 账号路由、真实退休会话归档；本次有界文件验收不代表所有工具/并发/接班/重启分支均 fresh live PASS。Stable 仍 HOST_PREREQUISITE_BLOCKED（BaseContainer/BFS 缺失），不得降低安全 gate。未来维护/Rescue/自动升级回滚仍不在本轮范围。

变更日志：R9 同一 Project 两轮正式闭环 LIVE PASS，旧文件与归档历史不变；补终止通知非阻塞、发送前普通 toast 呈现恢复和 cleanup 参数接线；分开记录源码/回归/新包与 live 状态，未修改历史账本或活动包。

R10 收尾发行候选：标准完整构建 2.78 min PASS；ZIP `C:\Users\devil\Documents\Ai\shuncode\shuncode开源\.build\releases\Nimora-Beta-Windows-x64-20261006-Components-R10.zip`，372837362 bytes / 5992 entries，SHA256 `8aa33dceb1d7bae6a15c0f4299b96124c007d5b168a42afea019fd3c1dd3bc99`。CRC、回解关键 hash、目录与回解 portable（包内 Electron Node Gateway 与证书 native load）PASS，私有 profile entries=0。主扩展 SHA `a0f0e3306d158749bb4a3db1a5bcda02def00ec0f83964f6601392c878aba744`，WebMCP SHA `97de445a8cfe3fde4ba405d1bc389fd7d1020b4d29a1cc66081103257c4390e1` 与 canonical 编译输出/源码一致。R10 尚未替换活动 R9 现场窗口，新的网页呈现/通知返回和真实归档验收 NOT_TESTED；R9 的两轮 LIVE PASS 证据独立保留。
