# Mission Work Architecture

## 1. Purpose

This document defines the product/work-organization layer that sits above Nimora's existing Task / Worker / Capability foundation.

The short version is:

> **Project persists. Missions finish. AI workers are disposable.**

> **文形成当前最佳认知，理用实践检验认知；现实产生的新问题重新进入文。**

> **讨论不改变项目；被人确认并 Commit 的决定才改变项目。**

This is not a second runtime. It is the next semantic layer of the existing Nimora Task Runtime.

## 2. Mapping to current Nimora

Current implementation already provides the main substrate:

```text
TaskRuntime
├─ durable append-only Task journal / replay
├─ Task context / decisions / artifacts / progress
├─ execution + delivery ledger
├─ capability grants
└─ Work Sessions projection

WorkerSessionManager
├─ worker registry
├─ managed session identity
├─ Task bind/unbind
├─ send / interrupt / health / dispose
└─ API / AgentHost / Web adapters

Context Handoff
└─ bounded provider-neutral continuation package

WebWorkerAdapter
└─ WebMCP → real webpage AI session
```

Mission Work must extend these boundaries rather than rebuilding them.

### Phase 1 implementation (2026-09-13)

The first durable Project/Mission slice is now concrete:

- `src/project-contract.ts` defines the v1 Project snapshot/event contract;
- `src/project-store.ts` owns an append-only `projects-v1.jsonl` journal whose only Phase 1 event is `ProjectCreated`;
- Project v1 persists only identity/metadata (`projectId`, optional `title/goal/workspace`, timestamps). It does **not** persist `missionIds`;
- existing Tasks become Missions only through the v1 `TaskMissionConfigured` event; `TaskCreated` is unchanged;
- Mission identity is the existing Task `taskId`; `TaskSnapshot.mission.projectId` is the only durable Project↔Mission membership link;
- root Missions use `taskId === rootMissionId` and no parent; child configuration requires an already configured root and parent in the same Project/root chain;
- Mission configuration is fail-closed and one-time: identical metadata is idempotent, conflicting reconfiguration is rejected;
- Work Sessions remains a read-only `nimora-task:/<taskId>` projection and now exposes optional Project/Mission identity without adding a Project→Mission tree contract.

Phase 1 itself did not implement Mission completion/finalization, worker retirement, coordinator AI, Mission Graph, typed Finding/Problem/Answer routing, or transcript-based recovery. Phase 2 now implements the first two lifecycle items; coordinator AI and graph/exchange semantics remain later phases.

### Phase 2 implementation (2026-09-13)

The Mission death boundary is now concrete without introducing another runtime:

- `TaskRuntime.finalizeMissionStrict()` writes `TaskMissionFinalized` fail-closed. When policy requires a final Handoff, the report is built from the exact task-exclusive final snapshot and enters the same event as completion; its Mission ownership, source Task event revision and content digest are persisted and verified. Replay recomputes SHA-256 from the actual Handoff content rather than trusting mutually consistent declarations, and rejects Finalized-before-Configured without installing a terminal freeze;
- `TaskRuntime.archiveMissionStrict()` is a second transition and refuses archive until finalization exists, required Handoff is present, and every Worker ref in that Mission history has durable retirement;
- `TaskWorkerRetired` adds durable retirement bookkeeping to the existing Task-owned Worker ref. Provider-native death is stronger and is derived from either a finalized owning Mission or an explicitly retired ref. A finalized/archived Mission freezes all working-state mutation in both live writes and replay;
- `MissionFinalizationService` first installs a Mission-level Task admission fence and snapshots the now-closed Worker history, then releases the task lock before acquiring the sorted Manager multi-identity lifecycle barriers. Inside the stabilized protocol it performs idle check → bounded Context Handoff + strict Task finalization → strict retirement of the Mission's durable Worker refs → provider-native live-wrapper retirement → strict archive. Snapshot-late identities cannot attach to the finalizing Mission even though they were absent from the initial barrier set. `TaskMissionFinalized` itself establishes the durable provider-native death fact, so restart/fresh Manager/fresh wrapper cannot depend on a managed-id tombstone;
- Manager retirement installs an in-memory tombstone before best-effort provider cleanup. A failed `dispose()` is observable and retryable but never makes the Worker active again;
- retirement identity includes both Nimora `managedSessionId` and provider-native `workerId + adapterSessionId`. Manager lifecycle operations for one provider-native identity share a serialization barrier, so create/reattach publication cannot race past retirement; Task replay can reject a fresh managed wrapper around a retired webpage/AgentHost conversation after process restart;
- deferred send capabilities and other execution-continuation entry points share that same boundary: adapter `send()` is not invoked until first consumption revalidates durable death/current Mission admission and acquires an active-send lease. Rebind/resume still require ordinary Mission admission. A host-requested capability result is the one narrower case: once the exact provider turn has already won admission, its pending `inputId + callId + capability` is bound to that exact active send lease and may complete through a closed temporary finalization fence, while still revalidating durable provider-native death. Finalization that wins first therefore revokes late attach/create/send before provider execution, while send-start that wins first can finish itself without reopening admission. Cancellation/error/consumer-close revoke the lease-bound continuation; stale/wrong/duplicate results fail closed;
- when an A-owned provider identity is currently wrapped by Mission B, A's durable death remains authoritative. A failure to persist B's secondary retirement bookkeeping cannot keep the old identity routeable or block A archive; it is surfaced as a cleanup/ownership warning. B itself remains unfinalized and may continue with a genuinely new provider identity. Exact rebind never transfers A's death authority over the old conversation;
- ordinary Worker disposal/failure still means detach, not Mission death. Replacement Workers can continue the same unfinalized Mission; once that Mission finalizes, its earlier detached/crashed Worker refs are retired as historical Mission-owned conversations too;
- the final Handoff is produced from Task-owned durable state and explicitly does not require the previous provider transcript.

This phase still does **not** add an AI coordinator, automatic decomposition, Mission Graph, typed Finding/Problem/Answer routing, or a new UI hierarchy.

## 3. User-facing mental model

Users should only need to understand four main concepts:

```text
Project
  ↓
Mission
  ↓
AI Worker / Conversation
  ↓
Capability / Tool
```

Internal concepts such as AHP, WebMCP protocol, execution ledger and adapter-native session IDs remain implementation details.

### Project

The long-lived thing being built or maintained.

For a software project, the workspace/repository is the primary physical body, but Project also owns durable Nimora knowledge:

- identity / goal / current state;
- architecture / principles / constraints;
- committed decisions;
- verified facts / evidence;
- artifacts;
- open problems;
- mission history;
- handoffs.

### Mission

A bounded historical purpose with explicit completion criteria.

Examples:

- 调查当前适合博客的播放器方案；
- 完成静态博客第一版；
- 给现有播放器增加歌词；
- 调查移动端兼容问题；
- 验证本轮部署结果。

Mission is not strictly the chat window. The Mission is the work; a WorkerSession is the AI resource doing that work. Normally one mission may use one conversation, but a crashed/rate-limited worker can be replaced without killing the mission.

### Work Order / Command

A Work Order is a bounded instruction **inside** an existing Mission. It is not automatically a Mission boundary.

Typical examples include an implementation slice, a consolidated repair batch, another test/regression pass, a follow-up investigation that remains within the same Phase responsibility, or a new instruction issued after Cognition has incorporated Practice evidence. A Worker may finish one Work Order and enter a waiting state while its Mission remains alive.

This distinction is initially an operating/domain rule rather than a new durable runtime object. Phase 3 will use it as an explicit experiment and should only promote it into a first-class persisted contract if implementation evidence justifies that move.

### WorkerSession

