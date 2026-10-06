# Phase 12 — Nimora Product UI Plan

Status: planning baseline accepted for implementation while Phase 11 remains proof-sensitive (2026-09-30).

## 1. Product doctrine

The UI must expose Nimora's runtime model instead of hiding it behind a generic chat shell.

The non-negotiable product sentence is:

> Project persists. Mission has a lifecycle. Worker is replaceable.

The visual hierarchy therefore follows:

Project
-> Mission
-> Worker / execution resources
-> Artifact / Decision / Evidence / Handoff

Conversation is not a top-level product object.

## 2. External UI patterns to borrow

### OpenHands Agent Canvas — borrow the workbench shell

Borrow:

- a persistent application shell;
- clear separation between navigation, active work and tool/config surfaces;
- connection/provider configuration as a secondary management surface;
- frontend as control surface, not execution owner.

Adapt for Nimora:

- replace conversation-first navigation with Project-first navigation;
- replace agent identity with Mission identity;
- keep Worker/provider selection inside Mission or Workers/Connections views;
- preserve editor/terminal/browser as existing Code-OSS work surfaces instead of duplicating them in Product Shell.

Reject:

- conversation as durable user identity;
- one agent session equaling one unit of work.

### Plane — borrow project information density

Borrow:

- compact rows/cards with clear status metadata;
- strong left navigation and fast project switching;
- filters and grouping without forcing users into a complex graph;
- list-first work management.

Adapt for Nimora:

- issue/task becomes Mission;
- assignee becomes current Worker only as secondary metadata;
- status comes from TaskRuntime/Mission finalization, never UI state;
- blockers become Problems / readiness / UNKNOWN rather than generic priority labels.

Reject:

- treating Mission as a manually managed ticket;
- user-edited status that bypasses canonical Mission state.

### Trigger.dev — borrow execution timeline and run inspection

Borrow:

- chronological run/activity presentation;
- compact status chips;
- detail-on-selection rather than dumping logs by default;
- clear separation between current state and historical events.

Adapt for Nimora:

- timeline is Project/Mission Activity, sourced from canonical events and non-owning observations;
- execution, Worker replacement, reconnect, Handoff, Artifact and Decision all appear in one human-readable stream;
- UNKNOWN remains UNKNOWN and never renders as failure/success by convenience.

Reject:

- retry buttons that imply replay authority;
- treating browser/provider turn settlement as proof of external side-effect settlement.

### LangGraph Studio — borrow advanced graph inspection only

Borrow:

- optional dependency/flow visualization;
- click node -> inspect current state/details;
- graph as a diagnostic/advanced view.

Adapt for Nimora:

- nodes are Missions, not prompt/tool nodes;
- edges come from existing Mission hierarchy/relations/readiness;
- graph is read-only projection in v1.

Reject:

- making graph editing the normal workflow;
- introducing a durable UI DAG owner or scheduler journal.

## 3. Global information architecture

Phase 12 Beta global navigation:

1. Projects
2. Activity
3. Workers
4. Connections
5. Settings

Project-scoped navigation:

1. Overview
2. Missions
3. Decisions
4. Artifacts
5. Activity
6. Graph (advanced / later Beta)

Project remains the default landing surface.

## 4. Main shell layout

Desktop layout:

Left rail (global)
-> Projects / Activity / Workers / Connections / Settings

Context sidebar
-> Project list or Project sections

Main content
-> current Project Overview / Mission detail

Optional focus drawer
-> Worker, Artifact, Decision, execution or diagnostic detail

The focus drawer is deliberately secondary. A Worker must never replace the Mission as the page identity.

## 5. Project Overview

Top section:

- Project title;
- durable goal;
- overall Project state derived from current Missions;
- Continue Work;
- New Project.

Primary blocks:

- Active Missions;
- Needs Your Attention;
- Recent Activity;
- Recent Artifacts;
- Recent Decisions.

The first-screen question is:

> What is this Project trying to achieve, what is working now, and where does the human need to act?

