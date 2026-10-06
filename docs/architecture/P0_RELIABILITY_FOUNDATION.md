# Nimora P0 Reliability Foundation

Status: **additive source implemented + focused/preservation regression verified; production composition intentionally deferred while Phase 11 Final Proof 025/027 remains active (2026-09-28).**

This document records the first P0 reliability-foundation tranche added around the already-existing Nimora lifecycle, Current Route and Mission parallel work. It is not a second runtime and it does not replace any canonical owner.

## 1. Why this exists

Nimora already has the important business/runtime mechanisms:

- Project truth survives provider/browser turnover;
- Mission is the bounded work lifecycle;
- WorkerSession is disposable and replaceable;
- Worker Conversation Lifecycle classifies finite provider capacity and defines same-Mission succession;
- Current Route Relay absorbs routine public-URL churn without owning capability authority;
- Mission Parallel Orchestration derives safe cross-Mission fan-out without introducing a scheduler owner;
- TaskRuntime, ProjectStore and MissionCollaborationStore remain the canonical durable owners.

The missing P0 foundation was therefore **not another recovery system**. The missing pieces were:

1. one provider-neutral way to describe Web Worker operational reality;
2. one bounded observation envelope that UI/debug/eval/reliability tooling can understand without copying canonical owner state;
3. a deterministic failure-focused smoke seam that proves those observation rules before production composition.

The resulting rule is:

> **Existing Nimora owners decide truth and authority. P0 observation code only makes that truth and operational reality easier to see, correlate and test.**

## 2. New source

### 2.1 `src/mission-observation-event.ts`

`MissionObservationEvent` is a versioned, bounded observation envelope:

~~~text
MissionObservationEvent
  version
  observationId
  at
  kind: domain | operational | telemetry
  name
  scope:
    projectId
    rootMissionId
    missionId
  source:
    owner
    component
    sourceRecordId?
    sourceRecordType?
  causationId?
  correlationId?
  occurrenceId?
  worker?
  facts?
~~~

It is intentionally **not** a journal owner. There is no `MissionObservationStore` and no new workflow/event-sourcing authority.

For canonical durable facts, the observation points back to the existing owner record:

- `TaskRuntime TaskEvent -> MissionObservationEvent`;
- `ProjectStore ProjectEvent -> MissionObservationEvent`;
- `MissionCollaborationStore MissionExchange -> MissionObservationEvent`.

The projection does not clone the owner's canonical payload. A `TaskWorkerRetired` observation, for example, records that the canonical TaskRuntime event exists and identifies it; TaskRuntime remains the only durable source of the retirement fact.

The first event namespace includes projections such as:

- `mission.created`;
- `mission.finalized`;
- `worker.attached`;
- `worker.retired`;
- `capability.execution-requested`;
- `capability.execution-finished`;
- `artifact.produced`;
- `project.decision-committed`;
- `collaboration.problem-recorded`;
- `collaboration.handoff-recorded`.

The envelope carries `causationId`, `correlationId` and `occurrenceId` seams so later UI/debug/reliability work can trace one operation across Worker/browser/capability boundaries without making logs authoritative.

### 2.2 Observation privacy and boundedness

`facts` is deliberately small:

- maximum 32 keys;
- primitive scalars / bounded scalar arrays only;
- bounded string size;
- no arbitrary nested owner payload;
- keys associated with prompt, transcript, reasoning, messages, raw content, HTML or DOM are rejected;
- camelCase variants such as `providerTranscript` are also rejected.

This preserves the existing rule:

> **Provider transcript/reasoning/page content is live observation, not Project memory and not a new hidden memory bus.**

The focused smoke initially found that the first forbidden-key matcher rejected delimiter-separated `provider-transcript` but not camelCase `providerTranscript`. The implementation was repaired and the regression is now explicit.

Unknown observation source owners also fail closed at runtime rather than relying only on TypeScript compile-time types.

## 3. Provider-neutral Browser Worker observation

### 3.1 `src/browser-worker-observation.ts`

This source does not replace ChatGPT/DeepSeek/WebMCP observation code. It provides a common vocabulary into which those existing provider-specific observations can later be adapted.

The dimensions are intentionally orthogonal:

~~~text
transport:
  connected | reconnecting | lost | unknown