The temporary AI conversation/runtime assigned to a Mission. Web/API/local/AgentHost sessions are interchangeable worker resources.

### Capability

The executable ability used by a Worker: files, terminal, LSP, browser, Personal Edge and future providers.

## 4. Mission planes

Mission semantics belong to the work, not to the model.

```text
plane = coordination | cognition | practice
```

### Coordination / 总协调

A temporary coordinator mission acts as the semantic bridge for a root mission. It executes and transports decisions made by the responsible Cognition scope; it is not the planner for that scope:

- inspect the bounded Project/Mission facts needed to route an already-authorized action;
- idempotently ensure/configure a child Mission whose purpose/plane/completion criteria were already specified by Cognition;
- deliver bounded Mission input / Work Orders to the explicitly selected target Mission/Worker;
- return structured Result/Finding/Problem/Evidence/Answer/Handoff to the owning Cognition scope;
- execute explicit Problem/Decision/lifecycle routing through the existing semantic services;
- survive Worker replacement by rebinding a new Worker to the same Coordination Mission and reconstructing route state from durable owners;
- retire when Cognition has judged the root purpose complete and an explicit finalization instruction passes mechanical lifecycle/admission checks.

The Coordinator does **not** decide whether the current need is Cognition or Practice, invent Mission decomposition, choose Mission goals, interpret technical content, make semantic completion judgments, or replace Project-/Phase-level Cognition. In short: **Cognition understands/decides; Coordinator connects/transports; Practice acts on Reality.**

The coordinator AI is an ordinary disposable WorkerSession. It is not the technical Nimora Bridge.

### Cognition / 文

Typical mission types:

- research;
- analysis;
- planning;
- architecture;
- investigation;
- deliberation.

文 produces the best current understanding based on available evidence. Its output is not immutable truth.

For the Phase 3 development experiment, a Phase-level Cognition Mission also owns the Phase's planning authority across time: initial repository search/architecture, the Phase Mission Plan, later plan revision, and generation of Practice Work Orders after new Result/Problem/Evidence arrives. Producing the first plan does not itself complete that Cognition Mission.

### Practice / 理

Typical mission types:

- implementation;
- operation;
- debugging;
- deployment;
- testing;
- verification.

理 changes or measures reality. It has freedom to adapt locally and must be able to report when current cognition no longer matches reality.

For the Phase 3 development experiment, a Phase-level Practice Mission may execute multiple Work Orders. Finishing one order returns Result/Problem/Evidence and normally moves the Practice Worker to waiting rather than completing the Mission. Practice may recommend next routing but does not own authoritative Mission decomposition or successor-Mission creation.

## 5. Cognition-Practice feedback loop

The system must never reduce to a fixed one-way plan.

```text
                 Cognition Mission
                 文：调查/思考/规划
                        │
                 Finding / Understanding
                        │
                        ▼
                  Practice Mission
                  理：实践/测试/验证
                        │
                  Problem / Evidence
                        │
                        ▼
                 Mission Coordinator
                        │
                 transport Problem
                        │
                        ▼
                 owning Cognition
                 decides next Mission/action
                        │
                        ▼
                 Coordinator executes route
                        │
                        ▼
                 Answer / Updated View
                        │
                        └────────► Practice continues
```

Practice may continue unaffected work while a non-blocking problem is researched.

If new evidence invalidates a major direction, the responsible Cognition Mission decides whether to pause/supersede old Practice or create different work. The Coordinator executes that explicit routing/lifecycle instruction; it does not invent the replacement direction itself.

### Phase-level cognition/practice lifetime experiment

The Phase 2 development process showed why the feedback loop must persist in time rather than exist only as a diagram. Research/plan workers ended after their first plan, so later Practice/Verifier workers inherited planning responsibility and recursively created successor Missions. Phase 3 tested the following human-confirmed, revisable rule and completed successfully with this pattern:

> **The planning function persists for the Phase; the worker need not be permanent, but the Cognition Mission remains responsible until Phase closure. Practice executes and reports reality; it does not become the replacement planner.**

The Phase 3 experiment established the following preferred default, still revisable by later evidence:

- Phase Cognition remains alive (or is recovered by a replacement Worker into the same Mission) from initial research through Phase closure;
- Phase Practice remains alive across multiple implementation/repair Work Orders and can wait between orders;
- the bridge/Coordinator is a routing/transport role and does not independently invent the Phase decomposition;
- Mission state and the current Phase Plan must remain durable enough that replacing either Cognition or Practice Worker does not erase the Phase's memory;
- this is not permission to create a permanent AI brain: the Phase-level Missions still have explicit completion criteria and retire at Phase closure;
- later evidence may revise the exact lifetime/verification mechanics through the normal decision process.

## 6. Mission Graph

Mission relationships must be explicit and durable rather than hidden in transcripts.

Initial relation types should stay small:

```text
parent_of
spawned_by
depends_on
informs
answers
blocks
validates
supersedes
```

Do not start with a complex workflow DSL. A graph plus typed events is sufficient for the first implementation.

## 7. Structured exchanges

Mission-to-mission collaboration should pass bounded structured information, not whole conversation histories.

First-class exchange types for the first useful loop:

### Finding

What cognition learned and why it matters.

### Problem

What practice discovered that current knowledge cannot safely resolve.

Recommended fields:

- source mission;
- current goal;
- previous assumption;
- observed reality;
- evidence refs;
- precise question;
- blocking/non-blocking;
- severity/status.

### Answer

The cognition result that resolves or narrows a Problem, with evidence and confidence.

### Evidence

A durable reference to facts, logs, files, URLs, test output or other observations.

### Decision

A committed direction/constraint. Human-confirmed decisions may be Project-scoped.

### Handoff

The bounded inheritance package produced before a mission worker is retired.

These exchanges can initially be implemented as Task/Project events plus structured artifact references; do not create a second competing transcript system.

### Phase 3 collaboration implementation (2026-09-15; independently CLOSED)

The Phase 3 repository audit resolved the first implementation seam as a **small Nimora-owned Project/Mission collaboration store** rather than another runtime or a set of unrelated per-Mission metadata blobs. Work Order #1 implemented that seam in `src/mission-collaboration-contract.ts` and `src/mission-collaboration-store.ts`; Work Order #2 hardened replay/bounds evidence in `scripts/shuncode-mission-collaboration-smoke.mts` without requiring production changes. A fresh comprehensive Independent Verification subsequently returned `RESULT: PASS`; this boundary is now independently closed and is the durable collaboration substrate that Phase 4 may consume.

```text
ProjectStore                     TaskRuntime
  Project identity                Mission identity/membership
        \                         /
         \                       /
          MissionCollaborationStore
          ├─ explicit cross-Mission relations
          ├─ typed bounded exchanges
          └─ replay/query projection
```

The collaboration store uses one strict append-only `mission-collaboration-v1.jsonl` journal for the new cross-Mission facts. It validates Project existence and Mission endpoints against the existing owners before accepting a live write and again while reconstructing its visible replay projection. Persistence succeeds before a record becomes visible in memory; torn/corrupt rows are ignored observably and a later legal append remains replayable. It does **not** own Task execution, Worker lifecycle, Mission finalization or Project→Mission membership.

`TaskSnapshot.mission.projectId` remains the only durable membership link. In particular, `parent_of` must be exposed by the Mission Graph as a **derived relation** from the already-immutable `parentMissionId`; persisting another parent edge would create competing truth. Other Phase 3 relations are new collaboration facts and may carry an optional bounded provenance exchange id (for example, a `spawned_by` relation can cite the Practice `Problem` that caused a Cognition Mission to exist).

The v1 relation identity is explicit and durable:

