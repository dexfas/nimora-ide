# ADR 0003: Project and Mission organize Cognition-Practice work

- Status: Accepted as next product-domain direction
- Date: 2026-09-13
- Amended: 2026-09-17 — Phase 5 human-confirmed deliberation surface/transcript semantics; Phase 6 Coordinator bridge/planning-authority clarification; Phase 10 Human Confirmed Project-formation/birth boundary

## Context

ADR 0002 correctly separated Task, Worker and Capability. The implementation now has durable Task journals, WorkerSessionManager, API/AgentHost/Web worker adapters, bounded context handoff, capability execution projection and native Work Sessions.

That foundation answers how work state, AI resources and executable capabilities remain independent. It does not yet define how a long-lived project should organize a changing sequence of research, human discussion, implementation and reality-driven replanning.

The product direction additionally requires:

- each AI conversation to have a bounded historical mission rather than becoming a permanent project brain;
- research/thinking and practical execution to cooperate without a one-way planner→executor lock;
- practical work to be able to raise new problems and send them back into cognition;
- optional human deliberation whose discussion is non-binding until explicitly committed;
- coordinators themselves to be disposable AI workers rather than permanent agents;
- web/API/local/AgentHost workers to remain interchangeable resources.

## Decision

Introduce two product-domain concepts above the existing Task/Worker/Capability foundation:

1. **Project** — the long-lived owner of durable project state, principles, committed decisions, evidence, artifacts, mission history and handoffs.
2. **Mission** — a bounded historical purpose with explicit completion criteria. A Mission is executed by one or more replaceable WorkerSessions and ends when that purpose is complete.

For incremental compatibility, the existing `TaskRuntime` remains the runtime/state substrate. Do not mass-rename Task to Mission. Mission semantics are added above/alongside Task through explicit metadata/contracts and can continue to use Task journals internally until there is evidence that a rename or split is valuable.

Phase 1 realizes that decision narrowly: a small append-only `ProjectStore` persists only Project identity/metadata via `ProjectCreated`, while existing Task journals gain the additive `TaskMissionConfigured` event and optional `TaskSnapshot.mission`. Mission identity is the Task `taskId`. `TaskSnapshot.mission.projectId` is the sole durable Project↔Mission membership link; Project state does not mirror `missionIds`. This preserves old Task replay without startup migration and avoids any cross-store membership transaction.

Phase 1 intentionally stopped before lifecycle semantics. Phase 2 now realizes the first lifecycle slice on the same Task journal: strict Mission finalization/archive, terminal working-state freeze, durable provider-native death derived from finalized Mission/retired Worker history, disposable Worker cleanup, durable adoption of pre-Mission Worker refs, and a revision/digest-bound final Handoff. This remains an extension of TaskRuntime/WorkerSessionManager rather than a second Mission runtime; coordinator state, Mission Graph and Project→Mission tree UI are still later work.

Phase 5 extends the same `ProjectStore` owner rather than introducing another Project runtime. Draft deliberation remains session-local; bounded immutable Proposal, explicit Human Confirmation bound to the exact Proposal content digest, minimal Proposal replacement, and authoritative Committed Decision/Change history live in the existing Project journal. Deterministic impact analysis remains stateless above `ProjectStore + TaskRuntime`, so Project→Mission membership is still derived only from `TaskSnapshot.mission.projectId`. Worker delivery remains an explicit live `WorkerSessionManager` action and is not Project authority or a durable delivery acknowledgement.

Phase 10 commits the Project-birth refinement after explicit human confirmation. Raw user intent alone is not authoritative durable Project truth. Newly auto-formed Projects are semantically gated by bounded pre-Project Formation Cognition: a clear request may be formed in one bounded step without mandatory ceremony, while consequential strategic/value/permission/autonomy/privacy/cost ambiguity requires explicit human confirmation of the exact Formation Result. Only the bounded authorized Formation Result/receipt crosses into durable Project truth; provider/deliberation transcripts remain outside Project memory. The chosen persistence direction is session-local pre-Project cognition with no durable Draft Project shell by default. Project birth remains ProjectStore authority, realized root Mission membership remains TaskRuntime authority, and Coordinator/Worker/provider identities gain no formation/planning authority from this decision.

Mission work is classified by plane:

- **coordination** — temporary semantic bridge/execution for a root mission and its child missions; Mission planning remains Cognition authority;
- **cognition** — research, analysis, planning, architecture and human-AI deliberation;
- **practice** — implementation, operation, debugging, testing, deployment and verification.

The core loop is not planner→executor. It is:

```text
Cognition
  → current best understanding
  → Practice
  → real-world evidence / problem
  → Cognition
  → updated understanding
  → Practice
```

Plans are hypotheses, not immutable truth. Reality may invalidate them.

Mission collaboration is represented through bounded structured exchanges such as Finding, Problem, Evidence, Answer and Handoff. Project-scoped Decision/Change authority is owned separately by `ProjectStore`; it is not silently relabeled as a Mission `Finding`, `Answer` or `Handoff`. Full worker transcripts are not broadcast between missions.

Human-AI deliberation is **Cognition work**, but it does not always require a separate historical Mission. When a strategic question already belongs to an active Project-/Phase-level Cognition Mission, bounded human deliberation may occur inside that existing Cognition context. Create a separate Deliberation/Cognition Mission only when the deliberation itself deserves independent historical identity, lifetime, research burden, completion criteria or durable deliverable. Discussion remains draft/non-binding; full deliberation transcripts are temporary/session-local rather than Project truth. Only an explicitly human-confirmed, Committed structured result becomes durable authoritative Project state and may affect other missions.

A coordinator is an ordinary WorkerSession bound to a coordination mission. It is the product-level semantic bridge that executes and transports already-authorized Cognition/host instructions and returns structured results; it does not invent Mission decomposition or replace Project-/Phase-level Cognition. It is not the technical Nimora Bridge, Gateway or Task Runtime. When its root mission finishes, the coordinator session is retired like every other mission worker.

Technical Bridge/Gateway roles remain transport/exposure boundaries. They do not become project brains.

## Consequences

- Project becomes the highest long-lived product concept; Task remains the existing durable runtime work unit during incremental migration.
- Mission identity belongs to work, not to a provider/model. Claude/GPT/Gemini/local/web workers can execute any mission type if capable.
- WorkerSession reuse across unrelated completed missions is disallowed for disposable mission workers; logical retirement is an explicit lifecycle event even when a provider keeps the underlying web transcript.
- Project continuity comes from Project state, structured mission outputs, artifacts and handoffs rather than a permanent AI conversation.
- Automatic Project creation begins only after an authorized bounded Formation Result; raw chat arrival does not itself constitute Project creation authority.
- Work Sessions should evolve from a flat Task list toward Project→Mission presentation without creating a second competing state owner.
- WebMCP remains responsible for reliable communication with web AI; mission orchestration sits above `WebWorkerAdapter`/`WorkerSessionManager`.
- New product logic stays Nimora-owned. Do not push Project/Mission/Cognition/Practice semantics into generic Code-OSS Chat internals.

## Non-goals

- globally renaming all Task symbols to Mission;
- replacing TaskRuntime, WorkerSessionManager or Worker adapters;
- creating permanent Researcher/Coder/Coordinator agent classes;
- making every project decision wait for a human;
- broadcasting entire chat transcripts between workers;
- letting the coordinator directly depend on website DOM selectors;
- turning Bridge or Gateway back into Task/business state owners.
