# Worker Conversation Lifecycle

Status: **user-authorized additive hardening / source staged / production integration pending**

Date: 2026-09-28

## 1. Product principle

Nimora is intentionally built around Web/API/chat AI Workers rather than assuming one immortal provider conversation.

Web/chat AI has two recurring operational weaknesses:

1. **instability** — page failure, provider timeout, stream interruption, session loss, authentication/runtime drift;
2. **finite conversation capacity** — provider context windows are finite and long conversations accumulate redundant history.

The product-level split is:

> **Coordinator reliability handles instability. Coordinator + Worker conversation lifecycle handles finite context.**

This does not turn Coordinator into a planner. Cognition still owns semantic planning and Handoff content. The runtime/Coordinator executes deterministic lifecycle transitions around already-authorized work.

This direction is consistent with committed Proposal F and Proposal G:

- state-aware Worker liveness and recovery;
- deterministic conversation creation/reuse/replacement/retirement/provider cleanup;
- provider context exhaustion is Worker replacement, not Mission replacement;
- full provider transcripts are not Project memory;
- UNKNOWN does not create retry authority.

## 2. Ownership boundary

The lifecycle layer is an **operational runtime policy**, not a second Project/Mission runtime and not a second memory owner.

Authoritative owners remain unchanged:

- ProjectStore: durable Project/governance truth;
- TaskRuntime: Mission/work/execution/Handoff/Worker-ref truth;
- WorkerSessionManager: live WorkerSession lifecycle;
- Phase 8 materializers: bounded current Context/Skill/Capability reconstruction;
- Cognition: semantic Plan/Handoff authority;
- Coordinator/runtime: reliable transport and already-authorized lifecycle execution.

Provider chat history remains provider-local disposable compute context. It never becomes durable Project memory.

## 3. Capacity detection

### 3.1 Do not fake provider token truth

Web providers do not consistently expose a trustworthy exact remaining-token counter. DeepSeek can virtualize old message DOM; provider UI and model limits can change independently of Nimora.

Therefore Nimora must not claim an exact remaining-token count unless a future provider adapter supplies a certified typed source for that fact.

### 3.2 Current staged capacity model

Source: src/worker-conversation-lifecycle.ts

The provider-neutral capacity classifier uses:

- Nimora-owned operational character count since the Worker conversation was attached;
- Nimora-owned admitted-turn count;
- optional read-only provider-visible character floor;
- explicit provider context-limit/error text when observed.

Provider-visible content is only a **floor**. It may raise the observation but may not prove that virtualized/off-screen history does not exist.

Current conservative lifecycle defaults are:

| Signal | Approaching | Rotation required |
| --- | ---: | ---: |
| Nimora-observed characters | 240,000 | 320,000 |
| Nimora-admitted turns | 48 | 64 |

These values are **Nimora lifecycle budgets**, not claims about ChatGPT/DeepSeek model context limits. They are intentionally conservative and can later become provider/model-profile policy.

Capacity states:

~~~text
normal
approaching-limit
rotation-required
exhausted
unknown
~~~

An explicit provider limit message can promote the state directly to exhausted.

### 3.3 Lifecycle gate

The staged deterministic decision flow is:

~~~text
normal
  -> continue

approaching-limit
  -> prepare bounded Handoff while current authorized work may continue

rotation-required / exhausted
  -> if prior execution/delivery state is UNKNOWN: wait-for-settlement
  -> if settled but Handoff missing: prepare-handoff
  -> durable retire old Worker
  -> attach replacement Worker to the SAME Mission/responsibility
  -> fresh Phase-8 materialization
  -> provider cleanup of the retired conversation
~~~

Worker replacement never grants permission to replay an unresolved side effect.

## 4. Provider conversation cleanup

Source: extensions/shuncode-webmcp/conversation-lifecycle.js

This stages an exact-identity cleanup driver for ChatGPT and DeepSeek.

Policy:

1. cleanup is only eligible after Nimora has durably retired the old Worker;
2. **archive is preferred** when the provider offers it;
3. delete can be used when archive is unavailable or an explicit future policy chooses delete;
4. the current provider and exact provider conversation id must match the expected retired conversation;
5. cleanup controls must be uniquely identified from the accessibility snapshot;
6. ambiguous controls fail closed;
7. destructive delete confirmation is bounded and explicit;
8. after archive/delete, Nimora verifies that the exact retired conversation is no longer the current page identity;
9. cleanup failure does not resurrect the Worker and does not alter Mission truth.