```text
relationId
projectId
sourceMissionId
targetMissionId
type
createdAt
basisExchangeId?   // bounded provenance, not transcript
```

Same-id/same-content retry is idempotent; same-id/different-content is an identity collision and fails closed. Explicit self-edges fail. `parent_of` inherits the acyclic Mission configuration model; `spawned_by` and `supersedes` are historical ordering relations and should reject cycles. `depends_on`, `informs`, `answers`, `blocks` and `validates` are descriptive collaboration relations and are not globally forced into a DAG in Phase 3.

The v1 exchange envelope is immutable and deliberately smaller than a workflow state machine:

```text
exchangeId
projectId
sourceMissionId
targetMissionId?      // routing target when one already exists
kind = Finding | Problem | Evidence | Answer | Handoff
createdAt
replyToExchangeId?    // e.g. Answer → Problem
payload               // kind-specific and bounded
```

There is no generic mutable `status` field in the initial contract. A Problem's answer state can be derived from Answer linkage; mutable routing/workflow status would prematurely implement later orchestration. `Problem` keeps the minimum reality-challenge fields (current goal, previous assumption, observed reality, precise question, blocking flag and Evidence exchange refs). `Finding` and `Answer` carry bounded summaries plus evidence/provenance references. `Evidence` is a bounded set of durable references (artifact/file/URL/test/event-style references), not a large arbitrary text dump. Confidence is not required in v1; `Answer` may carry bounded limitations where that is materially useful.

`Handoff` does not create another inheritance payload. It references the existing verified Mission final-Handoff report/artifact identity and may route that bounded artifact to another Mission. The provider transcript remains outside Project/Mission collaboration state.

The canonical Phase 3 proof is fixed before implementation:

```text
Practice Mission
  → durable Evidence + Problem
  → Cognition Mission configured in the same Project
  → explicit spawned_by relation with Problem provenance
  → Cognition durable Answer replying to Problem and targeting Practice
  → restart ProjectStore + TaskRuntime + collaboration store
  → relation/exchange ids, Project/Mission endpoints and Answer route survive
  → no full provider transcript is read or copied
```

This store is intentionally not wired into automatic Cognition/Practice dispatch. Current production callers do not auto-route exchanges; the Phase 3 smoke drives the semantic API directly. Phase 4 owns the feedback-loop orchestration; Phase 6 owns Coordinator AI control surfaces. Phase 3 only makes the collaboration facts durable, structured and replayable.

Verification-readiness hardening additionally locks the one-pass replay boundary: a dependent row that is invalid at its journal position is ignored rather than deferred and does not become visible merely because its dependency appears later. Replay also re-proves relation identity collision behavior, `spawned_by`/`supersedes` selective cycle rejection, exact Handoff reference identity, artifact Evidence ownership and representative collection/nested-text bounds. These are validation properties of the same Phase 3 domain model, not workflow/orchestration semantics.

### Phase 4 WO#1 control seam (implemented; Phase not yet independently verified)

Phase 4 WO#1 implements the Cognition-selected narrow **`MissionFeedbackService`** in `src/mission-feedback-service.ts`. It sits above `ProjectStore` + `TaskRuntime` + `MissionCollaborationStore`; it does not replace any of them and owns no independent durable workflow journal. From an explicitly selected durable Practice `Problem`, it validates Project/source Mission identity, derives a stable feedback-operation identity, uses `TaskRuntime.ensureTask()` + immutable Mission configuration to ensure one retry-stable Cognition Mission, records `spawned_by` with the Problem as `basisExchangeId`, builds a bounded Problem/Evidence-only cognition package, records a reply-linked/Practice-targeted `Answer` plus `answers` provenance, and reconstructs a bounded continuation whose route points to the original Practice Mission.

Live Worker routing remains explicit and owned by `WorkerSessionManager`. Phase 4 host code may choose/create a WorkerSession and send the service-rendered package, but the service does not choose providers/models and the Manager does not become Project memory. After restart, the durable Answer target/reply provenance is the routing authority; a replacement Worker can bind to the **same unfinished Practice Mission** and receive Task Context Handoff plus the bounded Answer package. This is intentionally weaker than exactly-once provider delivery: an unknown send boundary must not be converted into permission to replay Practice side effects.

WO#1 closes the Task-creation provenance gap additively: `TaskSourceKind` is now `native-chat | bridge | mission`, and feedback Cognition creation uses `kind = mission` plus a SHA-256-derived stable operation key instead of impersonating Bridge/Chat. That source identity is creation/idempotency provenance only; Project membership still comes exclusively from `TaskSnapshot.mission.projectId`, parentage still comes exclusively from Mission metadata, and cross-Mission `spawned_by` remains exclusively in the collaboration journal. No second durable workflow state or Project→Mission membership was introduced.

`scripts/shuncode-mission-feedback-smoke.mts` exercises the implemented semantic seam directly, including the adversarial X→Reality Y→Problem→new Cognition→Answer→same-Practice continuation path, provider-history sentinel exclusion, restart after Problem, restart after Answer, source replay, cross-store partial-progress retry, adjacent Answer/provenance retry, wrong-route rejection and identity collision. This is **WO#1 implementation evidence, not Phase 4 closure**: no production caller automatically drives the loop yet, no live Worker delivery ownership moved into the service, and independent Phase 4 verification remains pending.

### Phase 4 Cognition reconciliation after WO#1 (2026-09-15)

The persistent Phase 4 Cognition Mission has now directly inspected `MissionFeedbackService`, the additive `mission` Task-source contract and the dedicated feedback smoke rather than accepting the Practice report at face value. It independently reran the feedback, Project/Mission, Phase 3 collaboration, Context Handoff and WorkerSessionManager smokes plus ShunCode typecheck/compile; all passed, diagnostics remained 0/0 and `git diff --check` exited 0. WO#1 is therefore accepted as current implementation truth.

This does **not** make Phase 4 verification-ready yet. The remaining required proof is live continuation ownership: an explicit host must deliver the bounded continuation to a WorkerSession actually bound to the original unfinished Practice Mission B, and after a process restart a fresh Manager must bind a genuinely new replacement Worker to that same B and seed it from B-local Context Handoff plus the durable Answer package. The proof must keep two facts separate: durable Answer target/reply provenance determines the route, while `WorkerSessionManager.send()` is a live transport action. Observing a terminal live turn can prove that turn completed; an interrupted/unknown send boundary cannot be promoted into durable workflow state or permission to blindly re-run side effects.

WO#2 is therefore verification hardening around existing owners, not an invitation to add a delivery ledger, autonomous dispatcher, provider selector or broader Coordinator surface. `MissionFeedbackService` remains deterministic/provider-neutral composition; `WorkerSessionManager` remains the live Worker router; Task Context Handoff remains same-Mission replacement state rather than a cross-Mission transcript mechanism.

### Phase 4 WO#2 live/replacement continuation implementation (independently verified; Phase CLOSED)

Direct execution showed one narrow composition gap: the generic `WorkerSessionManager.send()` API correctly routes a caller-selected managed session but does not know that a `PracticeFeedbackContinuationPackage` is durably targeted to a particular Practice Mission. WO#2 adds `src/mission-feedback-worker-input.ts` as a pure manual-host admission/renderer. It validates the continuation's Problem/Answer/Evidence identities, Project and Practice target, rejects finalized/wrong/non-Practice Mission snapshots, requires the selected live WorkerSession to be bound to that exact B task, optionally validates a same-B Context Handoff, enforces a prompt bound, and returns a provider-neutral `WorkerInput`. It owns no journal and performs no send, Worker creation, provider/model selection or lifecycle mutation.

