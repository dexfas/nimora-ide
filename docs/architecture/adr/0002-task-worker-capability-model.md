# ADR 0002: Task, Worker and Capability are separate domains

- Status: Accepted as target domain model
- Date: 2026-09-13

## Context

The current product distributes state across Chat sessions, multi-model branches, Bridge activity/todos, WebMCP pages and model runtimes. Future goals include Bring Your Own AI Session, worker failover, multiple web AI sessions, context budgets and dynamic tools.

Treating Chat Session or Agent as the top-level object would make those goals increasingly fragile.

## Decision

Define three independent concepts:

1. **Task** — durable user goal, state, context, progress, artifacts and results.
2. **Worker / WorkerSession** — replaceable AI execution resource (web/API/local/AgentHost/remote).
3. **Capability** — executable local/external ability with schema, provider, risk, approval, idempotency and retry metadata.

Chat becomes an interaction projection of Task. Worker adapters never own Task state. Transport adapters never own capability semantics.

## Consequences

- current multi-model branch/merge migrates to worker attempts/candidates/review;
- Bridge todos/progress migrate to Task state;
- WebMCP becomes a worker adapter/transport concern;
- tool discovery becomes task-scoped and dynamic;
- context handoff between workers becomes explicit instead of copying whole transcripts.
