# Nimora Phase 11 — 2026-10-01 最新接班交接

> 范围：同一个 persistent Phase 11 Practice — Production Worker Integration Core / WO#1；本文件是工作交接，不是 Cognition ACCEPT 或 Phase close。创建时以当前源码、TaskRuntime durable journals 和当轮回归为准。下次打开时必须再次 fresh 读取和验证，因为 Source Dev / Worker owner / Tunnel 可能继续变化。

## 1. 接班首要约束与 exact Mission

**后续最新交接：** PHASE11_CORE_CLOSURE_2026-10-02.md；WO1/WO2/WO3 current core formally CLOSED, WO4 deferred. Original Oct1 snapshots below remain historical; do not replay them. Actual implementation/result/independent evidence are linked from the closure record.

- **不要创建新的 Practice Project / Mission；不要重放已消费的普通输入、Final Proof 或迟到的工具块。**
- 目标 projectId：`e99a2c78-5c0c-4960-902e-1db309f10068`（已从 root 和 Coordinator 的 TaskMissionConfigured durable events 核实；不要使用聊天里旧的其它 projectId）。
- persistent root / ChatGPT Target Mission：`ba166044-c0b9-4017-8c02-508769d41396`；协调 Mission：`41d5107e-b03c-406e-9cfa-50e2bd9f5175`。
- 已消费 Final Proof `061/063`，严禁重放。2026-09-30 失败的普通 Coordinator inputId `01c3e826-65f9-4819-acbf-87703e322071`：**CONSUMED/FAILED/DO NOT REPLAY**；页面迟到 `call-7` 仅供取证，绝不能手动执行。更早的 consumed inputs/proofs 以 canonical journal、Roadmap、旧 handoffs 为准，不只看本文件。
- 保留所有 Phase12 / WO4 concurrent dirty changes：禁止 `git reset/clean/checkout/stash`、覆盖它们、删除未跟踪文件或把当前 dirty 误认为本轮全部新增。此次交接只写文档，不执行 provider send、不重新跑 RWV。
- 优先使用当前正常产品公开入口和现有 ShunCode MCP；不要通过隐藏 IDE/debugger 注入制造 Mission authority，不创建 R30/R31 等新插件解决 URL 漂移。

## 2. 两个实际修复的技术根因

### A. Coordinator “已回复但漏执行 semantic command”

- 在旧版 `extensions/shuncode-webmcp/arena-agent-bridge.js` 中，host-managed DeepSeek turn 在第一项 capability 出现前，只要普通回答文本稳定 1200ms 且 non-streaming，便可提前 `completed`。真实 DeepSeek 工具块可能较晚挂载，导致 LiveDriver 提前抛出 “Coordinator Worker turn ended without executing the explicit semantic command”；稍后页面才见到 `call-7`，但已没有该 turn 的执行 authority。
- 已先新增 `scripts/shuncode-webmcp-running-turn-liveness-smoke.mjs` 的确定性 falsifier；旧源码在 1250ms 明确 FAIL（expected running / actual completed）。
- 已修 `arena-agent-bridge.js`：仅对尚未 admit 首个 capability 的 **exact host-managed turn** 增加 10s 有界收敛窗口；窗口不会自动执行工具。任何已 terminal 的 host-managed occurrence 永久隔离于普通 page-local 执行，不能降级穿越 authority。新增 `hostManagedTerminalCapabilityGraceTruth` marker 用于 reinjection 检查。
- 这修复了源码复现条件，不等于那个已消费 `01c3...` 可以重放，也不等于新的 Coordinator 端到端产品验收自动成立。

### B. 浏览器第二张共享页无法进入 Playwright registry

