# Nimora Current Route Relay

> Status: free SQLite Durable Object Worker deployed on 2026-09-30; public health=200 and unauthenticated admin=401. Workspace Mission selection / startup alias publication source and bundle are updated. ShunCode secret configuration, current binding recovery and live URL-rotation acceptance are in progress; this is not Phase11 closure.
> This document describes source behavior and deployment. It does not by itself close Phase 11, WO#1, R18, or any Final Proof.

## 1. Problem

Cloudflare Quick Tunnel is useful because it requires no custom domain, but its public trycloudflare.com hostname may change after ShunCode, cloudflared, or the computer restarts.

The direct Mission-native MCP endpoint contains the current Bridge route token and the current exact Mission binding token. A ChatGPT custom MCP connector that points directly at that endpoint can therefore become stale after runtime recovery.

Recreating or editing the ChatGPT connector on every restart makes human intervention part of normal operation. ShunCode also must not solve this by scraping ChatGPT cookies, automating undocumented account APIs, weakening Mission scope, or turning the connector into a second permission owner.

## 2. Design

The solution is one stable transport indirection:

~~~text
ChatGPT Web Worker
        |
        | stable URL configured once
        v
https://<worker>.workers.dev/r/<stable-path-token>/mcp
        |
        | Current Route Relay
        v
https://<current-quick-tunnel>/mcp/<bridge-token>/mission-current/<mission-id>
        |
        v
ShunCode Bridge -> MissionNativeMcpBindingService -> Phase-8 capability authority
~~~

The control path is:

~~~text
Nimora prepares exact Mission binding
        |
ShunCode Bridge exposes current public Mission URL
        |
CurrentRouteRelayClient
        |
PUT /r/<stable-path-token>/admin/route
        |
GET /r/<stable-path-token>/admin/route
        |
Relay now forwards /mcp to the new exact Mission URL
~~~

The GET after PUT is a deliberate read-after-write verification. When Quick Tunnel reconnects with another hostname, BridgeManager.onDidChangePublicUrl triggers the same publication automatically. The ChatGPT connector URL does not change. The selected Mission id is kept in workspaceState as transport configuration; no ephemeral binding or Worker generation is persisted. At startup the selected Mission is reconciled with TaskRuntime and its new Bridge URL is published again.

The alias does not grant authority: the Bridge resolves it to the currently admissible binding on each request. Until a fresh current Worker binding is prepared, requests return 404. Old protocol sessions stay bound to their old generation and must reinitialize; they are not silently rebound to a replacement Worker.

## 3. Ownership boundaries

The Relay is transport-only. It owns only one pointer: the current exact public Mission MCP URL.

It does not own Project or Mission state, Worker assignment, WorkerSession identity, capability schemas, capability grants or approval, the Task execution ledger, completion judgment, provider transcript, or retry/replay policy.

Those remain on the existing Nimora owners. The Relay never turns the base Bridge MCP route into Mission authority.

_shuncode.projectFormation.prepareNativeMcp remains the canonical composition seam. When the Relay is configured:

- directPublicUrl is the current direct tunnel/Mission URL.
- publicUrl becomes the stable Relay MCP URL.
- currentRouteRelay reports the verified Relay generation and target.

When the Relay is not configured, existing behavior is preserved and publicUrl remains the direct Mission URL.

## 4. Security model

The Relay uses two independent secrets.

ROUTE_PATH_TOKEN is the stable capability path used by the ChatGPT connector. It prevents exposing a guessable root /mcp endpoint and appears in the stable connector URL.

ROUTE_UPDATE_SECRET authorizes changing or reading the Relay upstream pointer. It is sent only as a Bearer credential to the admin route and is stored by ShunCode in VS Code SecretStorage, not in workspace files.

The root /mcp route returns 404. Only the following capability path forwards provider MCP traffic:

~~~text
/r/<ROUTE_PATH_TOKEN>/mcp
~~~

The admin route additionally requires ROUTE_UPDATE_SECRET.

The Relay validates that upstream targets use HTTPS and contain no embedded credentials, query string, or fragment. Update verification fails closed if the Relay reads back a different target.

## 5. Cloudflare deployment

Reference implementation:

~~~text
tools/nimora-current-route-relay/worker.mjs
tools/nimora-current-route-relay/wrangler.toml.example
~~~

The implementation uses one SQLite-backed Cloudflare Durable Object so route updates and subsequent MCP requests observe one strongly consistent pointer rather than an eventually-consistent global cache.

Cloudflare documentation:

- https://developers.cloudflare.com/durable-objects/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

One-time setup:

