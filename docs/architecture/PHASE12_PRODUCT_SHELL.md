# Phase 12 — Nimora Product Shell

> **Latest Phase12 checkpoint:** 2026-10-04 04:00 CST：独立发行版第一方 activation/PACKAGED PASS；最新网页建项准备停于1/3健康、2共享候选。实际Bridge日志：c6e2dd9e ready=true/composer=true；342b0cd3 ready=false/composer=false/auth=false/compatible=true。后者未观测到聊天输入框，登录/加载/站点识别具体根因未证明；prepareNimoraWebAi顺序等待第2个健康页，因此本次尚未继续开第3页。新profile canonical Project/Task/Collaboration存储目录仍为空，未形成Project。日志存在其他准备尝试和一次planning Worker connected，不能声称所有历史尝试均零provider send；本次awaiting-share分支在规划之前退出。UI捕获owner mismatch仍存在，需Human在第2页核对正常输入框和共享；不重放旧规划/工具。Phase11核心CLOSED不变；Phase12正式OPEN。

## Product goal

Phase 12 is a productization phase, not a new runtime-owner phase.

Core rule:

> Users manage Projects and outcomes. Nimora manages Missions. Workers remain replaceable execution resources.

The product surface therefore leads with Project and Mission, not provider chat, managed session ids, MCP routes or browser page identity.

## Implemented Beta source

New source:

- src/nimora-product-shell-projection.ts
- extensions/shuncode/src/nimora-product-shell.ts
- extensions/shuncode/src/nimora-product-operations.ts
- extensions/shuncode/src/nimora-product-layer.ts
- scripts/shuncode-nimora-product-shell-smoke.mts

The shell is a read-only presentation over the accepted Phase 9 Project/Mission projection:

ProjectStore + TaskRuntime + MissionCollaborationStore
-> readProjectMissionPresentation
-> projectNimoraProductShell
-> Nimora Product Shell

It introduces no UI journal, Project cache, Mission owner, Worker owner, scheduler or transcript store.

## Beta surface

The current source presents:

- Project list and Project overview;
- Project title, goal and status;
- active/completed Mission counts;
- attention count from unresolved Problems and failed/UNKNOWN executions;
- Mission list with 文 / 理 / 总协调 role, status and current Worker label;
- selected Mission summary;
- recent execution, Artifact, Problem, Answer, Handoff and committed-decision activity;
- openable Artifacts;
- committed Project Decisions.

User actions delegate to existing safe product seams:

- New Project -> fresh ordinary Chat session -> existing `@shuncode` production Formation ingress;
- Continue Mission -> exact `nimora-task:/<missionId>` -> existing Task Center session ingress;
- Workers / Replace Worker -> existing Mission Worker selection;
- Permissions -> existing capability permission UI;
- Connection status -> existing Web Worker status;
- Artifact open -> canonical VS Code URI opener.

The Product Shell itself does not mutate Project/Mission truth.

## Phase 11 coexistence boundary

The first integration attempt briefly registered Product Shell in the main extension source. That registration was removed before runtime activation after recognizing it would unnecessarily widen the active Phase 11 proof/source surface.

Current boundary:

- Product Shell source exists and is independently compilable;
- it is not imported or registered by current production extension.ts;
- no Product Shell command remains in the current extension manifest;
- no Extension Host reload was performed for Phase 12;
- no ChatGPT/DeepSeek page, Mission MCP binding, proof identity, fixture or Phase 11 provider state was changed by Phase 12;
- current Phase 11 routing/native-MCP and WO#2/WO#3 preservation gates remain green.

## Verification

Fresh checks on 2026-09-30:

- Product Shell projection smoke — PASS;
- isolated strict TypeScript check — PASS;
- isolated esbuild bundle with vscode external — PASS;
- typecheck-shuncode — PASS after production registration was removed;
- Phase 11 production routing — PASS;
- Phase 11 native MCP — PASS;
- Mission user entry — PASS;
- Worker replacement — PASS.

## Thin integration after Phase 11 release

Once Phase 11 Cognition releases the proof-sensitive source/runtime boundary:

1. reread current extension.ts and extension package manifest after Phase 11 closes;
2. import the already-built `registerNimoraProductLayer` thin seam into production extension;
3. pass the existing Phase 11 production composition + readiness promise + change event; do not reconstruct services in the UI layer;
4. contribute command `shuncode.nimora.open` with title `Nimora: Open`;
5. add the Product Shell files to explicit typecheck/build file lists if required;
6. build and reload once;
7. run one real new-Project -> Formation -> Mission -> Worker -> Artifact product smoke, then one same-Mission continuation/restart/replacement smoke;
8. verify no new Project/Mission/Worker owner, retry authority, transcript persistence or provider fallback was introduced.

