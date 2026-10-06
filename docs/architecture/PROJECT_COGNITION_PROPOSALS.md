# Project Cognition Proposals

> This document stores Project-level cognition that future Phase Cognition Missions should read before architecture work. Items remain non-binding until their own status reaches `Committed`; committed items are also reflected into the relevant architecture/ADR truth rather than relying on this file alone.
>
> Status semantics follow `Draft -> Proposed -> Human Confirmed -> Committed`. Only `Committed` decisions may mutate durable Project truth or override accepted architecture.

## 2026-09-15 — Cognition roles, strategic deliberation and verification independence

### Context

Phase 3 independently validated the persistent Phase Cognition / persistent Phase Practice operating pattern. Phase 4 subsequently implemented, Cognition-reconciled and independently verified the deterministic Cognition -> Practice -> Reality -> Problem/Evidence -> new Cognition -> Answer -> same-Practice continuation loop; Phase 4 is now CLOSED / COMPLETE.

The development process itself is now providing evidence about a possible future Nimora product shape: durable responsibility belongs to Missions and structured facts, while individual WorkerSessions remain replaceable resources.

The proposals below refine how strategic human deliberation may fit that model. They did **not** modify the Phase 4 plan or verification boundary. During Phase 5 Cognition, Proposals A/B/C were explicitly presented for bounded human deliberation and were Human Confirmed on 2026-09-15; Phase 5 Cognition then committed that structured result into repository architecture truth. This manual development-governance commit is not evidence that the Phase 5 product runtime commit API already exists.

## Proposal A — Phase Cognition is also the Phase strategic deliberation surface

**Status: Committed (Human Confirmed 2026-09-15).**

Candidate rule:

> Phase Cognition = Phase planning authority + Phase strategic deliberation surface.

Rationale:

- the persistent Phase Cognition Mission already owns the Phase goal, architecture, repository Reality, upstream invariants, current Phase Plan, Practice Result/Problem/Evidence integration and Work Order authority;
- limited human deliberation about a genuine Phase-level value/strategy tradeoff therefore has the right context in the existing Phase Cognition Mission;
- ordinary factual engineering questions remain autonomous and must not turn the human into a step-by-step project manager.

This rule does **not** mean that every human conversation changes the Phase Plan. Deliberation remains non-binding until explicit commit semantics say otherwise.

## Proposal B — Strategic deliberation need not always create a separate Mission

**Status: Committed (Human Confirmed 2026-09-15).**

Candidate rule:

> Strategic discussion may occur inside an existing Cognition Mission. Create a separate Deliberation/Cognition Mission only when the deliberation itself deserves an independent historical purpose, lifetime or deliverable.

This is a deliberate refinement of the earlier architecture wording `Human deliberation is a special cognition mission`. The Human Confirmed + Committed result is now reflected into `MISSION_WORK_ARCHITECTURE.md` and ADR 0003 rather than silently reinterpreting the old wording.

Mission-creation test for a separate deliberation Mission:

- the discussion needs substantial independent research;
- it persists beyond the bounded context of the current Cognition Mission;
- it spans multiple Phases or has its own completion criteria;
- it produces a durable deliverable whose history is independently useful.

A short contextual strategic discussion inside Phase Cognition should not create a new Mission merely because a human participated.

## Proposal C — Discussion is temporary cognition; durable governance uses compressed structure

**Status: Committed (Human Confirmed 2026-09-15).**

Candidate rule:

> Discussion may enrich current Cognition, but full deliberation transcripts are temporary/session-local. A compressed current understanding may guide ongoing Cognition. Only explicitly Committed structured decisions become durable Project truth.

A useful non-binding deliberation summary may contain:

```text
Question
Options considered
Current understanding
Rejected assumptions
Commit status
Impact
```

Rejected brainstorms and full transcripts should not be inherited as authoritative planning context. After Commit, impact analysis should route only the structured decision/change to affected Missions.

This proposal extends rather than replaces the existing rule that Draft discussion does not mutate Project state and full deliberation transcripts are not broadcast.

### Phase 5 bounded human confirmation record

**Decision date:** 2026-09-15.

**Human confirmation:** explicit confirmation of the Phase 5 Cognition recommendation: `A/B accepted; C accepted`.

**Committed structured meaning:**

