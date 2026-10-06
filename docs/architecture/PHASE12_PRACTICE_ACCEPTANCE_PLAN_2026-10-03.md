# Phase12 — 原 Project 的写入与测试验收预案

Status: AUTHORIZED / ACTUAL DELIVERABLES AND FUNCTION TESTS PASS / BOUNDED WORKFLOW ACCEPTANCE INCOMPLETE.

最新用户在读取链路成功后明确要求“想运行看看”，并要求继续。本轮据此推进原 Project 的实现测试；新增一个 Practice 子 Mission，无新增 Project，原 Cognition/Coordinator 保留。此前两条 Mission 的限制在本轮新增执行子 Mission 的范围内被最新要求替代。

## 已核实事实

原 Project `774ec5e8-835c-4239-829f-a5c70b0f7a40` 保持不变。root `6882f1fc-98c4-4228-918f-4bff780a7fb5` 是 `cognition / requirements-analysis`；Coordinator `7fa7e64e-7bc3-47cc-b3fa-716a5174b52d` 是 `coordination`。最新已创建 Practice 子 Mission `9eb0182e-dfe2-46b3-bced-407561b08609`，独立网页绑定与首次发送已完成。

真实文件读取、结果投递、宿主退出后的原网页恢复、恢复后全新只读目标均已通过。原只读目标 `033f90fa` / `b2d75336` 与后续 `88461ce6` / `a48d112b` 均已消费，不可重放。执行子 Mission 本轮 `3e69e944` / `ffe4d2c8` 也已消费，不可重放。当前四个交付文件已由网页 Worker 生成，并有真实写入/结果投递记录；仍无正式 Mission 终结。

现有 Cognition 的能力配置只允许研究和只读工具。不能把“网页 completed”或成功 READ 当成放行 `apply_patch` / `run_command` 的授权。此验收验证 Nimora 的网页 AI 执行能力；待办网页来自用户测试目录的 `需求.txt`，不是 Phase11 范围，也不是替代 Nimora 软件的产品目标。

## 操作范围（现已执行，最终约束验收未通过）

- 使用既有 `MissionCoordinatorService.ensureMission`，在同一 Project / root 下形成一个 `practice / implementation-and-testing` 子 Mission，parent 保持原 Cognition root。
- 同一 operationKey 的身份和内容须经 canonical collision gate；不得通过替换 operationKey 或重新建项重试不确定创建。
- 保留原 root、Coordinator、全部执行/投递/Worker 历史，不改它们的 plane，不终结或归档它们。
- 独立共享网页 Worker 经原产品分配入口绑定 Practice；不抢用原 Coordinator/Target，不使用 API 或 ChatGPT Work。
- 提交全新目标与 inputId，经原 Coordinator 将明确指令送到 Practice Worker。仅申请工作区文件读取、补丁写入和必要的本地测试能力；既有逐项能力授权仍生效。
- 限定 `C:\Users\devil\Documents\Nimora-Test`。只新增 `PROJECT_PLAN.md`、`index.html`、`README.md`、`TEST_REPORT.md`；不覆盖需求或诊断文件，不删除文件，不安装依赖，不使用外部账号或网络。
- 验收添加非空任务、完成/取消完成、删除、全部/未完成/已完成筛选、刷新后 localStorage 持久化。所有未实际运行的检查须明确标为“未验证”。
- 依据实际工具执行、结果投递、网页终态和打开后的功能测试取证；工具执行和结果投递分开审计。失败或 UNKNOWN 立即停，不重放请求/工具，不把 READ artifact 当应用交付物。

## 完成条件

原 Project 内真实网页 AI 生成受限交付物；本地打开及上述功能测试有实际证据；普通后续入口和已停止执行的恢复不丢失记录；最终发行包另行验证。完成文件制作不自动意味着 Project 或 Phase12 CLOSED。

## 最新收尾进展