~~~text
cd tools/nimora-current-route-relay
copy wrangler.toml.example wrangler.toml
npx wrangler login
npx wrangler secret put ROUTE_PATH_TOKEN
npx wrangler secret put ROUTE_UPDATE_SECRET
npx wrangler deploy
~~~

Use independent high-entropy values for the two secrets.

If deployment returns:

~~~text
https://nimora-current-route.<account>.workers.dev
~~~

and ROUTE_PATH_TOKEN is <random-stable-token>, the Relay base configured in ShunCode is:

~~~text
https://nimora-current-route.<account>.workers.dev/r/<random-stable-token>
~~~

The one-time ChatGPT MCP URL is:

~~~text
https://nimora-current-route.<account>.workers.dev/r/<random-stable-token>/mcp
~~~

Do not configure ChatGPT to the admin route.

## 6. ShunCode setup

Run:

~~~text
ShunCode: Configure Nimora Current Route Relay
~~~

Provide the Relay base URL including /r/<ROUTE_PATH_TOKEN> and ROUTE_UPDATE_SECRET.

ShunCode persists only the non-admin Relay URL as application configuration. The update secret goes to SecretStorage.

Other commands:

~~~text
ShunCode: Show Nimora Current Route Relay Status
ShunCode: Clear Nimora Current Route Relay
~~~

The application setting is:

~~~text
shuncode.bridge.currentRouteRelayUrl
~~~

The setting alone is insufficient; the corresponding update secret must also exist in SecretStorage.

## 7. Runtime behavior

After initial setup, normal recovery is:

~~~text
computer / ShunCode starts
-> Bridge starts
-> Cloudflare Quick Tunnel obtains a fresh random hostname
-> Nimora prepares the current exact Mission-native binding
-> ShunCode forms the exact direct Mission URL
-> Relay pointer is updated
-> Relay pointer is read back and verified
-> prepareNativeMcp advertises the stable Relay MCP URL
-> ChatGPT continues using the same connector URL
~~~

If cloudflared reconnects during the same runtime and gets another hostname:

~~~text
Bridge public URL changes
-> onDidChangePublicUrl fires
-> ShunCode republishes the same active Mission binding through the new direct URL
-> ChatGPT stable connector URL remains unchanged
~~~

Repeated events for an already verified target are deduplicated.

## 8. Failure behavior

Relay synchronization is not allowed to invent authority.

- No selected canonical active Mission: nothing is published.
- A selected active Mission without a fresh binding: its transport alias may be published, but MCP requests return 404 until canonical binding preparation; no Worker assignment or execution is invented.
- No current public Bridge URL: nothing is published.
- Relay not configured: old direct behavior remains.
- Relay configured but update secret missing, update failure or verification mismatch: explicit relay configuration fails; non-strict Mission preparation returns the truthful direct alias instead of claiming a verified stable route.
- Tunnel temporarily disappears: the old Relay target is left untouched until a new current URL exists; no side-effecting Mission command is replayed.
- Changing the Relay pointer does not retry any MCP tool call.

Existing provider MCP sessions may still need to reconnect after their upstream transport disappears. The Relay removes the connector URL reconfiguration problem; it does not pretend that an already-dead provider session can be resurrected without a new MCP initialization.

## 9. Tests

Dedicated gate:

~~~text
npm run test-shuncode-current-route-relay
~~~

It verifies stable Relay URL construction, first publication, duplicate suppression, Quick Tunnel target rotation, HTTPS-only target validation, stale read-after-write failure, hidden root /mcp, admin authentication, route persistence, MCP POST forwarding, mcp-session-id preservation, and response header preservation.

Preservation gates used during implementation:

~~~text
npm run typecheck-shuncode
npm run test-shuncode-phase11-native-mcp
npm run test-shuncode-phase11-production-routing
npm run test-shuncode-bridge-startup-decoupling
~~~

The implementation intentionally does not modify Phase-8 capability ownership or the Phase-11 exactly-once/replay rules.

## 10. Human-intervention boundary

There are still two legitimate one-time account boundaries:

- authenticate and deploy the Cloudflare Worker and enter its secrets;
- point the ChatGPT custom MCP connector at the stable Relay MCP URL once.

After that, Quick Tunnel hostname rotation is intended to be machine-owned:

~~~text
detect -> publish -> verify -> continue
~~~

Routine restarts should not require a human to edit a ChatGPT connector URL.

## 11. 2026-09-30 free deployment / recovery checkpoint