- existing Project-/Phase-level Cognition is the normal surface for bounded strategic human deliberation when the question is already in that Cognition scope;
- a separate Deliberation/Cognition Mission is created only when the deliberation itself deserves independent historical identity, lifetime, research burden, completion criteria or durable deliverable;
- full deliberation transcripts remain temporary/session-local cognition rather than durable Project truth;
- bounded current understanding may guide ongoing Cognition, while only explicitly Committed structured decisions become durable authoritative Project truth;
- this decision does not make human participation mandatory for ordinary engineering and does not change the fresh independent verification requirement for Phase 5.

**Authority note:** this record is the historical repository-level architecture/governance commit performed by the then-authorized Phase 5 Cognition Mission after explicit human confirmation. The corresponding Phase 5 product Commit infrastructure was subsequently implemented, repaired after verifier finding P5-V1, and independently re-verified with terminal `RESULT: PASS` on 2026-09-15.

## Supporting cognition model — three scopes of Cognition

**Status: Draft explanatory model — not a request for three new runtime classes or hard-coded agent types.**

```text
Project-level Cognition / 总文
  cross-Phase and long-horizon product strategy

Phase-level Cognition / Phase 文
  Phase architecture, planning, Reality reconciliation,
  Work Orders, verification readiness, Phase strategic deliberation

Problem-specific Cognition / 专项文
  bounded research/analysis caused by a concrete Problem/Evidence set
```

Escalation should follow semantic scope, not model identity. A Problem-specific Cognition result escalates only when it reveals a genuine Phase- or Project-level strategic/value question.

## Verification independence — current rule and future hypothesis

### Current binding route

Phase 4's required fresh comprehensive Independent Verification has completed with `RESULT: PASS`. These proposals did not weaken or bypass that gate.

Phase 5 Human Commit semantics completed fresh independent falsification and closure after one initial verifier `FAIL`, repair and fresh re-verifier `PASS`. Phases 6–9 subsequently completed fresh independent falsification across Coordinator authority, Worker assignment, Mission-aware Context/Skill/Capability routing and Project/Mission presentation. Phase 10 Project formation then completed fresh independent verification only after its first verifier found the owner-level `P10-FIV-CONCURRENCY-001` race and a fresh re-verifier passed the repaired boundary. Phase 11 real provider/Worker integration plus autonomous workspace execution is now the next major boundary and must assume fresh independent falsification unless its Phase Cognition produces stronger evidence for another mechanism.

### Future hypothesis

**Status: Draft — not Proposed for commitment yet.**

Candidate long-term principle:

> Important trust boundaries require an epistemically independent falsification mechanism; that mechanism need not forever mean one fresh AI verifier Mission for every Phase or every low-risk change.

Possible future Verification Risk Gate:

- fresh independent verification required for durable ownership, replay, Mission lifecycle, security/safety boundaries, automatic decision authority, Human Commit semantics, Coordinator authority and Worker assignment;
- fresh verifier normally expected for major domain semantics and cross-Mission/autonomous orchestration;
- low-risk presentation/UI-only/local adapter changes may eventually be closable by Cognition audit plus strong automated regression evidence;
- property testing, fuzzing, model checking, schema/replay verification and CI invariants may carry part of the independent-falsification burden where they provide genuinely independent evidence.

Why this stays Draft: Phases 3–10 now provide repeated successful fresh-independent closure patterns, including verifier- or Cognition-discovered authority, replay, lifecycle, resource-routing, materialization, presentation and concurrency defects that were repaired before closure. That evidence supports the value of independent falsification for high-risk semantic boundaries rather than relaxing it. Phase 11 is itself such a boundary because it joins real external AI providers, executable workspace capabilities and autonomous user-visible orchestration, where a false provider/session/capability claim could directly mutate user work.

## Human role hypothesis

**Status: Draft synthesis.**

The emerging product direction is that the human participates primarily in Cognition when a question is genuinely strategic, value-laden or difficult to reverse. The human is neither the routine Mission manager nor absent from the system.

Ordinary engineering remains autonomous. Human silence is not approval. Human participation becomes authoritative only through the explicit deliberation/commit boundary.

## Proposal D — Project formation begins at a Project-level Cognition boundary

**Status: Committed (Human Confirmed 2026-09-17).**

Candidate rule:

> Every durable Project should be born from a Project-level Cognition / Formation boundary, but not every Project requires a long multi-turn human deliberation.

Current roadmap reality is weaker than this proposal. Phase 10 currently sketches `User intent -> create Project/root Mission -> temporary Coordinator -> initial Cognition -> optional human deliberation`. Current `ProjectStore.createProject()` likewise persists `ProjectCreated` directly from bounded `title / goal / workspace` input and has no formation/charter/commit stage.