旧24调用和4失败均保留。Task executor已加载且新的set_todos真实通过；任意工具错误停止已在新input75ca693c实测，PATCH前参数拒绝、总3调用投递后停止，未写入。三Mission在18:54公开恢复并核实5个失败，通过新error核实入口后仅开放全新目标。进度UI已显示实际执行/待办，正式完成率不伪造。版本字典行协议和partial READ错误传播已修复/构建/加载；报告补充请求尚待启动审核。见PHASE12_CLOSEOUT_2026-10-03.md。

## 历史实测与限制（17:35检查点）

Same Project774ec5e8/root6882f1fc/Coordinator7fa7e64e retained; one Practice child9eb0182e-dfe2-46b3-bced-407561b08609 prepared/bound/dispatched through public product entry. Coordinator3e69e944/Targetffe4d2c8 permanently CONSUMED / NO REPLAY; provider terminal completed17:29:53, all24 Practice executions prepared/delivered exactly once, duplicateObservations0 (20 executor succeeded,4 failed;4 command processes exited1 despite executor succeeded). Actual web Worker generated PROJECT_PLAN.md/index.html/README.md/TEST_REPORT.md, original requirements hash unchangedf6cee9fd…fb38ab9. Real Node vm harness output23 PASS/0 FAIL and exit0 audited; that is logic/stub testing, not browser. Independent real in-app browser checks PASS: blank input reject, click/Enter add, complete/undo, completed/active/all filters, reload persistence and delete/reload persistence. Local preview127.0.0.1:18653/index.html kept open; server exec session2778 is a runtime snapshot. NOT full bounded workflow acceptance: provider ignored fail-stop instruction, retried malformed patches via distinct calls, temporarily created/deleted test_harness.js and wrote os.tmpdir()/nimora-test.js outside requested workspace via run_command. No original request/tool replay by takeover agent; retain all failures and file origins. Host Task executor fix SOURCE/actual router/typecheck/build PASS, diskC96A2553…60682116 NOT activated; current active entry5427E592…21CE6EA0. set_todos/report_progress missing host ownership explains task planning failure; Project0% is still no finalized Mission, not zero actual execution. Three-Mission failure reconciliation/recovery, host-enforced request stop/file scope, accurate progress UX, final semantic acceptance and packaging remain OPEN. Do not restart/replay current owner state using old two-Mission helper. Phase11 core CLOSED unchanged. Evidence practice-terminal/execution-audit/browser-functional-20261003.json and practice-browser-20261003.jpg; detailed limitations in PHASE12_PRACTICE_ACCEPTANCE_PLAN_2026-10-03.md.


## 2026-10-04 当前补充

2026-10-04 02:08 CST: Human clicked upfront authorization; fresh report goal Target0521125e / Coordinator9a42d861 is CONSUMED, DO NOT REPLAY. Real six calls (report_progress, full read_files, one version-guarded apply_patch, read_files range88-143, set_todos, report_progress) all succeeded, each Prepared1/Delivered1/duplicates0. TEST_REPORT.md +47/-0, SHA256 a722fe04…fea8d; index.html6454725a…2cf17 and requirementsf6cee9fd…fb38ab9 unchanged. Three todos completed, report-only progress100. Original Project39/39 executed/delivered; whole profile41/41 across3Projects/7Tasks; six historical failures retained. HOWEVER Practice phase/feedback remain UNKNOWN at 01:51 CST; visible Target final is not a canonical terminal checkpoint. Exact Coordinator DeepSeek page visibly reports message-frequency rejection; exact thrown exception was not captured, so rate-limit attribution is an inference, not proven full causality. Source now checkpoints an owning known Target terminal BEFORE Coordinator result delivery and retains separate coordinationFailure without replay; callback ordering/duplicate/storage/UNKNOWN regressions, entry/Practice tests, required runtime suites, typecheck/build PASS. This fix is BUILT ONLY, NOT loaded/revalidated in current EH; no restart or journal/memento repair. Phase11 core CLOSED; Phase12 OPEN pending no-replay UNKNOWN reconciliation, accurate report provenance/semantic acceptance and package verification. Evidence finish-report-rwv-20261004.json and finish-report-terminal-investigation-ui-20261004.txt; details PHASE12_CLOSEOUT_2026-10-03.md.