page:
  exact | drifted | missing | unknown

conversation:
  exact | drifted | missing | unknown

turn:
  idle | admitted | running | tool-phase | terminal | unknown

auth:
  ready | challenge | expired | unknown

capability:
  exact | stale | unavailable | not-required | unknown
~~~

They derive a provider-neutral operational state:

~~~text
ready
busy
waiting-human
recovering
connection-lost
page-drift
conversation-drift
capability-drift
settlement-unknown
unavailable
retired
~~~

The implementation validates every runtime enum value. A JavaScript/provider adapter cannot pass an invented value such as `connected-ish` and accidentally derive `ready`.

### 3.2 Important safety semantics

Operational observation does **not** decide Mission semantics.

It does not:

- complete/finalize a Mission;
- retire or replace a Worker;
- authorize resend/retry;
- grant capability authority;
- decide whether an external side effect committed;
- create a new Mission;
- persist Project truth.

`turnSettlement` has only three values:

~~~text
settled | active | unknown
~~~

and means only the observed **browser/provider turn** state. It is explicitly not capability/external-side-effect settlement.

Therefore:

~~~text
browser connection lost while turn=running
=> operationalState=connection-lost
=> turnSettlement=active
=> NOT permission to resend
~~~

The existing execution ledger / UNKNOWN reconciliation rules remain authoritative.

Durable retirement also dominates transient browser state:

~~~text
TaskRuntime says Worker generation retired
+ browser currently says lost/unknown
=> operationalState=retired
=> never resurrect that Worker generation
~~~

## 4. Relationship to today's other hardenings

These additions are complementary to, not replacements for:

### Worker Conversation Lifecycle

`worker-conversation-lifecycle.ts` still owns the deterministic capacity/lifecycle decision model:

~~~text
normal
approaching-limit
rotation-required
exhausted
unknown
~~~

The new Browser Worker observation vocabulary can later supply provider-neutral operational evidence to that path, but it cannot retire/replace a Worker by itself.

### Current Route Relay

The Relay still owns only the current transport pointer. A route move may later produce operational observations, but URL reachability never grants Mission/capability authority.

### Mission Parallel Orchestration

Parallel readiness still derives from canonical Project/Task/Collaboration/Worker ownership truth. Observation events can make fan-out/debugging visible later, but do not become a scheduler queue or dependency owner.

## 5. Reliability foundation smoke

New:

- `scripts/shuncode-p0-reliability-foundation-smoke.mts`

It currently proves:

| Scenario | Required invariant |
| --- | --- |
| TaskRuntime retirement projected | observation references canonical event and does not copy canonical payload |
| Project decision projected | ProjectStore remains source owner |
| Collaboration Problem projected | MissionCollaborationStore remains source owner |
| prompt/transcript-like fact key | rejected |
| unknown observation owner | rejected |
| healthy exact browser state | `ready` |
| active tool phase | `busy + active` |
| connection lost during running turn | `connection-lost + active`, never fake-settled |
| reconnect | `recovering` |
| page/conversation/capability drift | explicit drift state |
| unknown turn | `settlement-unknown` |
| auth challenge | `waiting-human` |
| incomplete operational observation | `unavailable` |
| durably retired Worker + transient failure | `retired` wins |
| invalid runtime enum | rejected rather than accidentally ready |

This is the first common seam for a larger Nimora Reliability Lab; it does not replace the existing focused smoke suite.

## 6. Current validation

Fresh current-checkout verification on 2026-09-28:

- `node scripts/shuncode-p0-reliability-foundation-smoke.mts` — PASS;
- `node scripts/shuncode-worker-conversation-lifecycle-smoke.mts` — PASS;
- `npm run test-shuncode-mission-parallel-orchestration` — PASS;
- `npm run test-shuncode-worker-session-manager` — PASS;
- `npm run test-shuncode-web-worker-adapter` — PASS;
- `npm run test-shuncode-current-route-relay` — PASS;
- `npm run test-shuncode-phase11-native-mcp` — PASS;
- `npm run test-shuncode-phase11-production-routing` — PASS;
- strict targeted TypeScript check for both new source files — PASS;
- `npm run typecheck-shuncode` — PASS;
- VS Code diagnostics on both new source files — 0 errors / 0 warnings.