- 原先一个 stale shared-page record 会使全部 Worker candidate discovery 失败。已修改 `extensions/shuncode-webmcp/bounded-browser-tool.js` 和 `extension.js`：仅确定性 “Page <id> not found / 页面已不再打开” 可记录并跳过；不确定 observation timeout 仍 **fail-closed**，绝不伪造缩小后的完整 inventory。永久回归：`scripts/shuncode-webmcp-bounded-discovery-smoke.mts`。
- 修复 stale discovery 后发现独立故障：第一张 ChatGPT 共享/Playwright 初始化成功，但 session 存在之后动态加入 DeepSeek，`BrowserViewGroup.addView` 成功、`Target.attachedToTarget` 已到达，Playwright 却没有 `onPageAdded`，造成 `waitForPage` timeout 和 Share 回滚。
- 通过只读 CDP 与临时诊断定位根因：`src/vs/platform/browserView/common/cdp/proxy.ts` 的 `sendEvent()` 在 `Target.attachToBrowserTarget` 之后，把原本 root-origin、没有 parent sessionId 的后续 `Target.*` lifecycle 事件错误套上 browser child sessionId。Playwright 的 root listener 因而收不到动态 target lifecycle；不是同名 URL/FIFO、不是不同 browserContext、也不是 DeepSeek 页面没加载。
- 先扩充既有 `scripts/shuncode-playwright-page-identity-smoke.mts`，旧实现确定性 FAIL，明确出现错误的 `browser-session-...`。最小修复：没有显式 parentSessionId 的 root `Target.*` 事件始终留在 root；非 Target browser event 保留原 fallback，显式 child parent routing 不变。保留 Phase12 exact targetId pairing，不回退 FIFO。
- 真实 Source Dev 复现后，动态 DeepSeek 的 viewTarget 与 pageTarget 都是 `FDB4499FA7750BF52DA32B0C5268D711`，两个 Playwright sessions（`<default>` 与 `workbench.browser.webmcp-internal-operation`）均完成 exact match；DeepSeek Share 后 12s 仍显示 `Stop Sharing with Agent`，不再自动回滚。临时 `phase11-playwright-diag` 诊断日志已从 `playwrightService.ts` 源码清理，只保留窄 proxy 修复和永久 falsifier。重启会丢当前 shared generation，不能把上述历史 live PASS 当成下一轮共享仍存活。

## 3. 本轮验证与源码位置

2026-10-01 交接前 **重新运行且 PASS**：

```text
node scripts/shuncode-playwright-page-identity-smoke.mts
  exactTargetMatching, rootTargetLifecycleRoutingAfterBrowserAttach,
  explicitAttachParentRoutingPreserved, noFifoFallback = true
node scripts/shuncode-playwright-tracking-readiness-smoke.mts
  shareAwaitsExactPagePairing, failedShareRollsBack = true
node scripts/shuncode-playwright-timeout-smoke.mts
  bounded deadlines, fresh deferred-wait deadline = true
node scripts/shuncode-webmcp-bounded-discovery-smoke.mts
  staleMissingPageSkippedWithoutPoisoningHealthyInventory = true
  ambiguousFailureStillFailsClosed = true
node scripts/shuncode-webmcp-running-turn-liveness-smoke.mjs
  hostManagedPageLocalInvokes = 0; completed/cancelled/error late admissions = 0
```

此前本对话还已通过 `shuncode-webmcp-browser-smoke`、Coordinator live、occurrence routing、virtualized history、`npm run typecheck-shuncode`、`test-shuncode-host-capability-durable`、`test-shuncode-task-runtime`、Mission user-entry / Worker replacement 等专项门；**它们不是此次所有当前 dirty source 的重新完整验收**。此前 `npm run compile-client` 因并行 Phase12 test 类型错误失败；`npm run transpile-client` 成功转译现有主源码（7916 TS files），并曾通过 `.build/phase11-r26-full-devhost-reload.ps1` 启动隔离 Source Dev。不要为“修编译”撤销别的对话的 Phase12 修改。

交接时当前文件 SHA256（之后可能被并行修改，必须重验）：

```text
src/vs/platform/browserView/common/cdp/proxy.ts
  8C9E14B04E2ED6B94A0DA71FF557146674FC91EC3797BAF999A2E0335EC9C763
scripts/shuncode-playwright-page-identity-smoke.mts
  35D27BD8FF4808E8925F4640B1DDBC9D10C2BC928234E7DFCF2173EBC9BD37D8
extensions/shuncode-webmcp/arena-agent-bridge.js
  EBDDA0C2AAFD1DD7A7C57C7D7DFD77333616278F9A0A27F719320F7A1CA3D2C0
extensions/shuncode/dist/extension.js (disk SHA ONLY; not proof of loaded memory)
  492F55B1E892F41B39885E5FCAC85ED36448C6BB07F55B6EFC374C2773643812
```

## 4. 最新 durable Reality：**比本聊天最后一次可见恢复步骤更新**

交接核查时（2026-10-01 当轮）隔离 Source Dev 监听端口与 owner：

```text
49322 Bridge / 49330 Extension Host inspector -> PID 33952 (当前系统显示 ALIVE)
49331 integrated browser CDP                  -> PID 12952
49321 Gateway                                 -> PID 31372
```

上述 PID/端口高度易变。**不得**从这段历史快照推断下一聊天的 live owner；必须重新枚举。

Canonical TaskRuntime durable journals：

