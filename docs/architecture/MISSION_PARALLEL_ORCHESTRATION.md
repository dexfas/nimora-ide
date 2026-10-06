# Mission Parallel Orchestration

> Status: implemented and focused-regression verified on 2026-09-28. This is a Phase-11-independent Mission/Task/Worker domain hardening. It does **not** close, modify, or make claims about the still-open Phase 11 real-provider proof.

## 1. Purpose

Nimora's unit of safe parallelism is the **Mission**, not an arbitrary extra AI chat:

> Project/Phase Cognition performs principled decomposition into bounded Missions with explicit semantic ownership and dependencies; each active Mission has at most one current Worker; independent Missions may execute concurrently; dependent or blocked Missions wait until owner-backed facts make them ready.

This preserves the existing Mission Creation Gate and the roadmap rule that multiple implementers must not concurrently mutate the same responsibility domain before merge semantics exist.

The resulting model is:

```text
Project / Root Mission
        │
        ├─ Mission A ─ Worker A ─┐
        ├─ Mission B ─ Worker B ─┼─ concurrent when independently ready
        └─ Mission C ─ Worker C ─┘
              ▲
              │ depends_on / Problem / lifecycle truth
              │
      owner-backed readiness derivation
```

Parallelism therefore means **principled division of work**, not opening more provider conversations and hoping they do not collide.

## 2. Authority boundaries

No new durable scheduler or workflow owner was added.

- `ProjectStore` remains Project/governance truth.
- `TaskRuntime` remains Mission identity, membership, lifecycle, Task work and durable Worker-reference truth.
- `MissionCollaborationStore` remains the owner of bounded cross-Mission relations/exchanges. `depends_on` is still a collaboration fact, not a globally imposed workflow DAG.
- `WorkerSessionManager` remains live WorkerSession lifecycle/routing truth.
- `MissionWorkerAssignmentService` remains the canonical initial Worker assignment path and continues enforcing at most one current Worker per Mission.
- Project-/Phase-level Cognition still owns semantic decomposition, Mission goals, dependency meaning and the judgment that work should be split at all.
- Coordinator remains a disposable bridge/executor for already-authored actions. This work does not turn it into a permanent planner or project brain.

The new layer is deliberately **stateless and reconstructible**. Restart does not require replaying a scheduler journal: it rereads the canonical owners and derives the current frontier again.

## 3. `MissionParallelReadinessService`

`src/mission-parallel-orchestration.ts` adds a read-only readiness service over `ProjectStore + TaskRuntime + MissionCollaborationStore + WorkerSessionManager`.

It accepts one exact `projectId + rootMissionId` scope and either all ordinary Cognition/Practice child Missions or an explicit bounded Mission subset. Root and Coordination Missions are excluded from the normal parallel work frontier.

For each selected Mission it derives one of these states:

| State | Meaning |
| --- | --- |
| `terminal` | Mission already has durable Mission finalization. |
| `running` | Task work or the coherent current Worker is currently running. |
| `blocked` | At least one mechanical owner-backed blocker prevents safe fan-out. |
| `ready-assigned` | Ready and already has exactly one coherent current Worker. |
| `ready-unassigned` | Ready and has no current Worker; eligible for explicit initial assignment. |

Current blocker classes are intentionally mechanical rather than semantic AI guesses:

- `unfinished-dependency` — an explicit `depends_on` target is not yet finalized;
- `dependency-cycle` — the explicitly selected active dependency scope contains a cycle, so no topological parallel frontier is claimed;
- `unresolved-blocking-problem` — the Mission itself owns a blocking `Problem` without the exact durable `Answer` + `answers` resolution already used by existing collaboration/completion semantics;
- `task-waiting` — Task is waiting for user/external input;
- `task-terminal-status-without-finalization` — Task status says completed/failed/cancelled without canonical Mission finalization, so the layer refuses to reinterpret that inconsistency as readiness;
- `worker-ownership-ambiguous` — durable TaskRuntime Worker truth and live WorkerSessionManager truth are partial, multiple, or disagree.

A blocking Problem blocks its **source Mission**, not the Cognition Mission that may need to investigate and answer it. Otherwise the feedback loop could deadlock itself by preventing the solver from running.

## 4. Dependency waves are derived advice, not a new workflow DAG

The service returns deterministic `dependencyWaves` for the selected active Missions. A wave means that, considering explicit unfinished `depends_on` edges only, those Missions could occupy the same dependency layer.

Example:

```text
A    B    E
│    │
├─C  └─D
└─────D

dependencyWaves:
  wave 1 = A, B, E
  wave 2 = C, D
```

This does **not** rewrite Phase 3 semantics:

- CollaborationStore still permits descriptive `depends_on` facts without becoming a scheduler.
- Other blockers such as Problems, waiting state or Worker ownership are represented separately in Mission readiness.
- A cycle is detected and reported for this parallelization view; the relation store itself is not rewritten or globally constrained into a DAG.
- `dependencyWaves` are never persisted and never authorize a send by themselves.

This distinction is important: a dependency graph is useful for deciding what *could* be parallel, while current readiness decides what *may* actually be assigned now.

## 5. Worker ownership rule

Parallelism remains **across Missions**.

For one Mission, current Worker truth is admitted only as:

```text
0 durable + 0 live
=> ready-unassigned (subject to other blockers)

1 durable + 1 live + exact managed/worker/adapter identity match
=> coherent current Worker

anything else
=> worker-ownership-ambiguous / fail closed
```

This service does not relax `MissionWorkerAssignmentService.assertNoCurrentAssignment()`. A replacement Worker is still a lifecycle transition on the **same** Mission after the old current Worker is known-settled and retired; it is not a second simultaneous implementer.