The dedicated Phase 4 smoke now drives the full historical loop through the real `WorkerSessionManager`: the bounded revised Answer is sent to a WorkerSession bound to the original B and reaches a successful terminal while the session remains bound to B. After stores/service/Manager/provider-memory restart, a fresh Manager creates a different managed/provider-native Worker, binds it to the replayed same B, combines B-local Context Handoff with the reconstructed durable Answer continuation, and again reaches successful terminal without creating B2. Old provider history is seeded with `STALE_TRANSCRIPT_SENTINEL_DO_NOT_REPLAY`; the sentinel and old provider-native identity are absent from Cognition input, feedback continuation, replacement handoff, Worker-visible input and durable journals.

The same smoke injects an unknown live-send boundary after the provider has observed the input but before any successful terminal. Reconstructing `MissionFeedbackService` and the durable continuation causes no send, no B2, no invented collaboration delivery fact and no Answer-consumed mutation. A later send therefore remains an explicit host decision. This preserves the architecture law `durable Answer route != durable provider delivery acknowledgement` and leaves unknown delivery outcomes unknown rather than manufacturing exactly-once semantics.

Phase 4 Cognition directly reconciled WO#2 rather than accepting Practice's report as authority. It inspected the pure host admission/renderer and the full feedback smoke through the finalized-Mission/stale-worker/replay tail, independently reran the focused Phase 4 and affected owner gates, dynamically executed all 35 current `test-shuncode-*` package suites, and reran typecheck/compile/diagnostics/diff-check successfully. A fresh comprehensive Independent Verification then independently falsified same-B identity, transcript independence, deterministic retry/replay, wrong-route/lifecycle admission, provider-send uncertainty semantics, Phase 3 ownership preservation and scope boundaries and returned `RESULT: PASS`. Phase 4 is therefore **CLOSED / COMPLETE (2026-09-15)**.

The verifier explicitly examined a host-forged in-memory continuation / handoff-text construction and did not classify it as a Phase 4 blocker. That is the correct boundary for this Phase: the manual host is trusted orchestration code and already has authority to construct arbitrary `WorkerInput` and invoke generic `WorkerSessionManager.send()`. `buildMissionFeedbackWorkerInput()` is a provider-neutral fail-closed composition helper for the normal durable-owner path; it is not claimed to be a capability-security sandbox against a malicious host. Any future untrusted-host/capability boundary must be introduced and verified explicitly rather than inferred from Phase 4.

## 8. Human-AI Deliberation / 人机共议

Human deliberation is Cognition work. It may occur inside an existing Project-/Phase-level Cognition Mission when the strategic question already belongs to that scope. A separate Deliberation/Cognition Mission is created only when the deliberation itself deserves independent historical identity, lifetime, substantial research, completion criteria or a durable deliverable.

It is **optional but always available**. Human silence must not block ordinary autonomous work.

The discussion space has explicit commit semantics:

```text
Draft
→ Proposed
→ Human Confirmed
→ Committed
```

Draft discussion, brainstorming, reversals and hypothetical ideas do not mutate Project state.

Full deliberation transcripts remain temporary/session-local cognition. A bounded current-understanding summary may guide the active Cognition Mission, but rejected brainstorms and transcript history are not inherited as authoritative Project memory.

Only `Committed` structured output becomes a durable Project Decision/Change. After commit, an impact step determines which active missions need the new decision in their context. Route only the bounded structured decision/change; do not broadcast the full deliberation transcript.

### Hierarchical authority and reporting law (Human Confirmed 2026-09-20)

Project-/Phase-/Practice Cognition is deliberately hierarchical. The authority direction and information direction are asymmetric:

> **计划向下，报告向上。**

```text
Project Cognition / 总文
        │
        │  Project / Phase Plan ↓
        ▼
Phase / Mission Cognition / 文
        │
        │  Work Order / bounded plan ↓
        ▼
Practice / 理

Practice / 理
        │
        │  Report / Result / Problem / Evidence / Handoff ↑
        ▼
Phase / Mission Cognition / 文
        │
        │  Cognition / Phase Report ↑
        ▼
Project Cognition / 总文
```

The semantic rule is strict:

- `Project Cognition / 总文 → 文` may issue the authorized Project/Phase plan, scope, constraints and completion boundary.
- `文 → 理` may issue the authorized Work Order, implementation/investigation boundary, constraints and acceptance criteria.
- `理 → 文` may only return bounded reports: Result, Problem, Evidence, Finding, Handoff, capacity/liveness state and non-authoritative recommendations. Practice cannot command Cognition, require it to create another Mission, force acceptance of a Result, or grant itself successor authority.
- `文 → 总文` likewise returns only a bounded Cognition/Phase report. It may report a Project-level ambiguity, blocker, recommendation or need for a Project decision, but it cannot command Project Cognition or require a particular Project-level action.
- Recommendations inside an upward Report are evidence/advice only. They carry **no planning or authorization authority** until the receiving higher Cognition independently incorporates them into a downward Plan/Work Order.
- Coordinator is outside this semantic rank chain. It transports and executes already-authorized downward plans and upward reports; it does not generate either side's semantic authority.

This does not silence Reality feedback. Lower scopes are expected to report contradictions, Problems and Evidence aggressively; the restriction is that **facts may flow upward, authority may not**.

### Context-capacity exhaustion and Cognition/Practice succession (Human Confirmed 2026-09-20)

Provider conversation/context exhaustion is a **Worker-capacity/lifecycle event**, not Mission completion and not permission to recreate the Mission. The same Mission/responsibility continues with a replacement Worker.

The product intent is now explicit:

> **Coordinator reliability handles Web/chat Worker instability; Coordinator + deterministic Worker conversation lifecycle handles finite provider context.**

Nimora therefore does not try to make one provider conversation immortal or to make provider context infinite. It makes Worker failure survivable and conversation capacity renewable: canonical Project/Mission truth stays outside provider chat history, a bounded Handoff is produced before/at rotation, the old Worker is durably retired, a replacement Worker joins the **same Mission**, and Phase-8 Context/Skill/Capability state is freshly materialized for that replacement. Provider-side archive/delete is cleanup only and never business-state authority. See WORKER_CONVERSATION_LIFECYCLE.md.

The succession path follows the same hierarchy:

```text
Practice Worker context exhausted
→ old 理 emits bounded Practice Handoff Report upward
→ owning 文 receives/reconciles the report
→ 文 authorizes a replacement 理 Worker for the SAME Practice Mission
→ new 理 reconstructs from durable Project/Mission truth + current Work Order + Handoff

Cognition Worker context exhausted
→ old 文 emits bounded Cognition Handoff Report upward
→ 总文 receives/reconciles the report
→ 总文 authorizes a replacement 文 Worker for the SAME Cognition Mission/responsibility
→ healthy existing Practice Missions/Workers remain in place
→ new 文 becomes the receiving Cognition for their later Reports

Project Cognition Worker context exhausted
→ old 总文 first persists current bounded Project-level truth
→ emits a Project Cognition Handoff Report to its successor
→ replacement 总文 Worker assumes the SAME Project-level Cognition responsibility
```

Replacement is not replay authority. If the exhausted Worker leaves an unresolved side-effect outcome, delivery uncertainty or other `UNKNOWN`, the successor must reconstruct and reconcile that exact state before any retry. `Worker replaced` never implies `previous operation may be resent`.

A Handoff is an upward **Report**, not a substitute for the next Plan. After succession, the higher Cognition (or the successor Project Cognition at the top level) remains responsible for issuing any new downward plan. Full provider transcripts are not required for succession and do not become Project memory.

