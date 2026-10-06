# Phase12 P2–P5 工程闭环与发行证据（2026-10-04 13:32 CST）

> **16:50 CST hardening 补充：** P2–P5 的工程闭环结论不变，但真实 DeepSeek 后续验收已经不再是“没有共享页”：至少一轮 Cognition→Coordinator→Practice 工具执行→durable Evidence→Cognition 已真实发生，并暴露/修复了 capability catalog、Coordinator terminal、canonical conversation href、DeepSeek host-wide pacing、Autonomy Evidence replacement proof、child-only `finalizableMissionIds` 与 replacement consent single-flight 等边界。最终全部修复后的 live 收敛仍因当前原生 Windows 提示框/partial fresh replacement 停在 1/3 page approved 而未完成，不能升级为 Phase12 CLOSED。详见 [`PHASE12_MISSION_AUTONOMY_LIVE_HARDENING_2026-10-04.md`](PHASE12_MISSION_AUTONOMY_LIVE_HARDENING_2026-10-04.md)。

## 结论

用户要求继续完成 P2–P5 后，本轮已完成所有可由当前 Nimora/agent 安全执行的源码、production 接线、专项验证、Product Shell 入口、回归、发行归档与文档更新。

- **P2 ENGINEERING CLOSED**：Practice 结构化报告不再只是网页文本；Nimora 从本轮真实 Task executions/artifacts/terminal 派生 durable Evidence/Finding/Problem，owning Cognition 读取 bounded truth 后生成严格 decision，Coordinator 再执行 Answer / Work Order / additional Mission / child finalization。
- **P3 ENGINEERING CLOSED**：同一个 Coordinator exact semantic turn 可有界并发多个互不冲突 Practice Work Order；ready frontier 可按需绑定互异 exact Worker；产品新增「文理自主运行」并复用 canonical owners，不另造调度数据库。
- **P4 ENGINEERING CLOSED**：WorkerSessionManager 记录保守字符/turn/provider-error usage；same-Mission succession 只有 known-settled + durable Handoff 后才 exact replace；replacement 不重播旧 Work Order；UNKNOWN / provider error 未 settled 时 fail-closed。
- **P5 ENGINEERING/RELEASE CLOSED**：宽回归 PASS；当前 first-party extension bundle 已进入新的 Windows Beta ZIP；ZIP 回解后 portable smoke PASS；旧 ZIP native omission 已纠错。
- **Phase12 仍 OPEN**：当前两个实际 Gateway 均无共享 Personal Edge 页面。真实 DeepSeek 登录/原生 Share 是 Human-only 安全边界，agent 无权代点，因此 live-provider acceptance 只能在 Human 重新共享页面后进行。

## P2：文→理→事实→文闭环

新增 `src/mission-autonomy-loop.ts`。Practice 输出契约为 `nimora-practice-report`，Cognition 输出契约为 `nimora-cognition-decision`，均要求“仅一个 JSON 对象、无 markdown、严格字段、有界数组/字符串”。Cognition decision 在任何 durable mutation 前先验证 Problem/Evidence/Mission/capability/scope。

Practice 报告本身不是 Evidence。系统优先使用 exact `targetInputId` 对应的 Task execution、delivery、artifact、terminal observation 形成 durable Evidence；随后才将报告中的 bounded Finding/Problem 关联到该 Evidence。阻塞 Problem 必须由 owning Cognition 回答；Answer 以 exact `replyToExchangeId` 和 `answers` relation 持久化。

Coordinator live driver 新增 `deliverParallelExplicitMissionInputs`，并让 `deliverFeedbackContinuation` 可重新进入 Phase8 capability/context materialization。Cognition 授权子 Mission 完成时仍调用原 `MissionFinalizationService`，所以实际状态是 finalize → Worker retire → archive，不是 UI 假完成。Root 不被 autonomy loop 直接归档，仍受正式 managed-scope completion gate。

专项 `test-shuncode-mission-autonomy-loop` 已证明：A/B 第一轮同 Coordinator fan-out；B 产生 durable Problem/Evidence；第二轮 Cognition Answer 并仅继续 B；A/B 最终分别 archived；root 保持活动等待正式 Project completion。

## P3：Mission frontier 与真实并行派发

`deliverParallelExplicitMissionInputs` 最多 8 个 delivery，并要求 target Mission、WorkerSession、inputId 全互异，总 instruction budget 有界。每一个 Target send 前仍独立执行 scope/owner/session/materialization 校验；一个 Coordinator 只承担 transport/execution，不获得语义分解权。

`MissionAutonomyLoopService` 使用 `MissionParallelReadinessService` 检查 requested Mission；ready-unassigned 时产品层可调用原 `plannedWork.assignReady`。新增 `extensions/shuncode/src/nimora-autonomy-entry.ts`：一次 Human 启动后 ordinary bounded rounds 由 Cognition 决定；缺页只按实际 ready 缺口准备 fresh DeepSeek 页，每页继续要求 native share；UNKNOWN/运行中/pending delivery 立即阻断。