- Deployed `nimora-current-route.nimora-current-route-relay.workers.dev`, using the existing SQLite DO implementation and a Free-compatible migration. No paid plan, purchased domain or ngrok was configured.
- Uploaded two independent random secrets with Wrangler; bootstrap values are private and must not be committed or printed. ShunCode update secret belongs in SecretStorage.
- Real public health 200 / configured=false, unauthorized admin 401 at initial deployment. These are reachability/authentication checks, not Mission workspace execution.
- Fixed a remaining integration gap: automatic relay publication now uses `mission-current/<missionId>` rather than `/mission/<ephemeral-token>`, recovers the selected Mission from workspaceState, validates it against canonical TaskRuntime, and republishes on Bridge readiness and public-URL changes.
- Added canonical `npm run compile-shuncode -- --extension-only` support for extension-only changes: it preserves runtime/native artifacts, avoiding destructive cleanup of a locked addon. This is not a substitute for the full build when runtime/native source changes.
- Fresh PASS: typecheck, extension-only build, relay client/worker, native MCP alias/retirement, user-entry, production-routing, Bridge startup, runtime, capability registry and WorkerSessionManager gates. Real URL rotation and provider RWV still need execution.
- Both public and trusted MCP preparation now use the same `publishMissionMcpConnection` path, including explicit relay synchronization after selection and exact Mission target verification. Independent review and all three narrow relay/native-MCP gates PASS; actual HTTP generation isolation and provider execution remain pending.
- The human saved the update secret in SecretStorage and renewed all three page shares. A normal Restart Extension Host then loaded PID25752 while retaining those shares; loaded extension SHA256 matches disk `1C19988A864E3B4CC6CB0C3F388CF52A865BA6E889070C71D563D37319F2693E` through read-only inspection.
- Coordinator recovered through the public picker to `65b78e7a-2023-4d19-a4a8-226da53c2892`, current owner incarnation `22372dd5-2658-4918-a50a-1199ac6b4b30`. Old owner was canonically retired as `orphan-owner-death`. No new provider request or fixture write occurred.
- The preceding live PID24948 and old ephemeral connector URL are historical. Never replay consumed proof pairs or the afternoon failed UUID requests merely to retry transport.

### Real rotation acceptance, 20:47 Asia/Shanghai

The human installed **Nimora Stable** against the fixed Worker URL. After refreshing the formal Target, its menu entry and exact composer chip were observed. Normal public Stop/Start Bridge changed the Quick Tunnel host from `night-gauge-technical-vault.trycloudflare.com` to `cement-indexed-carmen-pledge.trycloudflare.com`. The production URL-change handler automatically published generation 2, with the same fixed connector URL and the same root Mission alias. No manual pointer update or connector edit was used for this rotation.

Real post-rotation HTTP checks: initialize 200, initialized 202, tools/list 200 with the selected 10 read/edit/validation tools, same-session base route 403, retired historical binding 404, and diagnostic session deletion 200. These are transport/metadata checks, not provider workspace execution. Evidence: `.build/phase11-free-relay-checkpoint.json`, `phase11-free-relay-http-current.json`, and the current Extension Host log.

Loaded extension hash evidence is saved as `.build/phase11-free-relay-loaded-hash.json`. Coordinator and Target share current owner PID25752; Target session is `59ff6c68-8b81-434f-b1af-b4ca59429384`. Full process restart with fresh binding and old-session isolation, and real provider RWV remain separate pending acceptance. Phase11 remains OPEN.


## 2026-09-30 — Exact browser identity and post-crash recovery

The fixed connector URL is unchanged. Fresh post-crash health returned200/configured=true/generation2, but initialize returned530. This is a stale upstream publication, not current route readiness. Restore canonical Mission ownership and prepare/publish the current exact Mission route before provider execution; never substitute the generic ShunCode Bridge base MCP route for Mission-scoped authority. The user has supplied the current generic Bridge URL, while the isolated Gateway log still references an obsolete ngrok upstream. Prior real tunnel Stop/Start rotation PASS remains historical evidence; full machine-restart acceptance is pending.


## 2026-09-30 — Latest post-crash generation3 publication

Canonical Worker recovery and normal prepare/publish advanced the fixed relay to generation3. Fresh initialize200, initialized202, tools/list200 and DELETE own diagnostic session200; evidence: .build/phase11-postcrash-relay-http.json. Earlier generation2 initialize530 is historical. Connector URL unchanged. This is host metadata readiness, not provider RWV or zero-touch resurrection of retired Worker identities. New ordinary request stopped at Coordinator before Target execution. Latest handoff: PHASE11_LATEST_HANDOFF_2026-09-30.md.