Replacing a higher-level Cognition Worker does not automatically replace healthy lower-level Workers. A 文 Worker reaching its context limit must not kill or recreate its still-healthy 理 Workers; their Missions continue and later Reports are routed to the replacement 文. The same principle applies to Project Cognition replacement and active Phase/Mission workers.

### Reliability observation is projection, not a new owner (2026-09-28)

P0 reliability hardening adds a provider-neutral `BrowserWorkerOperationalObservation` vocabulary plus a bounded `MissionObservationEvent` envelope so browser/runtime state, canonical owner events and later UI/eval tooling can share one observation language. This is deliberately a **projection seam**, not a fourth durable business owner: ProjectStore, TaskRuntime and MissionCollaborationStore retain canonical truth; WorkerSessionManager retains live Worker lifecycle; Phase-8/execution owners retain capability/replay authority.

The browser observation dimensions are transport, page identity, provider-conversation identity, provider turn, authentication and capability-surface state. Derived states such as `connection-lost`, `recovering`, `conversation-drift` and `settlement-unknown` describe observed operational reality only. In particular, browser/provider `turnSettlement=settled` is **not** proof that an external capability side effect committed and never authorizes retry. Connection loss while a turn is active remains active/unknown for recovery purposes; a durably retired Worker generation remains retired regardless of transient page state.

`MissionObservationEvent` may point to canonical Project/Task/Collaboration source records and carry bounded correlation/causation/occurrence metadata, but it does not clone canonical payloads or admit provider prompt/transcript/reasoning/DOM content. See `P0_RELIABILITY_FOUNDATION.md`.

Phase 5 is independently **CLOSED / COMPLETE (2026-09-15)**. WO#1 implements the intended product-runtime shape, and Repair WO#2 addresses the replay blocker found by the first fresh Independent Verification. `ProjectStore` remains the single Project governance owner and adds immutable bounded `ProjectProposalRecorded`, explicit `ProjectProposalHumanConfirmed`, authoritative `ProjectDecisionCommitted`, and minimal `ProjectProposalReplaced` history; Proposal content is digest-bound and the live Commit API itself cannot manufacture confirmation evidence. The durable journal boundary passes both production writes and replay rows through one strict `normalizeProjectEvent()` validator that enforces exact event envelopes, exact type-specific payloads and exact nested Proposal/Human Confirmation/Committed Decision structures. Unsupported fields no longer survive by being silently normalized away. Cognition reproduced the original matching-digest malformed-confirmation attack after repair, and one fresh epistemically independent re-verifier then independently re-tested that attack plus the complete Phase 5 boundary and returned `RESULT: PASS`. Duplicate/concurrent Commit, persistence-uncertainty retry and Draft non-persistence are therefore verified Phase 5 semantics.

The routing seam remains deliberately non-owning. `ProjectDecisionService` holds no journal or scheduler state and mechanically resolves `project` or explicit bounded Mission-id scope against current `TaskRuntime` membership/finalization facts. The pure `buildProjectDecisionWorkerInput()` admits only an exact Committed Decision, an affected same-Project unfinished Mission and a WorkerSession bound to that exact Mission; it may include same-Mission Context Handoff but never a full deliberation transcript. The host must still explicitly invoke `WorkerSessionManager.send()`. Commit authority is therefore independent from provider delivery acknowledgement: UNKNOWN remains UNKNOWN, restart performs no automatic resend, and replacement Workers reconstruct from structured Project Decision plus same-Mission durable context rather than old provider history. `MissionCollaborationStore` kinds remain unchanged and ProjectStore still does not own Project→Mission membership.

### Phase 10 binding Project-formation decision (Human Confirmed 2026-09-17; implementation pending)

Raw user intent is input evidence, not durable Project authority. A newly auto-formed Project must first pass through bounded pre-Project Project Formation Cognition that produces an exact Formation Result. A sufficiently clear request may authorize formation in that same bounded step without a ceremonial extra approval; consequential strategic/value/permission/autonomy/privacy/cost ambiguity requires explicit human confirmation of the exact Formation Result before Project birth. The first authoritative Project fact is then a durable `ProjectCreated` record carrying only the bounded authorized formation result/receipt needed for Project/root provenance and recovery, never the full deliberation/provider transcript. The binding persistence direction is pre-Project/session-local Formation Cognition with **no durable Draft Project shell by default**. Phase 10 implementation must prove stable formation identity/idempotency, Project-first/root-second recovery and compatibility with existing owners; Coordinator, provider/session identity and raw chat do not gain Project-birth authority from this decision.

### Phase 6 WO#1 explicit-command Coordinator bridge foundation + Repair WO#2 (Cognition accepted)

`MissionCoordinatorService` is a stateless/reconstructible Nimora-owned bridge over the existing durable owners. For an explicit `projectId + managedRootMissionId`, it deterministically bootstraps one ordinary child Mission on the `coordination` plane from a provider-neutral `TaskSource.kind = "mission"` identity. Explicit ensure-Mission commands must supply the stable operation key, bounded goal, exact parent, plane, Mission type and completion criteria; the bridge normalizes and admits that already-decided meaning but never chooses or rewrites it. Retry/restart reuses the same Task source identity, while a reused semantic operation identity with different Mission meaning fails closed.

The same facade exposes only bounded managed-scope inspection and an explicit Practice-Problem route. Inspection projects Project/root/Coordinator identity, in-root Mission metadata and terminal state plus relevant relation/exchange route identities; it does not expose Task snapshots, Worker/provider/model/session data or transcript/history and performs no durable write. A durable `Problem`, including `blocking: true`, is inert with respect to orchestration until the caller explicitly invokes the Problem-route command. Only then may the facade delegate to the already-verified `MissionFeedbackService` deterministic `Problem → feedback Cognition → Answer → same Practice` path. The Coordinator facade does not import `WorkerSessionManager` or Project Decision/Commit helpers and therefore owns no Worker selection, send, delivery ledger, Human Confirmation or Commit authority.

Mission child admission remains owned by `TaskRuntime`, not by the Coordinator facade. Repair WO#2 linearizes new child configuration with root/parent finalization by acquiring the child, root and parent Task operation lanes in one deterministic sorted order and holding them through the strict durable `TaskMissionConfigured` write. Duplicate identities are collapsed before acquisition, so the common `root === parent` case cannot self-deadlock. If the Phase 2 Mission-finalization stabilization fence wins first, child admission also rejects the owner's in-memory `finalizingMissions` state; if the child owns the relevant lanes first, finalization waits until the child is durably established. The existing-Mission idempotency branch remains ahead of terminal/finalizing rejection, so an identical child that was already configured remains rereadable after later owner finalization/archive without another event. This composition acquires only TaskRuntime lanes and never crosses into provider-native barriers, preserving the existing provider barrier → task lane lifecycle order. Deterministic owner-level regressions cover root and distinct-parent finalization-wins/child-wins orderings, root==parent de-duplication, concurrent identical retry and restart/replay. Phase 6 Cognition independently inspected the lock shape and reran its own temporary four-ordering race probe; root-finalization-wins, root-child-wins, distinct-parent-finalization-wins and distinct-parent-child-wins all passed. The focused lifecycle/Coordinator/feedback/decision regressions, typecheck, compile, diagnostics and diff check also passed, so P6-WO1-R1 is closed and WO#1 + Repair WO#2 are accepted implementation truth. No new workflow journal or Project→Mission registry is introduced.

### Phase 6 WO#3 live explicit Worker transport + replacement continuity — ACCEPTED after Repair WO#3A