Do not lead with model/provider/session details.

## 6. Mission presentation

Mission row/card shows:

- goal;
- semantic role: 文 / 理 / 总协调 with human-language label;
- durable Mission state;
- readiness/blocking state when available;
- current Worker as secondary text/avatar/icon;
- Artifact count;
- attention marker.

Mission detail shows:

- Mission goal and completion state;
- current work summary;
- current Worker card;
- execution/activity timeline;
- Artifacts;
- Problems / Answers / Evidence / Handoff;
- Replace Worker action.

Replacing Worker must visually look like continuity inside the same Mission, not creating a new task.

## 7. Human attention model

The UI should not use generic notifications as the main human-in-the-loop model.

Needs Your Attention aggregates only real semantic/operational needs such as:

- Proposal awaiting Human Confirmation;
- blocking Problem;
- auth challenge / login required;
- capability approval required;
- UNKNOWN execution settlement requiring reconciliation;
- Worker unavailable with no automatic safe continuation.

Each item must explain:

- what happened;
- what Nimora knows;
- what Nimora does not know;
- what human action is available.

## 8. Activity model

Activity is a human-readable projection, not raw logs.

Examples:

- Mission started;
- ChatGPT Worker connected;
- execution completed;
- execution settlement unknown;
- context approaching limit;
- Handoff prepared;
- Worker retired;
- replacement Worker took over;
- connection recovering;
- Artifact produced;
- Decision committed;
- Mission finalized.

Default Activity hides protocol ids, MCP internals and DOM/provider details.

Advanced diagnostics may reveal them without changing truth.

## 9. Worker and Connections UX

Workers page answers:

- which execution providers are currently usable;
- which Mission each current Worker belongs to;
- whether the Worker is healthy/busy/recovering/waiting-human/retired;
- whether replacement is available.

Connections page answers:

- ChatGPT / DeepSeek / API connection readiness;
- login/auth state;
- MCP/Bridge availability in normal product language;
- actions to reconnect or configure.

Transport URLs, session ids and relay internals belong behind Advanced Diagnostics.

## 10. Visual status grammar

Never collapse different truth dimensions into one colored dot.

Keep three conceptual layers separate:

- Domain state: Mission active/completed/failed/archived;
- Operational state: ready/busy/recovering/waiting-human/connection-lost/drift/unknown/retired;
- Execution settlement: succeeded/failed/unknown/etc.

The UI may compose these into a sentence, but must preserve the distinctions in data and interaction.

## 11. Beta implementation slices

### Slice A — shell polish

- global rail;
- denser Project sidebar;
- Project Overview hierarchy;
- status grammar/tokens;
- responsive focus layout.

### Slice B — Project/Mission depth

- Mission list/detail split;
- Needs Your Attention;
- Activity timeline;
- Artifact and Decision detail drawers.

### Slice C — operational UX

- Worker health card;
- Connections page;
- human-readable recovery/UNKNOWN/auth states;
- advanced diagnostics disclosure.

### Slice D — advanced view

- read-only Mission Graph;
- filters/grouping;
- keyboard/command shortcuts;
- final product polish.

## 12. Today-level acceptance target

The first integrated Beta is acceptable when a user can:

1. open Nimora and immediately see Projects;
2. select a Project and understand goal/progress/current work;
3. open a Mission and see its current Worker without confusing Worker with Mission identity;
4. see what needs human attention;
5. inspect recent activity and Artifacts;
6. continue work through the existing runtime;
7. replace a Worker without changing Mission identity;
8. restart and reconstruct the same product view from canonical owners;
9. encounter UNKNOWN/recovery states without the UI inventing success/failure;
10. complete the above without interacting with MCP URLs, managed session ids or provider DOM details.

## 13. UI ownership boundary

Allowed UI-local state:

- selected Project/Mission;
- tab/view selection;
- panel width/collapse state;
- filters/sort;
- graph zoom/layout;
- cosmetic preferences.

Forbidden UI-owned truth:

- Project goal;
- Mission status;
- current Worker authority;
- Decision commit state;
- capability grant truth;
- execution settlement;
- Artifact ownership;
- retry authority.

Those remain reconstructible from canonical owners/application services.

## 14. Implemented governance and Mission-detail contract

The current isolated Product Shell now implements the following parts of this plan:

- pending Project Proposals are projected separately from committed Decisions;
- Human Confirmation is an explicit modal user act and routes through a human-only application service;
- Commit revalidates Proposal identity/digest against canonical Project truth;
- Mission detail includes execution history, Artifacts, Problems/Answers/Evidence and Handoff/collaboration facts;
- Activity uses a semantic tone layer while retaining exact underlying status, including UNKNOWN.

One planned Activity source is intentionally not connected yet: non-owning `MissionObservationEvent` has no accepted durable replay owner exposed to the Product Shell. Until that exists, Product Activity must remain a projection of durable canonical facts rather than pretending transient observations are durable history.

## 15. Implemented Mission Graph contract

The current Graph is intentionally factual rather than predictive:

- nodes come from canonical Missions and are arranged by TaskRuntime hierarchy depth;
- `parent_of` comes from TaskRuntime parent metadata through the accepted Phase 9 presentation;
- other edges come only from accepted MissionCollaborationStore relations;
- Project progress is completed Mission count divided by total Mission count;
- running/ready Missions are surfaced as `正在推进`; waiting/attention Missions are surfaced separately;
- no UI-derived critical path, dependency completion inference, ETA or scheduler recommendation is written back as truth;
- clicking a node or relation endpoint opens the same persistent Mission detail surface.

## 16. Beta hardening state grammar

The Product Shell now distinguishes the following user-visible states without changing canonical ownership:

- `loading`: owner reads are still in progress;
- `ready`: canonical owner reads are available and the current presentation is reconstructible without integrity gaps;
- `degraded`: some durable facts remain available, but an owner, Project metadata or integrity relation is incomplete;
- `unavailable`: the shell cannot authoritatively determine whether Project/Mission data exists because required owners are unavailable;
- `empty`: owners are available and there are genuinely no Projects/Missions;
- `UNKNOWN`: an execution settlement remains unresolved and therefore cannot be presented as success, failure or retry authority.

`reconstruction=ready` means the current product projection can be rebuilt from durable accepted owners. It does **not** claim that a restart occurred. `reconstruction=partial` means some accepted durable source is unavailable or structurally incomplete.

Accessibility baseline now includes semantic landmarks, skip-to-main, visible keyboard focus, `aria-current` for selected navigation, and arrow/Home/End movement inside primary navigation groups.

## 17. Product-complete Beta closure

The isolated Phase 12 source now satisfies the product workflow defined by the earlier acceptance target without creating new runtime ownership:

- Project creation begins in Nimora, but the actual create/Formation path is the existing fresh ordinary Chat + `@shuncode` production ingress;
- continuing work targets the exact durable Mission resource through the existing `nimora-task` session path rather than opening an ambiguous generic work list;
- continuation refuses terminal Mission and UNKNOWN execution state before send;
- missing live Worker is a same-Mission recovery/select-Worker state, not a new Mission or hidden retry;
- Workers/Connections distinguish provider candidate observation from live Worker session state and show partial/unavailable observation truthfully;
- onboarding/readiness surfaces workspace, trust, provider readiness and capability permissions using existing configuration/governance seams;
- completed Project state, Project filtering and keyboard shortcuts are now explicit product UX;
- a thin `registerNimoraProductLayer` composition seam is ready for production registration after Phase 11 closes;
- the standard repeatable isolated acceptance command is `npm run test-shuncode-nimora-product-shell`.

The implementation backlog for this Beta is therefore closed. Remaining work is an integration/acceptance gate, not another product feature slice: register the already-built layer after Phase 11 releases the proof-sensitive runtime, build/reload once, and perform real UI/provider acceptance for new Project -> Formation -> execution -> continuation -> restart -> Worker replacement -> Artifact/completion.