No Project/Mission migration should be required.

## Today's usable boundary

Even before Product Shell registration, the integrated Phase 11 checkout already has the functional product path:

ordinary Chat
-> Formation
-> Project / root / Coordinator
-> Worker assignment
-> execution
-> Work Sessions
-> select/replace Worker

Product Shell is the missing front door and overview layer, not a replacement runtime.

## Non-negotiable UI invariants

1. UI projection is reconstructible and non-owning.
2. Project is the top-level product identity.
3. Mission identity survives Worker replacement.
4. Worker/provider/session identity is secondary UI detail.
5. UNKNOWN remains visibly UNKNOWN.
6. UI display failure never changes execution truth.
7. No transcript is promoted to durable Project memory by the UI.
8. UI buttons call accepted application services; they do not rewrite owners directly.
9. Provider/transport diagnostics stay behind normal product language.
10. Product polish must not weaken Phase 11 exactly-once, authority or fail-closed rules.

## UI planning baseline

The detailed product information architecture, external-pattern mapping, state grammar and Beta acceptance target are defined in `PHASE12_UI_PRODUCT_PLAN.md`.

## 2026-09-30 — Slice A/B implementation progress

The isolated Product Shell has now moved beyond the first dashboard prototype:

- added a three-layer product shell: global rail -> Project context sidebar -> main work surface;
- added global Projects / Activity / Workers / Connections / Settings views;
- added structured Human Attention derived from open Problems and failed/UNKNOWN executions;
- added a Mission focus surface that keeps Mission identity primary and current Worker secondary;
- Worker replacement UI explicitly communicates continuity: replacing a Worker does not replace Mission identity, goal or history;
- added global semantic Activity aggregation instead of raw logs;
- added a Workers view derived from current active Worker bindings;
- added Connections / Settings entry surfaces that delegate to existing Worker-status, Mission MCP and permission commands;
- kept Project list visible as the durable product context even when browsing global operational surfaces.

Fresh validation after this slice:

- Product Shell projection smoke — PASS, including blocking Human Attention derivation;
- isolated strict Product Shell TypeScript — PASS;
- isolated Product Shell bundle — PASS;
- `typecheck-shuncode` — PASS;
- Phase 11 production routing — PASS;
- Phase 11 native MCP — PASS;
- `git diff --check` for Product Shell source — PASS.

Production registration remains intentionally deferred while Phase 11 is proof-sensitive.

## 2026-09-30 — Mission depth + real Project Governance

The next isolated product slice is now implemented:

- `ProjectMissionPresentation` now truthfully exposes current non-superseded, non-committed Project Proposals as either `awaiting-human` or `confirmed-awaiting-commit`; committed Decisions remain a separate authoritative collection;
- added `ProjectGovernanceHumanApplication`, a stateless trusted-human application seam that re-reads the canonical Proposal/digest, creates Human Confirmation only through `ProjectStore.confirmProposalHuman`, then commits through the existing `ProjectDecisionService`;
- stale proposal digests, superseded Proposals, already committed Proposals and Commit without durable matching Human Confirmation fail closed;
- Product Shell now renders real Governance cards. `确认并提交` requires an explicit modal human action; Worker/Chat text cannot trigger this service;
- when Phase 12 is still isolated and no governance application is wired, the button reports that production integration is deferred rather than simulating success;
- Mission detail now renders recent executions with human tool labels, Mission Artifacts, related Problems/Answers/Evidence, and Finding/Evidence/Answer/Handoff collaboration exchanges;
- Activity now carries an explicit visual tone (`neutral` / `success` / `attention` / `unknown`) while preserving the underlying canonical state. UNKNOWN is shown as unknown, not collapsed into failure or success;
- Human Attention now also includes Project Proposals awaiting Human Confirmation or Commit.

Fresh validation:

- Product Shell projection smoke — PASS, including Proposal attention, Mission detail and Activity tone;
- Project Governance human application smoke — PASS, including no-Commit-before-confirmation and stale-digest fail-closed behavior;
- Phase 9 Project/Mission presentation smoke — PASS, proving pending governance is distinct from committed Project truth;
- Phase 5 Project Decision smoke — PASS, preserving Proposal -> Human Confirmation -> Commit and selective Decision routing;
- isolated strict TypeScript — PASS;
- Product Shell bundle — PASS;
- `typecheck-shuncode` — PASS;
- Phase 11 production routing — PASS;
- Phase 11 native MCP — PASS;
- source `git diff --check` — PASS.