Product Shell 新增「文理自主运行」按钮，并将动作委托给 `shuncode.nimora.runWebAutonomy`，Webview 不拥有调度逻辑。

## P4：上下文容量与同 Mission 接班

WorkerSessionManager 新增 per-session `conversationObservedChars`、`conversationTurnCount` 和最近 Provider error，只描述 Nimora 自身观察，不宣称精确 Provider token。

新增 `src/mission-worker-succession-service.ts`：

1. `normal` → continue；
2. `approaching-limit` → 生成 `nimora-worker-succession-handoff-v1` durable artifact；
3. `rotation-required/exhausted` 且 NOT known-settled → `waiting-for-settlement`；
4. settled + Handoff + exact candidate → 使用新增 `replaceSettledRestricted`，沿用原所有 running/pending/UNKNOWN/owner identity 检查后同 Mission replace；
5. provider-side conversation cleanup 只记为 `deferred-not-authoritative`。

`MissionContextMaterializer` 仅对严格 succession schema 暴露 bounded Handoff text/source/digest，successor 因此能重建 durable truth，但不会自动收到旧 Work Order。

`test-shuncode-mission-worker-succession` 同时验证正常 rotation 和反例：Provider 明确 `maximum context length exceeded` 但边界未 known-settled 时不能创建 Handoff/replacement。

## P5：回归、构建与发行

最终相关回归全部 PASS：

- `typecheck-shuncode`
- incremental `compile-shuncode`
- `test-shuncode-mission-autonomy-loop`
- `test-shuncode-mission-worker-succession`
- `test-shuncode-mission-cognition-plan`
- `test-shuncode-mission-parallel-orchestration`
- `test-shuncode-mission-feedback`
- `test-shuncode-mission-coordinator-live`
- `test-shuncode-mission-coordinator-completion`
- `test-shuncode-mission-finalization`
- `test-shuncode-nimora-product-shell`
- `test-shuncode-nimora-product-ui-host`
- `test-shuncode-mission-user-entry`
- `test-shuncode-webmcp-worker-candidates`
- `test-shuncode-webmcp-gateway-location`

默认 compile clean 因运行宿主持有 native addon 得到 EPERM；既有正式 `SHUNCODE_BUILD_INCREMENTAL=1` 路径 PASS。标准 `vscode-win32-x64-ci` 的 native extension compile/typecheck 先 PASS，但 clean `VSCode-win32-x64` 时该目录被当前独立验收窗口占用而 EBUSY；本轮未强杀用户窗口。

后续归档审计发现历史 `Nimora-Beta-Windows-x64-20261004.zip`（SHA256 `e8a5…5f5d`）没有 packaged `crypt32.node`，因此旧“ZIP portable smoke PASS”声明撤回。保留的 `VSCode-win32-x64-nativefix-20261004` 与当时旧 extension hash `67da8335…bfa82` 匹配且包含正确 native cert module，用作可信 desktop base。

最终发行：

- ZIP：`.build/releases/Nimora-Beta-Windows-x64-20261004-P2-P5.zip`
- bytes：`361959813`
- SHA256：`88ef6e1e8bec6b6a66a6b6ec77595ed23d05f0bd8eb2e51984b8689bf4aa468`
- current source/package/extracted extension SHA256：`99f90af903826421c3d05c3d1ed3e1280e1b7a5da280b4b14b871b664de83d8`
- ShunCode.exe SHA256：`2645a9f39d732959f1a876b5238c8a5510b2fdaf05150fcab7deef6c886e5433`
- `crypt32.node`：144896 bytes，SHA256 `1e602c8fd94a3a08949292c4fd0b3e83e813f38161812d15f38e6a067a4c33a`
- ZIP entries 明确包含 current `extension.js` 与 `crypt32.node`
- 完整回解后的 `nimora-portable-smoke.mjs`：PASS
- Cookies / Login Data / `state.vscdb` / browser-profile / 私有 `.env` archive-name scan：0 hits
- VS Code diagnostics：0 errors / 0 warnings
- `providerAcceptance`：**NOT_TESTED**

## 当前 live-provider 边界

13:32 只读检查：

- dev Gateway `48321`：`browserRunning=false`，`personalEdge.connected=false/shared=false`
- independent acceptance Gateway `50321`：`browserRunning=false`，`personalEdge.connected=false/shared=false`

因此没有合法的当前 shared page 可以承接一个新 Provider turn。不能直接调用网页 Gateway 绕过 Product/Mission owner，也不能替 Human 点击页面共享或登录安全授权。

Human 下一次共享后，只允许使用**全新未消费目标**做 Phase12 live acceptance：验证 actual multi-page assignment/fan-out、Practice Evidence/Problem→Cognition Answer/continuation、必要时 lifecycle succession、最终 Cognition completion review 和 Coordinator Provider ACK。旧请求、旧失败和旧 UNKNOWN 永远不能因为本轮 P2–P5 工程闭环而重放或改写。