The proposed refinement is:

```text
User intent
-> Project Formation Cognition
-> clarify/infer goal, boundaries, principles and autonomy expectations
-> Draft Project Charter / initial understanding
-> strategic deliberation only where ambiguity or value tradeoffs require it
-> explicit formation/commit boundary
-> durable Project + root Mission
-> later Phase/Coordinator work
```

The word `deliberation` must not imply mandatory ceremony. If the user's initial request already gives a sufficiently clear goal and delegates ordinary technical choices, Project Formation Cognition may be one bounded turn and need no additional questions. If the request contains strategic ambiguity, irreversible choices, permission boundaries or conflicting values, the same formation surface may enter a real human-AI deliberation before durable Project truth is committed.

This proposal is intentionally about **semantic project birth**, not about forcing a specific storage design now. Phase 10 should compare at least:

- pre-Project/session-local Formation Cognition followed by atomic Project creation/initial commit;
- a durable Project shell with an explicit `Draft/Formation` lifecycle before activation;
- another minimal design only if repository evidence shows the above are insufficient.

Do not add a `ProjectCandidate` runtime or new lifecycle merely to satisfy this proposal before Phase 5 commit semantics and Phase 6 coordination authority are proven.

Why this is plausible downstream: Phase 5 is already intended to provide the discussion -> commit boundary; Phase 6 is intended to provide disposable coordination authority; Phase 10 is already the automatic Project-formation phase. Those later capabilities provide a natural implementation point without changing the active Phase 5/6 scope prematurely.

### Deliberation Summary — how a Project should begin

**Question**

Should a Nimora Project be created first and only then enter Cognition/deliberation, or should the Project itself be born from Project-level Cognition?

**Options considered**

1. **Current Phase 10 sketch:** user intent -> immediately create Project/root Mission -> Coordinator/initial Cognition -> optional human deliberation.
2. **Pre-Project Formation Cognition:** user intent -> Project-level Cognition -> bounded Project Charter/initial understanding -> formation/commit boundary -> durable Project/root Mission.
3. **Durable formation shell:** create a durable Project shell in a non-active Formation/Draft state -> run Project-level Cognition/deliberation -> activate on commit.

**Current understanding**

- The existing roadmap already plans automatic Project formation, but it does not yet model Project birth as a Project-level Cognition boundary.
- A durable Project should represent an understood and intentionally formed project, not merely the raw arrival of one natural-language utterance.
- Project-level Cognition should therefore precede or semantically gate the first authoritative Project truth.
- This does **not** require a mandatory multi-turn meeting. A sufficiently clear user request may itself provide enough goal, values and delegation for a one-turn bounded formation step.
- Real human-AI strategic deliberation is required only when formation exposes consequential ambiguity: product values, autonomy/permission boundaries, irreversible choices, conflicting constraints or unclear strategic intent.
- The formation output should be a compressed Project Charter/current understanding rather than the entire discussion transcript.

**Rejected assumptions**

- Reject the assumption that `ProjectCreated` should automatically be the first semantic act merely because it is the current minimal persistence API.
- Reject the assumption that "Project-level human-AI deliberation" means every Project must ask the user a checklist of approval questions.
- Reject the assumption that Project Formation Cognition implies one permanent Project-level AI Worker; responsibility may persist while Workers remain replaceable.
- Reject choosing the final persistence shape now. Pre-Project cognition and a durable Formation shell both remain viable until Phase 5/6/10 evidence is available.

**Commit status**

`Human Confirmed -> Committed` on 2026-09-17 after Phase 10 Cognition completed the repository-grounded formation analysis and presented the exact semantic rule for bounded human deliberation.

**Human confirmation:** explicit user confirmation: `确认 Proposal D`.

**Committed structured meaning:**

- raw user intent alone is input evidence and does not itself create authoritative durable Project truth;
- every newly auto-formed durable Project is semantically gated by one bounded Project Formation Cognition step that produces the current Formation Result before Project birth;
- a sufficiently clear request may cross that formation boundary in the same bounded cognition step without a ceremonial second approval;
- genuine strategic/value/permission/autonomy/privacy/cost or similarly consequential ambiguity requires explicit human confirmation of the exact bounded Formation Result before Project birth;
- durable Project birth persists only the bounded authorized formation result/receipt needed for Project/root provenance and recovery, not the deliberation/provider transcript;
- Phase 10's repository-grounded technical decision is Candidate A: pre-Project/session-local Formation Cognition with no durable Draft Project shell by default;
- Project birth must remain recoverable/idempotent without turning provider/session/chat identity into Project identity, and later same-Project root work does not rerun Project formation.

