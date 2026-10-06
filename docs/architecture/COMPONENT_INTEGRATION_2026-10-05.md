# 现有零件生产装配工作记录（2026-10-05）

范围：按 Human 要求补齐现有零件。未来自动维护、Rescue、自动升级回滚不在本轮范围内。

核心 Mission 自治闭环与 Web Worker 主链已有真实证据；不能把未在 R11 fresh acceptance 命中的生产分支误标为未装配。既有脏工作树和历史 proof 身份均保留。首阶段只做源码接线；Human 后续要求继续编译、原生合同与发行验收，2026-10-06 进展见 `CORE_BASELINE_RECONCILIATION_2026-10-05.md`。现在已有新 DeepSeek 真实请求与文件执行；没有重放历史 proof。

2026-10-06 新现场发现：R3 Root A 文件工作成功，四次唯一投递及 Practice 归档成立，但多执行了一次未允许的目录读取，限定能力验收失败。已补 allowedCapabilityIds 上限及普通 Work Order 接线，专项/35 suites PASS；修复后现场复测、Root A 正式审核及同 Project Root B 仍开放。详情见 `COMPONENTS_REAL_ACCEPTANCE_2026-10-06.md`。

多轮 Project、API Worker 及相关支路已经完成源码装配与隔离验证；Copilot 原生受限工具/结果合同现已接线并完成专项回归。**不能宣布全部缺口清零**：其它 native backend 仍 gated，Stable OS sandbox 主机前置仍缺，新路径真实 Provider 现场验收尚未完成。

| 零件 | 本轮工作 | 验证状态 |
| --- | --- | --- |
| 同 Project later root | Product Shell 新目标入口 → tools-free Cognition → 保存操作身份 → canonical ProjectRootOperationService；选唯一活动 root，历史 root 保留 | 真实 owners 的一 Project/两 root、原身份重启恢复、治理漂移拒绝、真实 Webview next-goal/pending-resume、autonomy 两角色新绑定 PASS |
| root 完成审核 | v2 completion scope 按 Project + managed root；旧 Project latch 同 root 仍阻止重放 | completion ingress smoke 通过 |
| API Worker | 同 WorkerSessionManager / assignment candidate pool；host-requested 工具进入 canonical Mission 授权、执行、投递；不绕过到本地文件 MCP | 实际 Runtime 子进程 + 本机 HTTP 模型桩：candidate/assignment → READ/PATCH/READ → delivered → restart PASS；恰好一次 PATCH；没有真实 API Provider 验收 |
| 平台 Skills | chat.getSkills 发现 workspace/user/extension/plugin；Core 薄 DTO 传递现有 disabled-file 状态；Human 按本轮 root 选择信任，保存来源/内容 digest | 旧 host 缺 enablement 默认禁用；禁用、provenance 漂移、symlink/过大/非法 UTF-8 拒绝；信任撤销与发送前刷新 PASS；不授予工具权限，不继承到 later root |
| Observation | Task/Project/Collaboration owner 的 commit 后事件进入有界、非 owning、无 transcript 缓冲；Browser health 同一映射；诊断导出消费 | durable commit、观察者异常不回滚、界限与 privacy PASS；UNKNOWN 不伪装 settled；不是新的持久账本 |
| 独立 WebMCP | 默认加载与扩展相同 canonical page assets，stage 复制三个真实源文件，缺失 fail closed | 源与 stage 字节一致、缺失拒绝、实际 staged Gateway 启动 PASS；另跑 production stage，全部 Gateway dependency 从自身 node_modules 解析，未借 checkout deps |
| AgentHost Worker | Copilot fresh scoped SDK tools + host-requested result/SDK receipt；服务端与界面版本共同核对；进入 production candidate/materializer | Copilot 在新版 host/所选模型可用时可选；旧 host/未知 ABI/Claude/Codex 不可选。禁止 builtin/MCP/发现/命令旁路、schema/owner drift 与 replay，结果 echo 不算 receipt。专项 PASS；尚无新真实原生 Provider E2E |
| MCP v2 | 第一方 stdio/Runtime client、Bridge modern HTTP、Gateway exposure/upstream 接官方分包 SDK；legacy v1 上游兼容保留 | legacy + 2026-07-28 stdio、官方 client discover/list/call、Mission-native HTTP json/sse/modern-json READ/PATCH/READ 与投递失败恢复 PASS；wire metadata 不成为 authority |
| Provider conversation cleanup | 已核实 conversation-lifecycle.js 的 runProviderConversationCleanup；接 Product Shell「归档旧 Worker 会话」 | exact 已退休 binding + 空闲共享页 + Human 确认；点击前持久消费，UNKNOWN 不重放，不 fallback delete；缺 post-action URL 不算 verified；真实网站归档未现场验收 |
| Personal Edge pairing | 私有 SecretStorage token → Gateway env → Options 本机配对；共享 tab 仅 session storage；切换/解除配对撤销共享 | loopback、秘密不回送/导出、重启不隐式共享、异步 tab 漂移拒绝 DOM、原绑定结果回送、未决命令失效 PASS；真实个人 Edge 配对未现场验收 |
| legacy Branch/Merge | 现有 Native Chat 兼容入口保留，不把 branch answer 自动当 Mission decision/evidence | MIGRATION_PLAN Phase 8 的 Task Candidate/Review 新领域合同尚未存在，不作为本轮“已有零件接线完成”声明；迁移仍待设计 |
| Stable OS sandbox | 不降低 gate、不改 Program Files ACL | 当前 host live certification 外部前置仍未满足 |