```text
.build/shuncode-dev-user-data/User/globalStorage/shuncode.shuncode/task-runtime-v1/
  41d5107e-b03c-406e-9cfa-50e2bd9f5175.jsonl
  ba166044-c0b9-4017-8c02-508769d41396.jsonl
```

- 最新 Coordinator：2026-10-01T05:57:54.438Z 原 session `566e0991-8e74-493d-be40-62e0102383fb` canonical retired；05:58:02.002Z 新 session `b0c75afb-0ff9-4a18-919d-76a085d6d9c1` attached，owner PID `33952`。
- 最新 Target：2026-10-01T05:59:26.683Z 原 session `89231652-e281-4fd2-9928-01667a7e784e` retired；05:59:27.303Z 新 session `5e245c78-f68b-4cf2-9e4f-9b42d4a7edc9` attached，owner PID `33952`。新 session 的 shared page、runtime marker 和 MCP binding 需要 fresh 验证。
- 误绑历史 root `d158e9df-fca6-4427-9b29-57902f8bd06e` 曾于 2026-09-30T17:43:22.683Z 被错误分配 ChatGPT session `6b2da975-...`；17:48:50.102Z 已通过**canonical live retirement** 撤销，未在该历史 Mission 上发送 semantic request。绝不能把其 project/root 当成当前 Phase11。
- 曾做过 dev-only `.build/phase11-auto-recovery.once` sentinel 实验，因 reload 丢失共享视图而不适合继续。交接时 sentinel **不存在**。当前 `extensions/shuncode/src/extension.ts` 仍有相关 dev-only 恢复代码；需独立审查是否保留/移除，但不要为了清理再次让当前 Owner/Pages失效。

### 已出现真实 Target READ / WRITE ledger；尚不等于完成 RWV

最新 target journal 显示来自之前 Target managedSession `89231652-...`、inputId `5b78efa7-5747-4cc1-b325-3fa0f9ae9ce5` 的事实：

1. 2026-10-01T05:21:31Z `read_files` 请求/开始/成功/生成 artifact/result prepared。读到 `.build/phase11-live-chatgpt.txt` 当时为 `PHASE11_CHATGPT_BEFORE\n`，SHA256 `74551F963AA872169E9DD8ECB329134F9BF67C7856ECABE12ABBB7FE165AD4E5`。
2. 05:31:44Z 同一 input 出现**两条不同 callId 的 apply_patch 请求**、参数 digest 相同。其中第一条 success、产出 changeset，把 fixture 从 BEFORE 改为 AFTER（AFTER SHA256 `D77B6E6A697204F709D166D87E7820EBB2E331FC4B2AF4FC8A3A130BE8A0C2FF`）；第二条因 `STALE_FILE` failed，未进行第二次写入。两个 result 都 prepared。这是重要的双 occurrence/调用来源待审计问题；**不能重放第二条，也不能把两个 callId 误算为两次成功 WRITE**。
3. 交接时现场 fixture 已恢复为 exact `PHASE11_CHATGPT_BEFORE\n`，SHA256 `74551F...AD4E5`；其文件最近修改时间约 2026-10-01 13:59（本地日志显示）。**为何及通过何种授权恢复**，目前本交接未证明；下一位须先对齐当次 recovery/VALIDATE 记录及当前产品 UI/Journals，不要直接认定 VALIDATE 成功或随意再次改 fixture。
4. 当前抽查 target journal 里未看到可据此宣布整条 READ→WRITE→VALIDATE 最终验收通过的完整证明，也未见 Phase11/WO1 final independent acceptance。阶段性真实 READ/WRITE **不是** WO1 close。

## 5. Cloudflare relay 的历史已修项与 fresh 检查

- 已有真正固定的 Cloudflare Worker + Durable Object Current Route Relay（旧记录：`nimora-current-route.nimora-current-route-relay.workers.dev`），通过固定 Worker URL 路由至可轮换 Cloudflare Quick Tunnel，再指向当前 Bridge 和 `/mission-current/<missionId>`。Cloudflare Quick Tunnel URL 可以轮换；旧的 Quick Tunnel **不能**充当固定 relay 根地址。
- 旧交接已有真实 Stop/Start Quick Tunnel 轮换且 fixed relay 不变的 PASS 记录；这不是当前进程/当前 relay generation 的实时健康证明。先读 `docs/architecture/CURRENT_ROUTE_RELAY.md` 和现有 SecretStorage 配置，走公开 health/initialize/tools-list 只读核查，不盲目创建新 Rxx 插件，也不要泄露 route/update secret。

## 6. 接班执行顺序（禁止盲目续跑）