Observation boundary remains explicit: `MissionObservationEvent` is currently a non-owning protocol/envelope, but the Product Shell has no accepted durable Observation-history owner to replay. The UI therefore uses canonical Project/Mission/execution/collaboration facts for Activity and does **not** fabricate a historical observation stream. A future Observation timeline must be connected only after a truthful reconstructible source exists.

## 2026-09-30 — Mission Graph + Project progress

The isolated Product Shell now also has a canonical Mission Graph and Project progress surface:

- Project progress is defined narrowly as completed Missions / total Missions. Execution count, token volume or Activity volume are not used as fake completion metrics;
- progress breakdown separately exposes running, ready/draft, waiting, failed and cancelled Mission counts;
- Mission Graph nodes are derived only from Phase 9 Mission truth: hierarchy depth, semantic role, Mission status, current Worker label and open/blocking Problem counts;
- graph edges are derived only from accepted Phase 9 relations: derived `parent_of` plus explicit `spawned_by`, `depends_on`, `informs`, `answers`, `blocks`, `validates` and `supersedes` relations;
- relation labels are product-language projections only; the UI does not create new relations or infer a critical path;
- `正在推进` is limited to Missions whose canonical state is running/ready; `等待 / 关注` is limited to waiting or attention states. These are state groupings, not scheduler recommendations;
- Graph nodes and both endpoints of each relation are clickable and resolve back to the persistent Mission identity;
- Mission-level `failed` and `waiting_user` states now enter Human Attention directly, preventing the Project overview from looking complete while the Mission Graph still shows a failed/waiting Mission.

Fresh validation after the Graph slice:

- Product Shell projection smoke — PASS, including 50% Mission progress, hierarchy edge, explicit dependency edge and blocking-node classification;
- isolated strict Product Shell TypeScript — PASS;
- Product Shell Graph bundle — PASS;
- `typecheck-shuncode` — PASS;
- Phase 9 Project/Mission presentation smoke — PASS;
- Phase 11 production routing — PASS;
- Phase 11 native MCP — PASS;
- source `git diff --check` — PASS;
- `extension.ts` still has no Product Shell registration. No Phase 12 runtime reload/provider send/proof mutation occurred.

## 2026-09-30 — Beta hardening / degraded-state truthfulness

The isolated Product Shell now treats degraded runtime and reconstruction states as first-class product states instead of collapsing them into empty UI:

- initial panel open renders an explicit loading/reconstruction screen before canonical owners finish reading;
- Product Shell projection carries ProjectStore, TaskRuntime and MissionCollaboration owner availability into a `system` health model;
- `unavailable` is never normalized to authoritative emptiness. If owner reads fail, the UI says data is unavailable and offers a re-read action instead of showing `0 Projects` as truth;
- Project source state separately exposes metadata, Decision and Collaboration availability. A Mission-backed Project with missing canonical Project metadata is shown as a partial view and safe placeholder metadata is never written back;
- durable reconstruction is labelled `ready` only when required owners are available, no presentation integrity issues exist and no Project metadata is missing; otherwise it is explicitly `partial`;
- UNKNOWN execution count is surfaced globally and per Project. Product copy states that UNKNOWN is neither success nor failure and does not grant retry authority;
- unexpected Product Shell render failure has a fail-closed error screen with explicit retry and no truth mutation;
- true empty state is only shown when Project and Task owners are available and there are genuinely no Projects/Missions;
- Mission empty lists distinguish `no Missions` from `Mission data unavailable`;
- keyboard accessibility now includes a skip link, visible focus rings, `aria-current`, labelled landmarks, arrow/Home/End navigation for global navigation, Project lists, Mission lists and Graph lanes;
- canonical owner health and reconstruction readiness are visible from the Connections surface and sidebar footer.

Hardening smoke now covers ready, degraded, missing-Project, UNKNOWN, fully unavailable and genuine-empty projections, plus semantic reconstruction equality across repeated durable reads. UI contract assertions cover loading, no-retry UNKNOWN text, skip navigation, visible focus and keyboard navigation.

Fresh validation:

- Product Shell hardening smoke — PASS;
- isolated strict Product Shell TypeScript — PASS;
- Product Shell hardening bundle — PASS;
- `typecheck-shuncode` — PASS;
- Phase 9 Project/Mission presentation — PASS;
- Phase 11 production routing — PASS;
- Phase 11 native MCP — PASS;
- source `git diff --check` — PASS;
- `extension.ts` still has no Product Shell registration; no Phase 12 runtime reload/provider send/proof mutation occurred.