No live provider action, provider conversation deletion, semantic proof send or production composition change was performed by this work.

## 7. MCP compatibility audit

The current checkout already uses the existing official `@modelcontextprotocol/sdk` v1 line (`^1.30.0`) in the root and WebMCP Gateway. No replacement MCP implementation should be invented by Nimora.

The upstream 2026-07-28 MCP revision changes the transport/protocol model materially:

- protocol-level sessions / `Mcp-Session-Id` are removed for modern Streamable HTTP;
- the old initialize/initialized handshake is removed in the modern protocol;
- request protocol/capability identity is carried per request;
- application cross-call state should use explicit application handles rather than implicit MCP transport sessions;
- the official TypeScript SDK v2 is the migration path and supports explicit modern-vs-legacy negotiation.

Reference upstream documents:

- `modelcontextprotocol/modelcontextprotocol: docs/specification/2026-07-28/changelog.mdx`;
- `modelcontextprotocol/typescript-sdk: docs/migration/upgrade-to-v2.md`;
- `modelcontextprotocol/typescript-sdk: docs/migration/support-2026-07-28.md`.

Nimora's architecture already has the correct authority direction: `MissionNativeMcpBindingService` is an ephemeral protocol binding while TaskRuntime + WorkerSessionManager + Phase-8 capability/execution owners remain authoritative.

However, the active Phase 11 binding/call path currently includes legacy protocol-session identity in its request occurrence construction. Migrating that code or the root MCP dependency while Final Proof 025/027 is source/hash-sensitive would expand the active proof surface.

Therefore the P0 decision is:

> **Adopt the official MCP v2 SDK rather than inventing a protocol stack, but defer the production dependency/call-path migration until the current Phase 11 source freeze is released.**

At that later integration point, the transport adapter must normalize legacy and modern requests into the same Nimora Mission-native authorization path. Neither a legacy MCP session id nor a modern request envelope may become Project/Mission/Worker/capability authority.

## 8. What remains before P0 production closure

**2026-10-05 source integration update:** the freeze below is historical. Canonical commit observations/browser diagnostic sampling, lifecycle production owners, and official MCP v2 first-party/Gateway transport are now connected and covered by 34 affected local suites. Retired-provider archive and private Personal Edge pairing have explicit product entries. Real-provider certification of these new branches is still pending; AgentHost native execution and Stable OS certification are not closed. See [current integration record](COMPONENT_INTEGRATION_2026-10-05.md); the old list below must not be read as a current assertion that all six seams are unassembled.

The safe additive foundation above is implemented. The remaining work intentionally crosses the current Phase 11 production seam and therefore waits for that proof boundary:

1. adapt existing ChatGPT/DeepSeek/WebMCP observations into `BrowserWorkerOperationalObservation`;
2. emit bounded `MissionObservationEvent` projections from existing canonical/runtime seams for UI/debug/eval use;
3. wire existing Worker Conversation Lifecycle into the accepted exact-owner retire -> same-Mission replacement -> fresh Phase-8 materialization path;
4. certify real-provider ChatGPT/DeepSeek rotation/recovery/cleanup with disposable conversations;
5. migrate the MCP wire layer to the official v2 SDK/2026 compatibility path while keeping `MissionNativeMcpBindingService` authority semantics unchanged;
6. grow the reliability smoke into a named scenario matrix covering disconnect, restart, route rotation, context rotation, duplicate capability occurrence and UNKNOWN side-effect reconciliation.

These are production-integration/real-provider closure items, not permission to redesign the existing owners.

## 9. Non-negotiable invariants

1. Observation != authority.
2. Browser/provider turn settlement != external side-effect settlement.
3. Reconnect/replacement != retry permission.
4. Worker replacement != Mission replacement.
5. Transport/session identity != Mission authority.
6. Provider transcript/reasoning/DOM != Project memory.
7. Retired Worker generation cannot become current again.
8. ProjectStore, TaskRuntime and MissionCollaborationStore retain their existing ownership boundaries.
9. Coordinator remains a control/recovery mechanism, not a second semantic planner or truth owner.
10. P0 integration must reuse existing lifecycle, route, assignment, Phase-8 and execution-ledger mechanisms rather than create parallel copies.