本次6条工具全部成功不等于正式验收。原目标已消费；下一步先核实UNKNOWN，不能再发相同报告目标。报告日期/来源说明需新目标修正，保留原所有执行记录。


## 2026-10-04 02:33 当前恢复截点

2026-10-04 02:33 CST: exact failure now PROVEN by flushed EH log at01:51:10: Coordinator submitCapabilityResult/sendToolResult was rejected by DeepSeek message-frequency admission AFTER Target tools succeeded; old0521125e/9a42d861 remains consumed/UNKNOWN, never replayed. Added explicit orphan-only UNKNOWN-effects review with exact full-execution digest/count/input/time and native original-page checks; no zero-execution/pending/duplicate/live-owner admission, no fabricated completed terminal. Public review ACTUALLY saved reviewed-unknown + disposition consumed-no-replay, original unknown timestamp retained. One normal isolated EH restart34932 exit0 ->28100 loaded source. Canonical orphan-owner-death recovery restored SAME three pages/Missions to Coordinatorb143da5d/root44ff31ce/Practicebb283130, one current ref each, original adapter IDs retained; no provider send in review/recovery. All41/41 profile executions/deliveries unchanged,6 historical failures preserved; Attached41/Retired36. Relevant domain/race/cancel/active-page/public-entry/UI/recovery/Coordinator tests, typecheck, standard incremental compile/runtime PASS. New report-only provenance correction goal (three tools: full READ, one guarded PATCH, full READ) prepared in original product permission modal; Human authorization PENDING, not yet consumed/sent. Phase11 core CLOSED; Phase12 OPEN until this new live outcome/semantic acceptance and separate release verification. See PHASE12_CLOSEOUT_2026-10-03.md and finish-unknown-reviewed-recovery-audit-20261004.json.


## 2026-10-04 02:50 最终报告校正与开发版试用结果

2026-10-04 02:50 CST: fresh authorized report correction LIVE PASS in SAME Project774ec5e8/root6882f1fc/Coordinator7fa7e64e/Practice9eb0182e. Coordinator80705f9b / Targeta2dda378 are CONSUMED/NO REPLAY. Exactly3 successful tools: full READ143lines -> one guarded PATCH(+59/-46) -> full READ156lines; each Prepared1/Delivered1/duplicates0. Report175eacf5…ead19, sections1–6 unchanged; index6454725a…2cf17 and requirementsf6cee9fd…fb38ab9 unchanged. Known Target completed checkpoint ACTUALLY persisted02:44:56, Coordinator returned and no coordinationFailure recorded; older0521125e UNKNOWN remains historical consumed-no-replay, not rewritten. Whole profile44/44; original Project42/42 with36 succeeded/6 historical failed, todos3/3, old report-only progress100 retained. Normal Nimora: Open refreshed current-host panel; stale duplicate panel closed, three original provider pages retained. Development-instance execution/continuation/recovery and report provenance closeout are ready for user trial. Phase11 core CLOSED; Phase12 formal status remains OPEN for complete semantic Project acceptance and separate release/installer verification. Full OS command sandbox/per-request file allowlist remain unimplemented; no unrestricted unattended guarantee. Evidence finish-report-correction-acceptance-20261004.json; summary PHASE12_USER_TRIAL_RESULT_2026-10-04.md.

本轮报告校正已通过完整三次工具执行和终态核对；详见 [PHASE12_USER_TRIAL_RESULT_2026-10-04.md](PHASE12_USER_TRIAL_RESULT_2026-10-04.md)。这不等于完整Project语义验收或发行安装包已通过。此前02:33授权待定、02:08UNKNOWN阻塞描述为历史截点，原请求仍消费且不得重放。