`MissionCoordinatorLiveDriver` is a stateless trusted-host transport seam above the accepted semantic `MissionCoordinatorService`; it does not change that service into a Worker owner. The host supplies every target `managedSessionId` explicitly. The driver never registers or creates sessions, lists/ranks Workers, selects providers/models, persists a command queue, acknowledges delivery, infers planning, or exposes Human Confirmation/Commit authority. A Coordinator Worker turn is rendered by `buildMissionCoordinatorWorkerInput()` from the exact Project/root/Coordination-Mission identity, one Cognition-authored semantic command, a fresh bounded `inspectManagedScope()` view and an optional same-Mission Context Handoff. Exactly one host-requested semantic capability is exposed for that turn, its schema pins the authored arguments, and the live driver exact-validates capability kind plus arguments again before invoking the admitted operation.

**Phase 11 live-provider refinement after P11-WO1-R17:** “pins the authored arguments” is an authority requirement, not a requirement that a text-mediated AI provider must re-transcribe the full Cognition-authored semantic payload. The trusted host must retain the original exact semantic command and its arguments as the only executable authority for the turn. If a provider transport cannot natively round-trip the exact structured arguments without renderer/model rewriting, the provider-visible capability must instead be an invocation-only surface bound to that one exact host command: either argumentless or carrying only an opaque, exact-turn, non-reusable invocation reference. A provider call may select/invoke the one admitted operation, but provider-authored semantic arguments can never replace, normalize or reinterpret the host command. The host executes the already-bound original command only after validating exact capability/turn/invocation authority. Wrong capability, wrong turn/reference, non-host-requested dispatch, replay and a second semantic operation remain fail-closed. This strengthens rather than weakens the existing mutation rule: whitespace, Markdown/list normalization or “semantic equivalence” must never convert provider-mutated command text into Cognition authority.

For an **argumentless** invocation surface, “empty object” means an exact admitted data shape, not merely an object whose enumerable string keys serialize like `{}`. The provider transport/parser must not permit dotted-path traversal through prototype-bearing meta-properties such as `__proto__`, `constructor` or `prototype`, and provider text must never be able to mutate an invocation object's prototype chain. The trusted-host admission check must reject any non-object/null/array shape and any invocation carrying own string/symbol/non-enumerable data beyond the exact empty envelope; inherited provider state must not be treated as equivalent to an exact empty invocation. Validation itself must not grant authority by normalizing or semantically interpreting provider data.
Repair WO#1Q candidate #3 establishes the production provenance needed to make that rule concrete. The fixed WebMCP path returns page values through Playwright `page.evaluate` by value; Playwright reconstructs serialized objects in the host Realm as fresh plain objects and skips a serialized `__proto__` key. The accepted Coordinator invocation envelope is therefore **exact host-realm plain empty object only**: non-null/non-array object, zero `Reflect.ownKeys`, and `Object.getPrototypeOf(value) === host Object.prototype`. Raw foreign-Realm objects, descriptor-shape replicas, mutated/custom inherited prototypes and null-prototype objects are not admitted. This contract is intentionally tied to the current by-value production boundary; a future transport that bypasses host reconstruction requires fresh architecture evidence before any Realm-neutral expansion.
The original WO#3 implementation proved the live Worker/replacement/UNKNOWN seam but left Work Order/fact/feedback/Decision transport callable directly by the host. Repair WO#3A closes that gap without changing ownership. `MissionCoordinatorSemanticCommand` now includes `deliverExplicitMissionInput`, `deliverMissionExchange`, `deliverFeedbackContinuation`, and `deliverCommittedDecision` in addition to inspect/ensure/problem-route. Each transport operation carries exact Project/root/Coordination-Mission identity, target/session/input identity and operation-specific Cognition-authored arguments. Transport shapes are exact-key checked, must bind the current Coordination Mission, and unsupported runtime kinds fail closed before the Coordinator provider send. Worker substitution of an operation or mutation of exact arguments fails before target send or semantic mutation.

The four target-delivery helpers are ECMAScript class-private and reachable only from the exact Coordinator command dispatcher. Target Worker streams are reduced to a bounded provider-neutral observation containing target/input identity, trustworthy terminal status, observed event classes and event count. Raw target `text_delta`, reasoning content and provider-event data are not returned as Coordinator capability result and are not persisted as delivery authority. A target stream that errors or ends without a trustworthy terminal observation produces no capability result; no outbox, queue, delivery ledger or automatic resend is introduced. Problem transport remains inert until a separate explicit `routePracticeProblem` command; feedback continuation reuses the Phase 4 owner/renderer; Decision transport admits only already-Committed affected authority through Phase 5 owners.

Worker replacement does not replace the Coordinator Mission. After durable owners are flushed, a fresh `WorkerSessionManager`, fresh Coordinator service/driver objects and an explicitly selected replacement Worker B bind to the same deterministic Coordination Mission `taskId`. Reconstruction uses replayed Project/Task/collaboration facts, a fresh bounded managed-scope inspection and optional same-Mission Context Handoff with Worker-history projection disabled. The repaired E2E proves Worker B itself executes a fresh `deliverFeedbackContinuation` transport command; old provider transcript/model/session identity and target raw-output sentinels are absent from reconstruction. UNKNOWN target transport creates no durable acknowledgement and restart performs zero automatic sends.

Phase 6 Cognition directly inspected the repaired command/driver/test path and independently reran the required live Coordinator, Coordinator foundation, WorkerSession, feedback, Decision, finalization and project-mission gates plus typecheck, compile, diagnostics and diff check. All passed; **P6-WO3-R1 is closed and WO#3 + Repair WO#3A are accepted.** The remaining Phase 6 implementation boundary is explicit completion plus lifecycle death. Cognition owns the semantic decision that the managed work is complete; the Coordinator may only execute an exact completion instruction and mechanical readiness checks. Because `MissionFinalizationService` waits for active send leases, the active Coordinator Worker must finish its final turn before any host-side finalization of that Coordinator Mission is attempted.

### Phase 6 WO#4 explicit completion + post-turn Coordinator death + Repair WO#4A — ACCEPTED / INDEPENDENTLY VERIFIED

WO#4 keeps semantic completion authority outside the Coordinator. `completeManagedScope` is an exact Cognition-authored command carrying only the Project/root/Coordination-Mission identity plus a bounded completion operation key. During the Coordinator Worker capability call, `MissionCoordinatorCompletionService.preflight()` performs mechanical readiness only: active/non-archived descendants, unfinished `depends_on` targets, unresolved durable blocking Problems, running Task work, other running WorkerSession sends, and incoherent existing finalization/Handoff state all block. The current Coordinator send lease is the sole intentional live-session exception. Goal text and Mission `completionCriteria` are never read as completion evidence, so free-text prose cannot override durable blockers.

The completion capability itself cannot finalize anything. `MissionCoordinatorLiveDriver` submits only the bounded readiness result back into the admitted Coordinator turn and waits for a trustworthy `terminal: completed`. `WorkerSessionManager` releases that turn's provider-native send lease before yielding the terminal event; only then may the host path call `finalizeAfterCompletedTurn()`. The post-turn path installs root + Coordinator `TaskRuntime.withMissionFinalizationStabilization()` admission fences, freshly re-evaluates readiness, finalizes/archives the Coordinator child through the existing `MissionFinalizationService`, re-evaluates readiness again, and then finalizes/archives the managed root. This correctly preserves provider-barrier → Task-lane ordering and linearizes new child admission: a child durable before the root fence is visible as a blocker, while a later child is rejected by the existing finalization fence.