## 2026-09-30 — Product-complete isolated Beta closure

The remaining product-facing gaps are now closed in isolated Phase 12 source without changing the active Phase 11 registration boundary:

- New Project now starts from Nimora UI, requires a real workspace + workspace trust, opens a fresh ordinary Chat session and reuses the existing `@shuncode` production Formation ingress instead of creating a second Project-creation path;
- Mission continuation now re-reads the canonical Mission, refuses terminal or UNKNOWN execution states, binds the exact durable `nimora-task:/<missionId>` resource and reuses the existing Task Center `openSessionWithPrompt` path;
- missing live Worker is presented as a recover/select-Worker state inside the same persistent Mission; Project/Mission identity is never replaced by the UI;
- completed Projects have an explicit completion surface while preserving Artifacts and committed Decisions;
- Workers and Connections now include read-only Phase 7 candidate availability plus live WorkerSessionManager state. Candidate observation failure remains partial/unavailable rather than becoming synthetic availability;
- candidate observations are UI-cached for 10 seconds to avoid re-probing providers on every 5-second render, while live Worker sessions remain freshly read;
- first-run / Settings readiness now exposes workspace, trust, provider availability and capability-permission entry points without introducing a second configuration or permission store;
- Project filtering and keyboard shortcuts are UI-local state only; they never become Project truth;
- `registerNimoraProductLayer` now composes the already-existing production composition, Project governance seam, operational observation source and Product Shell into one thin post-Phase-11 registration call;
- `npm run test-shuncode-nimora-product-shell` is now the standard repeatable Product Shell smoke entry.

Final isolated acceptance on this source set:

- `test-shuncode-nimora-product-shell` — PASS, including degraded/UNKNOWN/reconstruction semantics, candidate partial-failure + cache behavior, fresh-Chat Formation ingress contract, exact Mission continuation contract and proof that `extension.ts` remains unregistered;
- isolated strict Product Shell / operations / layer TypeScript — PASS;
- final Product Layer esbuild bundle — PASS;
- `typecheck-shuncode` — PASS;
- Phase 9 Project/Mission presentation — PASS;
- Mission user entry — PASS;
- same-Mission Worker replacement — PASS;
- Phase 11 production routing — PASS;
- Phase 11 native MCP — PASS;
- Product Shell source `git diff --check` — PASS.

The normal `npm run compile-shuncode` packaging command was also attempted. It stopped before source bundling because Windows returned `EPERM` while `cleanOutputs()` tried to remove the currently loaded `extensions/shuncode/runtime/bin/shuncode_process_metadata.node`. That native addon is owned by the running Phase 11 Extension Host, so Phase 12 deliberately did **not** terminate/reload the active runtime just to make packaging green. A non-destructive full-source esbuild of current `extension.ts` plus `agent-host` / `mcp-server` into `.build` completed successfully, and the final Nimora Product Layer bundle also PASSed. The normal packaging command must be rerun after Phase 11 releases the runtime/reload boundary.

Therefore the remaining Phase 12 work is no longer feature implementation. It is the **production integration gate** after Phase 11 closes: register the thin layer, build/reload, and perform real UI/provider acceptance across new Project, continuation, restart, replacement and Artifact completion. Until that gate opens, `extension.ts` remains deliberately unchanged and no Phase 12 provider send/reload/proof mutation is performed.


## Explicit UNKNOWN result review (2026-10-04)



## 2026-10-04 02:33 CST — UNKNOWN 已明确核实，原三 Worker 已恢复

2026-10-04 02:33 CST: exact failure now PROVEN by flushed EH log at01:51:10: Coordinator submitCapabilityResult/sendToolResult was rejected by DeepSeek message-frequency admission AFTER Target tools succeeded; old0521125e/9a42d861 remains consumed/UNKNOWN, never replayed. Added explicit orphan-only UNKNOWN-effects review with exact full-execution digest/count/input/time and native original-page checks; no zero-execution/pending/duplicate/live-owner admission, no fabricated completed terminal. Public review ACTUALLY saved reviewed-unknown + disposition consumed-no-replay, original unknown timestamp retained. One normal isolated EH restart34932 exit0 ->28100 loaded source. Canonical orphan-owner-death recovery restored SAME three pages/Missions to Coordinatorb143da5d/root44ff31ce/Practicebb283130, one current ref each, original adapter IDs retained; no provider send in review/recovery. All41/41 profile executions/deliveries unchanged,6 historical failures preserved; Attached41/Retired36. Relevant domain/race/cancel/active-page/public-entry/UI/recovery/Coordinator tests, typecheck, standard incremental compile/runtime PASS. New report-only provenance correction goal (three tools: full READ, one guarded PATCH, full READ) prepared in original product permission modal; Human authorization PENDING, not yet consumed/sent. Phase11 core CLOSED; Phase12 OPEN until this new live outcome/semantic acceptance and separate release verification. See PHASE12_CLOSEOUT_2026-10-03.md and finish-unknown-reviewed-recovery-audit-20261004.json.