## 同一 Project 的工作周期与持久安全状态

原轮次全部 Mission 正式归档、Worker 退出且无未决执行/投递后，用户输入新目标。tools-free 解释期间 Project/历史 Mission 漂移则拒绝；operation identity 在调用 canonical owner **之前**保存。结果不明时只恢复原操作，不重解释或另造 root。新 root 由原 assignment owner 获得独立 Cognition/Coordinator，旧 autonomy UI outcome 清除，历史 root/产物/治理与消费身份保留。自治仍有界（默认至多 8 轮），完成候选仍需正式审核。

- `nimora.pendingLaterRoot.v1`：原 operation 与前置证据，不得删除后盲重建。
- `nimora.projectCompletionScopes.v2`：JSON([projectId, managedRootId])；旧 `nimora.projectCompletionAttempts` 只读兼容同 root，不清空消费历史。
- `nimora.rootSkillTrust.v1`：JSON([projectId, rootId]) → 来源与内容 digest；每次物化/发送重核，later root 不继承。
- `nimora.providerCleanupAttempts.v1`：点击前预消费，UNKNOWN 保留，不得删 latch 后再点。

ProjectStore、TaskRuntime、MissionCollaborationStore、WorkerSessionManager 继续拥有真实状态；UI latch、observation 与协议 envelope 均不成为新的 owner。

## 验证证据

`npm run typecheck-shuncode`、`npm run compile-shuncode`、`npm run test-shuncode-runtime` PASS。`npm run test-shuncode-component-regression` 当前 **35/35** 隔离 suites PASS，包含 API 实际子进程/本地模型桩、later-root/完成、真实 Webview、Worker/并行/接班、MCP 两代协议、Gateway、安全门和新增 scoped Native 桥。真实 Product Shell 历史归档→next-goal/pending-resume 主机测试也 PASS。

生产 stage 独立补验：`node scripts/stage-shuncode-webmcp-gateway.mjs --production`（npm ci/omit dev/ignore scripts）安装 100 个依赖；`node scripts/shuncode-webmcp-gateway-location-smoke.mjs --production-dependencies` PASS，所有 manifest dependency 从扩展本地 node_modules 解析，实际子进程 health v3/private-token 与 canonical page assets PASS。这不是发行 ZIP 刷新或真实浏览器/Provider 验收。

**完整 compile-client 已 PASS（2026-10-06）**：首阶段 1177 条 TypeScript diagnostic 已复原并收敛，最终 Core 与内置扩展均为 0 errors。记录：`.build/nimora-component-validation/core-compile-client-final.log`；原始失败日志 `core-compile.log` 保留。Node/browser 数量、复原来源和独立 Beta 归档见最新 Core 收尾记录，不把隔离测试当真实 Provider 验收。

本轮混合 pool 实测发现并修正：API/AgentHost candidate 不能直接转发 WorkerHealth/Capabilities 的 extensions，否则 strict assignment contract 会拒绝整个 pool；现已按合同投影，并由实际 assignment + Runtime 子进程验证。旧 adapter smoke 的 ESM/CJS harness 同步修复；生产 bundle 不因此更换。

官方迁移依据：[v2 文档](https://ts.sdk.modelcontextprotocol.io/v2/)、[upgrade-to-v2](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)、[2026-07-28 support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)。本地 server/client 2.3.0、node 2.1.1；第一方显式选现代协议，upstream auto 兼容 legacy；保留 Code-OSS v1，未全局改造上游 MCP。

## 剩余工作与发布界限

1. **其它 AgentHost backend**：Copilot scoped 合同已接线；Claude/Codex 仍需各自支持并验证等价的工具边界才能开放。原 observer adapter 不能替代合同，observed call 不重放成 host-requested。
2. **真实验收（2026-10-06 更新）**：R9 DeepSeek 同一 Project 两轮严格 READ/PATCH/READ 与正式完成已通过，六个 Mission 归档、六个 Workers 退休，旧轮次文件/journal 不变。R10 通知/cleanup 收尾包已构建、CRC/回解/portable PASS，但新分支 live 待验收；API、当前 ChatGPT/Native、MCP modern、真实网站归档/个人 Edge 配对仍开放。R3 限定能力失败及 R11 历史 proof 不改写。下一阶段顺序与混合自治入口缺口见 `NEXT_STAGE_PLAN_2026-10-06.md`。
3. **Stable 发行前置**：Core compile baseline 已修复并通过；OS sandbox live certification 仍需要符合 BaseContainer/BFS 要求的 host。当前 Beta/Stable 门与历史 proof 保持原义；功能测试不能改 osSandboxLiveCertifiedOnCurrentHost 为 true。

回滚逐项撤销本轮源码、重建第一方 bundle/stage，禁用新入口/candidate source。保持 canonical journals、consumed latches、pending operation 身份；禁止全局 Git reset 或清空真实工作状态。安装版只读；加载新 Core metadata 应使用隔离源码实例并保留旧 proof profile。