**Authority note:** this is the repository-level architecture/governance Commit performed after explicit human confirmation. It applies the already-verified Phase 5 authority law to the pre-Project semantic boundary; it does not fabricate a product-runtime `ProjectProposalHumanConfirmed` event for a Project that does not yet exist, and it does not itself implement Phase 10 production code.

**Impact**

- No retroactive change to Phase 0-4 verified boundaries.
- No early Phase 5/6/10 implementation authorization.
- Phase 5 should provide reusable deliberation/commit semantics compatible with future Project Formation.
- Phase 6 should avoid assuming Coordinator creation is necessarily the first Project act.
- Phase 10 must revisit the ordering of Project Formation Cognition, Project creation, root Mission creation and Coordinator creation before implementation.

## Proposal E — Autonomous Mission-planning authority for Coordinator

**Status: Retracted before Human Confirmation — invalid framing, never Committed.**

Phase 6 Cognition initially framed a value question asking how much Mission planning/decomposition/finalization authority the disposable Coordinator AI should receive. Human discussion on 2026-09-15 exposed that this premise contradicted an already-established product/development principle rather than revealing a new unresolved value choice.

The corrected principle is:

> **Cognition decides what Mission work should exist and what it means; Coordinator is the bridge that reliably executes and transports those already-authorized semantic instructions/results.**

This is consistent with the Phase 3 operating evidence already recorded elsewhere in repository truth: the planning function persists in Project-/Phase-level Cognition, Practice reports Reality, and the bridge/Coordinator transports Work Orders, Results, Problems, Evidence and Handoffs without independently inventing decomposition.

Therefore Proposal E's former options are not awaiting Human Confirmation. They are preserved only as a historical Cognition error: all of them granted the Coordinator some degree of Mission-planning authority that belongs to Cognition. No Human Confirmation or Commit occurred, so retracting the proposal changes no committed Project decision.

### Corrected Phase 6 implication

- Project-level Cognition / 总文 owns cross-Phase understanding and creates/authorizes Phase Cognition Missions.
- Phase-level Cognition / Phase 文 owns in-Phase understanding, Mission decomposition, Work Orders, Reality reconciliation, verification readiness and semantic completion judgment.
- Problem-specific Cognition owns bounded investigation when explicitly created/routed for a Problem.
- Coordinator owns transport/execution of explicit semantic commands: ensure the Mission Cognition already specified, deliver bounded input/Work Orders, return Result/Problem/Evidence/Handoff to the owning Cognition scope, resume routing after Worker replacement, and invoke lifecycle operations only when explicitly instructed and mechanically admissible.
- Coordinator does not decide that a new Cognition/Practice/Verification Mission is needed, choose its purpose, reinterpret a Problem, decide semantic completion, or become a second planner/Project brain.
- Human-only Project Confirmation/Commit authority remains unchanged, and automatic Worker/provider/model selection remains Phase 7.

The Phase 6 Cognition plan must be revised against this boundary before Practice implementation.

## Downstream use

Phase 5 Cognition has explicitly evaluated and committed Proposals A/B/C. `deliberation` is Cognition semantics, not an always-separate Mission requirement; a separate Deliberation/Cognition Mission is created only when independent historical identity is warranted. Phase 5 implementation must preserve the committed transcript boundary and explicit-commit authority rule.

Phase 6 Cognition should consume the committed A/B/C semantics plus the independently verified Phase 5 product implementation when defining bridge execution around deliberation/Commit routing. Mission creation and strategic interpretation remain Cognition authority; Coordinator merely transports/executes an explicit instruction and must not turn every strategic question into a separate Mission merely because a human participates.

Phase 10 Cognition should explicitly evaluate Proposal D before fixing automatic Project formation. It must distinguish `Project Formation Cognition` from mandatory multi-turn approval and decide where the first durable Project truth begins.

No proposal or committed decision in this document retroactively changes the verified Phase 4 boundary or authorizes Phase 6 implementation without its own Project-level Cognition route. Phase 5 implementation authority comes from the active Phase 5 Cognition Mission Plan and Work Orders, not from this proposals document alone.

## Proposal F — Reliable autonomy, self-maintenance and controlled self-improvement

**Status: Committed (Human Confirmed 2026-09-18).**