Coordinator-first/root-second is also the crash-recovery order. If interruption happens after the Coordinator archive but before root finalization, that durable child-terminal/root-active state is sufficient recovery truth; no pending-action journal, scheduler, workflow queue or outbox is added. `recoverPartialFinalization()` is explicitly restricted to a pair that already has durable partial finalization state and therefore cannot bypass the initial live Coordinator completion turn for an entirely active pair. Existing Phase 2 finalization remains the sole owner of required final Handoff construction, durable Worker retirement, provider-native retirement and archive; retry/restart is idempotent against those durable facts. The focused WO#4 smoke correctly proves in-turn non-death, UNKNOWN/error non-death, ordinary mechanical blocker enforcement, child-admission race rejection, valid final Handoffs, post-turn Worker retirement, durable Project usability and deterministic partial-finalization recovery.

Phase 6 Cognition found a lifecycle-critical gap in the original WO#4 final readiness linearization. `TaskRuntime.withMissionFinalizationStabilization()` closed Task child admission, and `TaskRuntime.finalizeMissionStrict()` independently rechecked running Task work, but `MissionCollaborationStore.recordExchange()` / `recordRelation()` used an independent collaboration operation lane. A deterministic Cognition probe could therefore durably commit a valid blocking `Problem` **after the completion service's last readiness read but immediately before the root finalizer call**, while the root still reached `archived`.

Repair WO#4A keeps each owner intact and exposes only `MissionCollaborationStore.withMutationStabilization()`, a narrow non-reentrant critical section implemented by the store's existing `operationChain`. `recordExchange()` and `recordRelation()` already use that exact lane, so a collaboration write that wins first is fully drained before completion enters the callback, while a write that arrives after completion wins cannot reach validation/commit until the callback exits. `MissionCoordinatorCompletionService.withCompletionFences()` now installs the existing root/Coordinator TaskRuntime finalization fences and then enters this collaboration mutation gate for the complete post-turn readiness → Coordinator finalization → fresh root readiness → root finalization sequence. The TaskRuntime calls used to install those fences release their task-exclusive lanes before the collaboration gate is awaited; `MissionFinalizationService` therefore retains its existing provider-barrier → Task-lane ordering inside the gate. No collaboration ownership moved into TaskRuntime and no Project→Mission registry, durable completion transaction, pending-action journal, scheduler, outbox or workflow queue was added.

The repaired focused smoke deterministically proves both orderings. An already in-flight blocking-Problem write is paused while it owns the collaboration operation lane; completion reaches post-turn finalization, waits behind that write, then observes the durable unresolved Problem and performs no death. In the opposite ordering, completion reaches the exact former Cognition race point after final root readiness and before real root mutation; late valid blocking `Problem` and late `depends_on` writes cannot even enter collaboration commit, remain excluded while the root archives inside the same gate, and are admitted only afterward as historical facts. Partial-finalization recovery uses the identical gate: an in-flight blocker wins, recovery drains it and leaves the root active; after a durable Answer + `answers` resolution, retry converges through the existing finalizer. The original WO#4 non-death/Handoff/Project-survival/crash-recovery proofs remain in the same smoke.

Phase 6 Cognition independently inspected the repair rather than accepting the Practice report by assertion. The new primitive is exactly the collaboration store's pre-existing non-reentrant `operationChain`; completion/recovery use it only around collaboration reads plus external lifecycle owners and never re-enter `recordExchange()` / `recordRelation()`. Cognition reran the complete required WO#4A/upstream gate set, typecheck, compile, diagnostics and diff check, all green. It also ran a separate temporary race probe at the original defect point: a valid external blocking Problem started after final root readiness remained non-durable before root mutation and while the completion boundary was held, root archived, and the Problem became durable only after the boundary released. **P6-WO4-R1 is closed; WO#4 + Repair WO#4A are accepted.** Phase 6 implementation exit criteria are ready for fresh Independent Verification; this acceptance does not itself close Phase 6 or authorize Phase 7.

Fresh Phase 6 Independent Verification subsequently returned terminal `RESULT: PASS`, `STATE: VERIFICATION_COMPLETE`, with no blockers. A disposable verifier independently re-read production source and re-falsified the complete Phase 6 boundary, including Repair WO#2 Mission-admission ordering, Worker-invoked transport/raw-output/UNKNOWN/replacement semantics, `WorkerSessionManager` terminal-before-outward-yield send-lease release, exact post-turn completion/death, and both P6-WO4-R1 collaboration ordering directions plus partial recovery. It dynamically ran all 39 current `test-shuncode-*` suites and the static/build/diagnostic/diff gates successfully. Phase 6 Cognition reconciled that verdict and records **Phase 6 CLOSED / COMPLETE (2026-09-15)**. Cross-Phase authority now returns to Project-level Cognition; this architecture closure does not itself authorize Phase 7.

## 9. Mission lifecycle and AI death

The product law is:

> **AI 因使命而生，使命完成即死亡。**

Logical lifecycle:

```text
Mission created
→ Worker assigned
→ Work
→ Result / Handoff finalized
→ Mission completed
→ owned WorkerSessions detached/disposed/retired
→ Mission archived
```

The provider may physically retain a web conversation, but Nimora must no longer treat a retired mission worker as an active worker for future unrelated missions.

A WorkerSession failure does not equal Mission death. A replacement worker may continue the same Mission from bounded state/handoff.

Coordinator workers obey exactly the same lifecycle rule.

Current code enforces this sequence with `TaskMissionFinalized → old-Mission TaskWorkerRetired → provider-native live-wrapper retirement → TaskMissionArchived`. Before deriving the identity set, TaskRuntime installs a Mission-level admission fence under its task-exclusive lane; it then releases that lock before Manager provider barriers are acquired. This closes late-attach identities without reversing lock order. If a send already won a provider barrier, its active-send lease is observed; the finalizer releases barriers, waits for cleanup, then reacquires/revalidates before progressing. While waiting, only a host result bound to an exact pending call on that exact still-active send lease may cross the temporary finalization fence; it still fails on durable provider-native death and cannot authorize a new send/create/attach/rebind/resume. `TaskMissionFinalized` is itself a durable death fact for every provider identity in the Mission's durable history; `TaskWorkerRetired` preserves per-ref lifecycle bookkeeping. Finalization policy is immutable once written, and any final Handoff must resolve to exactly one report whose Mission/Project ownership, event-level and artifact-level source Task event id/count, and SHA-256 of actual content all match the exact pre-finalization revision. Replay also requires Mission configuration before accepting finalization, so forged out-of-order finalization cannot create terminal freeze. Finalized/archived working facts are frozen against late live writes and replay events. Physical provider cleanup is deliberately weaker than logical death: provider disposal may fail, but Nimora removes routing and rejects new create/send/resume/rebind/host-result continuation for that native identity. After restart the same durable authority is reconstructed solely from Task journal replay, not transcript inspection or Manager memory.

Conversely, ordinary Worker failure/disposal initially produces detach semantics only. It does not write Mission finalization, so another Worker may continue the same Mission from Task state / bounded handoff. At eventual Mission finalization, the historical detached ref also receives `TaskWorkerRetired`; this closes the loophole where a crashed provider conversation could otherwise be resurrected under a later Mission.

## 10. Project state vs Mission state

Project state should contain only durable cross-mission knowledge:

```text
Project
├─ goal / identity
├─ current state
├─ architecture / principles / constraints
├─ committed decisions
├─ verified facts / evidence refs
├─ artifacts
├─ open project problems
├─ mission graph/history
└─ handoffs
```

That diagram is the target Project domain, not the Phase 1 persistence payload. Phase 1 deliberately starts smaller: `ProjectStore` persists Project identity plus optional title/goal/workspace only. Later Project knowledge must be introduced through explicit contracts/events rather than silently expanding `ProjectCreated` or duplicating Task-owned Mission membership.

Mission state contains local working state:

```text
Mission
├─ goal / completion criteria
├─ plane / type
├─ parent/root/project links
├─ current context / assumptions
├─ worker sessions
├─ local problems/findings
├─ executions / artifacts
└─ final handoff
```