### 已确认的根因（替代02:08的待证推断）

正常EH退出后日志刷出此前01:51:10.791/.847的完整异常。调用链为waitForDeepSeekProviderAdmission → sendToolResult → workerResolveCapability → WebMcpCommandTransport.submitCapabilityResult → WorkerSessionManager.submitCapabilityResult → MissionCoordinatorLiveDriver.executeCoordinatorCommandTurn → MissionUserEntry.continue；原文“DeepSeek provider reported a send failure before exact user-message admission: 消息发送过于频繁，请稍后重试”。结合driver先executeExactCommand/Target transport返回、后submit Coordinator结果的顺序，可确认收尾是在Coordinator结果送回阶段受限流拒绝，不是PATCH失败或重启URL变化。不能因此逆写原终态为completed。

### 恢复合同

ReviewedPracticeState新增reviewed-unknown和outcomeReview：disposition consumed-no-replay，完整四元dispatch identity、terminalStatus unknown、originalObservedAt、全执行记录SHA256/digest与count、reviewedAt。核实只允许原宿主已不再实时拥有三Worker的orphan inspection；必须有本轮工具事实、所有历史执行/投递已知且delivered、无duplicate/interaction、exact来源workerref；零执行、未知执行/投递、live-owner均拦截。三原DeepSeek native shared资源ready/exact/无running双重检查。用户业务核实保存UNKNOWN而非成功；恢复/新目标仍重新检查digest和canonical owner，原宿主死亡证明不可由memento代替。新dispatch前仍保存全新input、consumedGoals；权限不继承。

实际02:28:41 reviewed-unknown记录 executionCount36，digest897fe1e721df06c708b89cfb91a864a818a71653562a8a4f92a3490aa7a6d301，原unknown observedAt2026-10-03T17:51:10.837Z不变。02:29:38–40正常三页恢复：Coordinatorb143da5d-1441-4201-a74c-6055a6bfff70，root44ff31ce-1adc-42fb-9ae9-4beb17320e57，Practicebb283130-cd1a-428f-8b46-218c7e407833，ownerPID28100/incarnation02d58e5b-ce22-414b-91a2-c7eff8ed317e（只作为此截点）。TaskWorkerRetired三条均orphan-owner-death，保留原adapter/page身份。未发送provider内容，未授予新Worker权限，41执行/41投递未变。没有手写SQLite/journal、私有IDE注入或重新建Mission。

### 验证与下一步

Practice domain新增无review/身份不匹配/digest变化/非法时间/错误终态/零执行/未知执行或投递/live-owner等负例；实际reconcile callback覆盖取消不写、running页拦截、确认期间记录变化不写、正确核实只更新memento不改变owners；实际run callback覆盖Target checkpoint已知后Coordinator失败仍保留Targetcompleted并另记coordinationFailure。Practice、READ、三新页replacement、UI Host、Coordinator、typecheck、标准compile incremental、runtime均PASS，scoped diff-check0。新宿主的公开核实菜单和实际memento保存证明本轮代码已激活；未声称对所有runtime模块做loaded-hash独立校验。

最后一条全新目标已进入产品“授权并启动”安全弹窗，仅3工具：完整READ报告 → 一次版本保护PATCH校正第七节来源/日期/准确七组/U编号 → 完整READ核验，不run_command、不todos/progress、不改需求/index。这是新目标，旧0521125e不重发；本步骤尚未发送，也未生成新dispatchId。computer-use强制规则禁止代点权限，已请求Human本人点击；无需再次共享三页、换URL或输入目标。启动后审计新callback的持久Target terminal、Coordinator ack、实际文件来源与无额外工具，才有资格把这次目标收敛。发行包和广泛provider/restart体验仍是独立未验证项，不能把报告100当作整个Phase12正式CLOSED。
