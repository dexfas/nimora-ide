# ADR 0001: Adopt Thin Core + Nimora Runtime + Gateway

- Status: Accepted as target architecture
- Date: 2026-09-13

## Context

Nimora is reconstructed from a ShunCode distribution based on Code-OSS 1.132.0. The recovered product contains both deep Core AgentHost/Sessions capabilities and ShunCode-specific product logic inside generic Workbench Chat code. It also contains a first-party runtime, Bridge, WebMCP and browser Gateway.

Three options were considered: continue deep Core integration, move to pure Extension-first, or keep a thin generic Core integration while moving Nimora business domains into owned services.

## Decision

Adopt **Thin Core + Nimora Task Runtime + Capability Layer + modular Nimora Gateway**.

Keep and follow upstream for generic AgentHost/AHP/Sessions infrastructure. Prefer Extension/proposed APIs for new product features. Add Core changes only when a generic integration hook is demonstrably required.

Move Nimora-specific Bridge UI, multi-model business state, provider-name special cases and branded tool rendering out of generic Chat Core over time.

## Consequences

Positive:

- retains valuable VS Code/AgentHost infrastructure;
- lowers future upstream merge cost;
- gives Nimora clear ownership boundaries;
- allows Web/API/local/AgentHost workers to share one Task domain;
- enables incremental migration.

Negative:

- temporary dual state/adapters during migration;
- requires explicit contracts between Workbench, Runtime and Gateway;
- some existing Core UI will need generic replacement hooks before it can be removed.

## Non-goals

- removing VS Code as Nimora's base;
- immediately deleting current Core patches;
- rewriting AHP;
- replacing MCP with a private protocol.