Supported exact route shapes include:

~~~text
ChatGPT:
https://chatgpt.com/c/<conversation-id>

DeepSeek:
https://chat.deepseek.com/a/chat/<conversation-id>
https://chat.deepseek.com/a/chat/s/<conversation-id>
~~~

The current helper recognizes bounded English/Chinese action labels for More / Archive / Delete. Provider UI labels are external and mutable; therefore real-provider certification is required before enabling automatic cleanup in production.

## 5. Why cleanup follows retirement

Provider UI deletion is not a business-state transaction.

Correct ownership order:

~~~text
settled execution state
-> bounded Handoff
-> Task/Worker authority durably retires the old Worker
-> same Mission receives a replacement Worker
-> provider archive/delete is best-effort cleanup
~~~

If provider cleanup fails, the old conversation may still be visible in ChatGPT/DeepSeek history, but Nimora already knows that its Worker identity is dead and must not reuse it.

## 6. Current implementation status

### Implemented and deterministically tested

- provider-neutral capacity states and conservative lifecycle budgets;
- explicit provider context-limit detection;
- UNKNOWN/side-effect settlement gate;
- same-Mission lifecycle decision order aligned with canonical Worker retirement;
- ChatGPT and DeepSeek exact conversation-id parsing;
- read-only provider snapshot inspection;
- exact-identity, ambiguity-rejecting archive/delete cleanup plan;
- post-cleanup identity verification;
- deterministic synthetic ChatGPT archive and DeepSeek delete/confirmation tests.

Dedicated test:

~~~text
node scripts/shuncode-worker-conversation-lifecycle-smoke.mts
~~~

Validation on 2026-09-28:

- Worker conversation lifecycle smoke: PASS;
- test-shuncode-worker-session-manager: PASS;
- test-shuncode-web-worker-adapter: PASS;
- test-shuncode-chatgpt-browser-worker: PASS;
- test-shuncode-phase11-production-routing: PASS;
- typecheck-shuncode: PASS;
- VS Code diagnostics: 0 errors / 0 warnings;
- git diff --check: PASS;
- compile-shuncode: blocked before bundling by the already-running Extension Host holding extensions/shuncode/runtime/bin/shuncode_process_metadata.node (EPERM), not by a TypeScript/build-source error.

### Not yet production-wired

The staged lifecycle source is intentionally **not yet wired into the active Phase 11 production Worker route**.

Reason: current Phase 11 WO#1/R18 real-provider proof is source/hash sensitive. Modifying the accepted ChatGPT controller/WebWorkerAdapter path during that proof would contaminate the active verification boundary.

Production integration should occur after that source freeze is released, by composing this lifecycle layer with the already-planned WO#2 exact-owner replacement/fresh Phase-8 materialization path rather than creating another replacement mechanism.

### Not yet provider-certified

No real user ChatGPT or DeepSeek conversation was archived or deleted during this work.

Before production auto-cleanup is enabled, each provider needs a bounded certification using a disposable/sacrificial conversation:

1. read-only verify the exact provider conversation id and current accessibility labels;
2. prove exactly one archive/delete action path;
3. prove ambiguous/wrong-conversation cases fail closed;
4. prove the retired Worker cannot be rediscovered/reused;
5. prove cleanup failure does not affect same-Mission continuation.

## 7. Target production flow

After integration/certification, the intended autonomous flow is:

~~~text
Worker conversation works normally
        |
        v
capacity observation
        |
        +-- normal ------------------------------> continue
        |
        +-- approaching -------------------------> prepare bounded Handoff
        |
        +-- rotation/exhausted
                |
                v
        reconcile UNKNOWN / side effects
                |
                v
        durable retire old Worker
                |
                v
        assign replacement to SAME Mission
                |
                v
        fresh Context/Skill/Capability materialization
                |
                v
        continue work
                |
                v
        archive/delete retired provider conversation
~~~

The user should not need to watch context gauges, manually type "continue", manually create replacement chats, or clean old provider conversations during ordinary operation.