Phase 1 introduced only `projectId`, `rootMissionId`, optional `parentMissionId`, `plane`, `missionType`, and bounded `completionCriteria`. Phase 2 adds `missionFinalization` plus final-Handoff/retirement events to the **same** Task snapshot/journal. Existing Task context, Worker refs, executions, artifacts, todos/progress and grants remain owned by `TaskRuntime`; ProjectStore still does not mirror Mission membership or own Worker lifecycle.

Do not promote every temporary thought into Project state.

## 11. Web AI orchestration

WebMCP already solves the transport problem:

```text
Nimora
→ WebWorkerAdapter
→ WebMCP Core / Site Adapter
→ webpage AI
→ result/capability event
→ Nimora
```

Mission orchestration sits above it:

```text
Coordinator Worker
→ Mission service
→ WorkerSessionManager
→ WebWorkerAdapter
→ WebMCP
→ ChatGPT / Claude / Gemini / DeepSeek / ...
```

The coordinator should use semantic operations such as ensure an explicitly specified Mission, bind an explicitly selected Worker and send bounded Mission input. Those operations execute Cognition/host instructions; they do not grant the Coordinator Mission-planning authority. It must not know textarea selectors or site DOM details.

For browser-backed provider conversation observation, full/unchanged/delta snapshots must converge into one coherent chronological occurrence state before admission logic runs. Ordered role+occurrence identity is authoritative; role-specific message arrays and text arrays are derived projections, not independent stores. A delta for an existing role+occurrence updates that occurrence in place, while a genuinely new role+occurrence appends once. Fixed read-only provider observations may reconcile browser identity/ref churn only from bounded structural lineage evidence; they must not infer identity from text. Exact provider-user admission remains exact logical text equality after only explicitly proven browser-representation reconciliation; broad whitespace, Unicode, prefix, contains, fuzzy or semantic normalization remains forbidden.

## 12. Context rules

Context inheritance is selective:

```text
Project state
+ Mission goal
+ relevant committed decisions
+ relevant findings/answers
+ relevant artifacts/evidence
+ bounded handoff
+ mission-specific skills/capabilities
```

Explicitly reject:

- copying every old transcript;
- giving every worker every tool schema;
- feeding every mission every Project event;
- using a permanent coordinator conversation as project memory.

## 13. Ownership boundaries

### Nimora Project/Mission layer owns

- Project state;
- Mission graph and lifecycle;
- typed mission exchanges;
- mission completion/retirement semantics;
- cognition/practice/coordination semantics;
- deliberation commit semantics;
- product-specific orchestration strategy.

### Existing Task Runtime remains responsible for

- durable work state/events during incremental implementation;
- worker bindings;
- executions/delivery state;
- progress/artifacts/grants;
- bounded context/handoff substrate.

### WorkerSessionManager owns

- active worker session lifecycle/router semantics;
- adapter session handles;
- send/interrupt/health/dispose.

It does not become project memory or mission strategy.

### Bridge / Gateway / WebMCP own

- MCP exposure / external transports;
- browser/web communication and site adaptation;
- connection/security boundaries.

They are not the project brain.

### Code-OSS Core owns

Generic IDE/Workbench/Sessions/AgentHost substrate. New Mission product logic stays out of Core unless a narrow generic hook is demonstrably necessary.

## 14. Product UI direction

Reuse native Work Sessions rather than introducing a parallel state-owning Webview.

Long-term presentation:

```text
Project
└─ Root Mission
   ├─ 文 · Research        ✓
   ├─ 理 · Implementation  ●
   │   └─ Problem #12 → 文 · Investigation
   ├─ 文 · Deliberation    waiting human
   └─ 理 · Verification    ○
```

Worker/provider details should be secondary/expandable. Users should primarily see the project, missions, problems, decisions and outcomes.

## 15. Principled Mission parallelism

Nimora's safe parallelism unit is the **Mission**, not an arbitrary additional Worker/chat. Project-/Phase-level Cognition owns semantic decomposition: work should split only when each Mission has a bounded historical purpose/responsibility and explicit dependency meaning. Different independently-ready Missions may run concurrently; one Mission still admits at most one current Worker. Multiple implementers must not concurrently mutate the same responsibility domain until separately designed merge semantics exist.

`MissionParallelReadinessService` is the current stateless/reconstructible derivation seam. It reads canonical `ProjectStore`, `TaskRuntime`, `MissionCollaborationStore` and `WorkerSessionManager` truth to classify Cognition/Practice Missions as terminal, running, blocked, ready-with-Worker or ready-without-Worker. Explicit unfinished `depends_on`, unresolved blocking Problems, Task waiting/inconsistent lifecycle status and ambiguous durable/live Worker ownership fail closed. It may derive deterministic dependency waves and detect cycles for the requested parallelization scope, but these are disposable advice: `depends_on` remains a Collaboration fact and no workflow DAG/queue becomes durable authority.

`MissionParallelAssignmentService` is the corresponding explicit fan-out seam. Given exact caller/Cognition-authored `WorkerAssignmentRequest`s, it freshly admits only `ready-unassigned` Missions and invokes the existing per-Mission `MissionWorkerAssignmentService` lanes concurrently. It creates no Mission, performs no Work Order send, owns no retry/fallback, and persists no scheduling state. Assignment ambiguity remains fail-closed and one current Worker per Mission remains authoritative.

The detailed contract, Phase 11 isolation boundary and verification evidence are recorded in [`MISSION_PARALLEL_ORCHESTRATION.md`](MISSION_PARALLEL_ORCHESTRATION.md).

## 16. Core invariants

1. Project continuity never depends on one permanent AI conversation.
2. Mission identity belongs to work, not model/provider.
3. Mission completion is explicit and testable.
4. Completed mission workers are logically retired.
5. Practice can challenge cognition with evidence.
6. Plans are revisable hypotheses.
7. Human discussion is non-binding until commit.
8. Mission collaboration exchanges bounded structured state, not transcript dumps.
9. Web/API/local/AgentHost remain replaceable Worker adapters.
10. Bridge/Gateway remain transport boundaries, not business-state owners.
11. Project-/Phase-level Cognition owns Mission planning and semantic completion judgment; Coordinator is a disposable bridge/executor, not a second Cognition brain.
12. Durable Project birth is gated by an authorized bounded Formation Result; raw chat, provider/session identity and pre-Project deliberation transcript are not Project truth.
13. Parallelism is derived across independently-ready Missions; it does not grant multiple current implementer Workers to one Mission or create a second durable scheduler/workflow truth.
14. Cognition may finalize only explicitly eligible child Missions. Runtime must materialize a bounded `finalizableMissionIds` allow-set that excludes the managed root and Coordinator; Project completion remains a separate Cognition-owned completion candidate plus canonical completion gate.
15. A Coordinator host-bound command may mechanically terminate after its one exact host capability result is confirmed delivered. Provider follow-up prose after that transport result has no additional semantic authority and must not be required for Coordinator convergence.
16. Provider conversation URL evolution is Worker lineage, not permission to substitute conversations. For DeepSeek, an initial same-page/session/origin transition from the new-chat URL to one canonical `/a/chat/s/<id>` may advance runtime authority; later conversation substitution remains fail-closed.
17. Provider write pacing is a host transport concern across pages. Rate limiting may delay a future independently-authorized write, but must never silently retry a failed/UNKNOWN Provider mutation or create replay authority.
18. Human-consent/replacement workflows must acquire their single-flight guard **before** opening the first consent window and hold it through durable completion/cancel/error, so duplicate UI/command invocations cannot wait concurrently and race canonical state.