## 6. `MissionParallelAssignmentService`

The second new component is a narrow explicit fan-out seam. The caller supplies exact `WorkerAssignmentRequest` objects for already-created Missions. The service:

1. normalizes and validates exact Project/root/Mission scope;
2. derives one fresh readiness snapshot;
3. skips every Mission that is not `ready-unassigned`;
4. invokes the existing `MissionWorkerAssignmentService.assignInitial()` concurrently for the independent ready requests;
5. derives a fresh post-assignment readiness snapshot.

The implementation uses independent per-Mission assignment lanes already owned by `MissionWorkerAssignmentService`, so different Missions may overlap while concurrent initial assignment to the same Mission still converges to at most one current Worker.

Result states are bounded:

- `assigned`;
- `not-ready` with observed readiness/blocker codes;
- `no-admissible-candidate`;
- `assignment-error` with `retryAuthorized: false`.

An assignment error never authorizes automatic fallback/retry because provider/session creation may be ambiguous. Existing UNKNOWN/no-blind-replay semantics remain intact.

## 7. Deliberately not implemented here

This hardening does not add any of the following:

- automatic semantic decomposition of a large goal into Missions;
- a persisted workflow queue, scheduler journal, outbox or second Mission graph;
- automatic creation of Mission dependencies from prose;
- multiple current Workers inside one Mission;
- automatic Work Order delivery after assignment;
- provider-side send/retry/fallback;
- automatic conflict/merge of two implementers changing the same responsibility domain;
- automatic completion judgment from goal/completion-criteria prose;
- Phase 11 browser/native-MCP/Bridge changes.

Those omissions are intentional. Cognition supplies the semantic plan; this layer proves and executes only the mechanical parallel-assignment boundary that current owner truth can support safely.

## 8. Phase 11 isolation

Phase 11 was open while this work was implemented. To avoid contaminating its current real-provider proof lane, this change is not wired into the production extension command surface yet.

The work changed only:

- `src/mission-parallel-orchestration.ts` — new domain service;
- `scripts/shuncode-mission-parallel-orchestration-smoke.mts` — deterministic proof;
- root `package.json` — one test-script registration;
- `extensions/shuncode/tsconfig.json` — includes the new domain service in the existing strict ShunCode typecheck gate; this is verification wiring only, not production runtime composition;
- architecture documentation.

It does **not** modify:

- `extensions/shuncode-webmcp/*`;
- ChatGPT/DeepSeek browser controllers or page/session lifecycle;
- Mission-native MCP binding/Bridge/Current Route Relay;
- `MissionCoordinatorLiveDriver` real-provider transport;
- Phase 11 proof identities, provider sessions, journals, fixtures or workspace proof files.

`compile-shuncode` is intentionally not used as an extra gate for this isolated change while the Phase 11 development runtime is active, because that command rebuilds production extension output and is unnecessary to prove an uncomposed domain module. The new file is instead covered by the strict `typecheck-shuncode` files list plus its direct esbuild-backed smoke. No running Phase 11 process is stopped/restarted to obtain a cosmetic build verdict.

Production command/UI wiring and a real-provider multi-Mission fan-out E2E are therefore deferred until the active Phase 11 proof/source-freeze constraints are released. The domain primitive itself is already independently usable and tested without those transports.

## 9. Verification evidence

Focused proof `npm run test-shuncode-mission-parallel-orchestration` covers:

- two independent ready Missions entering distinct Worker `createSession()` gates concurrently before either gate is released;
- unknown Project scope and `coordination`-plane fan-out rejecting before assignment;
- a dependent Mission being rejected from the same fan-out batch;
- Coordinator Mission exclusion;
- dependency waves;
- dependency completion unlocking downstream work;
- terminal Mission classification remaining terminal rather than being polluted by Worker ownership diagnostics;
- blocking Problem → exact Answer/`answers` relation resolution;
- explicit dependency-cycle detection without mutating CollaborationStore semantics;
- durable/live Worker ownership ambiguity failing closed;
- exactly one current Worker remaining per successfully assigned Mission.

Preservation gates executed after the final implementation change:

```text
npm run test-shuncode-mission-parallel-orchestration   PASS
npm run typecheck-shuncode                             PASS
npm run test-shuncode-task-runtime                     PASS
npm run test-shuncode-project-mission                  PASS
npm run test-shuncode-mission-collaboration            PASS
npm run test-shuncode-mission-feedback                 PASS
npm run test-shuncode-mission-coordinator              PASS
npm run test-shuncode-mission-coordinator-completion   PASS
npm run test-shuncode-worker-assignment                PASS
npm run test-shuncode-worker-session-manager           PASS
ShunCode diagnostics: mission-parallel-orchestration.ts 0 errors / 0 warnings
git diff --check (changed implementation/test/package files) PASS
```

The Worker Assignment preservation smoke continues to prove `concurrentInitialBindings = at-most-one`, `crossMissionReuse = false`, and `sendsPerformedByAssignment = 0`.

## 10. Safe next integration after Phase 11

Once Phase 11 no longer requires isolation, the next product integration should remain thin:

```text
Project/Phase Cognition
  └─ authors/reconciles Mission decomposition + dependencies
       ↓
MissionParallelReadinessService
  └─ derives ready / blocked / running frontier
       ↓
explicit trusted-host/Coordinator command
       ↓
MissionParallelAssignmentService
  └─ concurrently binds one Worker to each ready Mission
       ↓
existing Phase 8 materialization + explicit Coordinator delivery per Mission
       ↓
Evidence / Problem / Answer / Handoff
       ↓
freshly derive the next frontier
```

The crucial rule remains: **parallel scheduling is a derivation from canonical truth, not a new canonical truth of its own.**