### Question

As Nimora moves from verified Mission orchestration to long-running autonomous product use, how should it handle Worker stalls, Coordinator reliability, provider compatibility drift, its own runtime failures and self-improvement without turning Coordinator into a second Project brain or replacing the verified Project/Mission architecture?

### Human-confirmed direction

The human explicitly confirmed the following Project-level product direction:

```text
DeepSeek / browser login
= preserve the current ShunCode persistent-profile/session approach
= normal machine/application restart must not require routine re-login
= human intervention only when authentication really expires or requires OAuth/2FA/CAPTCHA/other security action

Coordinator Worker
= API-first by default for speed/stability/low token cost
= provider-neutral and replaceable
= Web Worker remains allowed when explicitly selected/needed
= Coordination Mission persists while its Worker may change

Self-improvement update authority
= low-risk bugfix may auto-update only after bounded implementation + independent verification + compatibility/recovery checks
= high-risk, behavior-changing, architecture/authority/security/privacy/data-loss-affecting changes require explicit human confirmation before merge/install/overwrite
= uncertain risk classification fails upward to the human-confirmed path
```

### Committed architecture meaning

1. **Reliable autonomy is additive, not a replacement runtime.** Existing Project/Mission/Cognition/Practice/Coordinator/Worker/Capability ownership remains authoritative. New reliability behavior should be built primarily by composing those verified abstractions. Only narrow runtime primitives may be added where deterministic liveness, session lifecycle, health/certification, recovery or rescue cannot truthfully be represented by prompts/Missions alone. No second Project brain, second Mission runtime or Coordinator planner is authorized.
2. **Coordinator remains a bridge/executor.** The default Coordinator Worker should prefer a stable API-backed route because coordination should use small bounded context, low latency and reliable availability rather than maximum model intelligence. This is a default resource preference, not Mission identity: an explicitly admissible Web or other Worker may replace it, and a failed Coordinator Worker does not end the Coordination Mission.
3. **Worker liveness/stall handling must be state-aware.** Silence alone is not resend authority. Reliability logic may observe progress/health and classify running/streaming/tool-wait/human-wait/terminal/suspected-stall/unreachable/UNKNOWN states. A new continuation input is allowed only after the previous turn/side-effect boundary is known settled and the owning Cognition/Coordinator route authorizes future input. `UNKNOWN != retry authority` remains binding.
4. **Conversation lifecycle is runtime policy, not prompt etiquette.** Creation, exact-Mission reuse, replacement, retirement and provider-side cleanup/deletion are deterministic lifecycle concerns. Prompts may tell a Worker its role, but they do not own whether a conversation may be reused/deleted or whether a side effect may be retried.
5. **Provider compatibility/certification becomes a first-class reliability function.** Nimora should be able to run a bounded audit over configured Web/API providers and classify at least: ready, authentication-required, provider outage/rate limit, local bridge/runtime unavailable, and adapter/protocol regression. Only a proven adapter/system regression should automatically create/route a repair Project/Mission; an expired login or external provider outage must not be misdiagnosed as source-code repair work.
6. **Browser authentication should be persistent where the provider permits it.** The current ShunCode/WebMCP substrate already includes persistent browser-profile/session mechanisms; future DeepSeek/browser integration should preserve rather than discard that behavior. Provider security challenges remain explicit human-action boundaries and credentials/transcripts must not become Project memory.
7. **Self-maintenance is a Project, not one immortal Mission.** A long-lived `Nimora Self-Maintenance` Project may spawn ordinary bounded Cognition/Practice/Verification Missions for concrete regressions (provider adapter, Bridge, runtime, packaging, etc.); each Mission still finishes. If the normal Project/Mission control plane itself cannot operate, a deliberately minimal Rescue/Safe Mode may use local/API repair primitives to restore the normal runtime. Rescue is not a second semantic orchestration system.
8. **Self-improvement uses the same architecture.** A `Nimora Self-Improvement` Project may research opportunities, work in an isolated branch/worktree, implement, run verification/certification and produce an upgrade candidate. Low-risk bugfixes may automatically progress through merge/install only when a strict risk gate, independent verification and rollback/recovery requirements all pass. Any high-risk or behavior/architecture/authority/security/privacy/destructive change requires exact human confirmation before becoming the installed/official version.
9. **Human-AI deliberation belongs to the Cognition scope that owns the question.** Ordinary Mission questions belong to the owning Mission Cognition; Phase-wide questions belong to Phase Cognition; cross-Phase/product-direction questions belong to Project-level Cognition / 总文. 总文 should not routinely participate in lower-scope deliberation, but it retains Project-level deliberation authority.
10. **Prompt hierarchy is bounded and reconstructible.** Stable role capsules may exist for Project-level Cognition, Cognition, Practice and Coordinator. A parent Cognition authors the child Mission brief/Work Order; current Project/Mission truth and Handoffs are materialized separately; provider transcripts are not the memory mechanism. The intended shape is `stable role capsule + parent brief + materialized current truth + current Work Order`.