1. **完整 fresh 读** 父 `SHUNCODE_AI_HANDOFF.md`、本文件、`docs/architecture/PHASE11_LATEST_HANDOFF_2026-09-30.md`、`PROJECT_STATE.md`、`MISSION_WORK_ARCHITECTURE.md`、`MISSION_WORK_ROADMAP.md`、`CURRENT_ROUTE_RELAY.md`、`AGENTS.md`、`AI_DEVELOPMENT.md`。以当前 repository 和 durable truth 优先于本报告/聊天。
2. **先安全审计** 当前 `git status`、Phase12 并行 dirty 内容与最近 journal：查清 `5b78efa7...` 的 request 归属、两条 `apply_patch` 的 provider occurrences、result delivery、fixture 恢复来源、是否已有独立 VALIDATE / Cognition 回写；如另一个会话还在做 Phase11，避免同时创建同一类 session/执行。
3. 重核 live Source Dev PIDs/ports、两条**当前** canonical Worker owner 是否同属活着的 incarnation、两张 exact shared pages 的真实 generation、DeepSeek `hostManagedTerminalCapabilityGraceTruth` runtime marker 和 stable Mission MCP relay；不可把上文 PID/URL 当实时。
4. 用当前最小且可归因的测试确认 CDP root lifecycle、stale discovery、Coordinator late capability 修复均保留；保留 Phase12 的 exact pairing/readiness 逻辑。不因历史 Playwright 超时无限创建 fresh tabs / reload。
5. 在审计确定上一 ordinary request 已终止且不会产生迟到副作用、并具备新的授权/身份时，才能执行**真正新的**普通产品链验证或后续合法 VALIDATE；禁用任何已消费 inputId、callId 或 Final Proof ID，不可重新下发已成功 WRITE。按 README/Roadmap 要求收集真实 provider-originated、TaskRuntime ledger、exact result delivery、fixture hash、cross-provider/restart、artifact/feedback 及 independent Verification。
6. 将证据交由 Cognition/architecture 核准；只有验收合同全部满足且正式接受后才写 Phase/WO close。不能因为 smoke PASS 或 READ/WRITE ledger 就自己宣布 WO1 close。避免新增临时插件/route。

**状态判定（交接时）：** 协调漏执行和动态浏览器共享的已知源码竞态已修且本轮专项 PASS；最新两个 Worker 有同一活 owner 的 attach 记录；有真实 READ/WRITE ledger，但双 apply_patch occurrence 和 fixture 返回 BEFORE 的 provenance / 完整 VALIDATE / 端到端验收待核查。**Phase 11 与 WO#1–WO#4 仍按 OPEN/PENDING 处理，直到最新 Roadmap/Cognition 明确变更。**


## 2026-10-02 final core closure — supersedes prior current checkpoints

2026-10-02 Phase11 CLOSED for Human-revised WO1–WO3 core scope. WO1/WO2/WO3 ACCEPTED/CLOSED; WO4 DEFERRED_BY_HUMAN. Real ChatGPT RWV, public ChatGPT→DeepSeek same-Mission replacement, one fresh ordinary native READ with actual receipt/terminal/Completed, and normal EH machine-proof recovery of Target/Coordinator passed. Returned independent core verification PASS. No new Project/Mission, replay, extra WRITE or runtime finalization. Fresh live Formation/artifact/feedback/Verification/root-completion product E2E remains deferred, not passed. Existing Phase12 code preserved; product layer registration/UI delivery pending. Formal record: PHASE11_CORE_CLOSURE_2026-10-02.md.

WO2/WO3 actual RESULT and independent findings: PHASE11_WO2_WO3_RESULT_2026-10-02.md and PHASE11_WO2_WO3_INDEPENDENT_VERIFICATION_2026-10-02.md. Final local evidence .build/phase11-wo23-final-live-evidence-20261002.json. Normal EH1944 code0 exit→EH27536 activation; disk bundle5c9d6913...45a837 predates restart (no independent memory hash claimed). Original Target204rows/d16b41bb...bf6ab currenta3751819; Coordinator152rows/8aa3aa73...1a104 currentf9ad2364; both exact original Missions and existing adapter identities retained, orphan-owner-death machine recovery, one current Worker each. Input83baa72d consumed/DO NOT REPLAY. Fixture exact22bytes AFTER+LF/d77b6e6a...c2ff unchanged. No post-restart provider execution claimed; actual recovery/preparation and no-replay are proven. Historical statuses/hashes/PIDs below are at-capture records. Next work is existing Phase12 product integration plus deferred live product acceptance, not another WO1 proof.