### Risk gate for automatic self-update

`low-risk bugfix` is intentionally narrow. Automatic install/merge is only eligible when all are true:

- restores an already-Committed/verified behavior rather than changing product semantics;
- does not change Project/Mission ownership, Human Commit rules, Coordinator authority, Worker assignment authority, capability/security policy, privacy/data retention or irreversible user-facing behavior;
- does not require credential/permission expansion or destructive migration;
- passes fresh independent verification and provider/compatibility certification appropriate to the affected surface;
- has an explicit rollback/recovery path and no unresolved UNKNOWN side effect;
- the risk classifier is itself deterministic/bounded enough to explain why the change is low risk.

If any condition is false or uncertain, treat the update as human-confirmation-required.

### Non-goals / rejected shapes

- no permanent all-powerful Coordinator AI;
- no "30 seconds of silence => send continue" blind watchdog;
- no prompt-only session deletion/retry correctness;
- no immortal Maintenance Mission;
- no automatic source repair for ordinary login expiry/provider outage;
- no self-improvement that directly overwrites the running product merely because an AI says the candidate is better;
- no requirement that every provider remain continuously logged in when the provider itself expires/revokes authentication;
- no new persistence owner merely to mirror Worker health/provider state that is reconstructible from current owners and live observation.

### Impact / downstream routing

This Commit does not self-authorize a new implementation Phase and does not change the active Phase 11 Work Order. Active Phase 11 Cognition should consume the relevant provider/session/Coordinator implications when reconciling its current work. After the real-provider/user-entry boundary is closed, Project-level Cognition should decide whether reliability/certification/self-maintenance warrants a dedicated successor Phase or can be introduced as bounded downstream Missions. Self-improvement remains later product scope unless an earlier concrete blocker requires one of its narrow primitives.

## Proposal G — Hierarchical Plan/Report authority and Worker succession

**Status: Committed (Human Confirmed 2026-09-20).**

The human confirmed two additional Project-level operating laws for 总文 / 文 / 理.

First, semantic authority is directional:

> **计划向下，报告向上。**

`总文 → 文` supplies the Project/Phase plan. `文 → 理` supplies the bounded Work Order/plan. In the reverse direction, `理 → 文` and `文 → 总文` may return only bounded Reports (including Result, Problem, Evidence, Finding, Handoff, capacity/liveness state and recommendations). A lower scope has no authority to command its parent, require a particular parent action, force acceptance, create its own successor authority or turn a recommendation into a Plan. Upward recommendations remain non-authoritative until the receiving Cognition independently adopts them into a downward Plan/Work Order. Coordinator only transports these already-authorized objects and has no semantic rank over 总文 / 文 / 理.

Second, provider context/conversation exhaustion is Worker replacement, not Mission replacement. A Practice Worker that reaches its context limit returns a bounded Practice Handoff Report to its owning 文; that 文 authorizes a replacement Worker on the same Practice Mission. A 文 Worker that reaches its context limit returns a bounded Cognition Handoff Report to 总文; 总文 authorizes a replacement 文 Worker on the same Cognition Mission/responsibility, while healthy Practice Workers continue uninterrupted and subsequently report to the replacement 文. If the Project-level 总文 Worker reaches its own context limit, it first persists bounded Project truth and emits a Project Cognition Handoff Report directly to a replacement 总文 Worker that assumes the same Project-level Cognition responsibility.

Succession does not inherit retry authority. Any unresolved `UNKNOWN`, side-effect uncertainty or delivery ambiguity must be reconciled before another operation is issued. Full provider transcripts are not Project memory and are not required for succession. A Handoff is an upward Report; it does not itself become the successor's next Plan.

This Commit refines lifecycle/routing semantics over the existing `Project persists / Missions finish / Workers are disposable` architecture. It does not authorize a second hierarchy runtime, a new Project brain, or any expansion of the active Phase 11 WO#1 scope.
