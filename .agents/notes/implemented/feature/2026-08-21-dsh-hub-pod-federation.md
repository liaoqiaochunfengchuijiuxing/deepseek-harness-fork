# Agent Note: Hub-and-pod federation for multi-node DeepSeek Harness

Status: implemented

English | [中文](2026-08-21-dsh-hub-pod-federation.zh.md)

## Problem

DeepSeek Harness is a single-process, single-user, local-first workbench. A user who runs it on several machines cannot, today: open one node's session from another device and watch it progress in real time; continue work started on one node from another node; or let one node's agent hand a task to another node for execution. Sessions live in one process's memory with single-writer persistence on local files, the Web client is a same-process plugin tree bound to its host, and there is no node discovery, no cross-node transport, and no shared identity or authorization between instances.

Solving this with general distributed state replication would fight the product's own invariants: the session log is append-only with one logical order, `deriveMessages()` and every runtime invariant assume that order, and shipped persistence rejects a stale writer rather than merging concurrent ones. The design must deliver multi-node reachability and delegation without introducing multi-writer sessions.

## Decision

A **hub-and-pod federation**: one cloud **hub** as the control plane, any number of **pods** (machines or devices) as the data plane. The hub is itself a dsh instance running a federation profile - pod registry, dial-in relay, session store, token authentication. A pod is a dsh instance with a federation client plugin: it dials out to the hub over one persistent authenticated connection, declares its capabilities, and accepts delegated work.

Every interaction in the federation is one of exactly **two verbs**:

- **Session client** (human-driven): a pod or browser attaches to a live session owned by a remote node - sees the event stream in real time, sends messages, answers approvals. The session stays with its owner; the attached end is a remote control.
- **Delegation** (agent-driven): one node's model hands a bounded task to an agent on another node through the `ctx.subagents` seam. The session belongs to the delegator; execution and tools belong to the executing node.

Cloud-to-pod, pod-to-cloud, and pod-to-peer delegation are all the *same* mechanism: a remote subagent provider pointing at a different endpoint. One wire protocol, one authorization design, one disconnection vocabulary, three deployment directions.

## Topology and roles

- **Hub (cloud, control plane):** a dsh instance with a `federation` profile. Owns the pod registry (identity, capability declarations, presence), relays messages between pods (no inbound ports on pods), stores federated session logs, terminates token authentication, and runs the delegation endpoint other nodes call. It reuses the existing webserver, credentials, settings, and telemetry services rather than shipping a parallel stack.
- **Pod (device, data plane):** a dsh instance with a federation client plugin. Dials out to the hub with a per-pod token, keeps the connection alive, advertises what work it accepts (workspaces, sandbox mode, availability), executes delegated tasks with its own agent loop, model route, and credentials, and may render hub and peer sessions natively.
- **Connectivity direction:** pods always dial out; the hub never initiates a connection to a pod. Peer traffic initially relays through the hub's connection pair; direct pod-to-pod transport (overlay network, hole punching) is a later optimization.

## Session ownership and synchronization

A session has exactly one writer node at any time; all other ends are readers. "Full synchronization" is delivered by subscription, not replication:

- The writer's durable event batches stream to the hub as they are persisted (local spool first, async upload; network writes stay off the turn-critical path).
- Any node or browser subscribes to a session's stream through the hub and renders from its own projections - the existing "UI renders from the log" rule makes remote rendering data-driven, with no remote code delivery.
- Management operations (delete, rename, fork) execute at the owning node; a pod only initiates them.
- Taking work elsewhere is **fork-to-local** or **resume-after-release**: an ownership lease in the hub records the current writer; a handoff releases the lease after flush and the next node resumes from the stored log. Multi-master concurrent writing is out of scope by design.

## Pod modes

A pod mode is a composition choice (profile), not a separate product:

| Mode | Session lives on | Execution happens on | Shape |
|---|---|---|---|
| Cloud | hub | hub, with tools landing on pods or remote sandboxes | hub agent + pod as executor |
| Local | the pod itself | the pod itself | today's dsh web, unchanged |
| Peer | the delegating node | the addressed peer pod | remote subagent pointed at a peer |

Mode switching never migrates a live session; it starts a new session or fork plus a pointer handoff.

## Native experience: the federation session source

Remote sessions must appear in a pod's own UI as first-class objects, not as a browser tab elsewhere. A **federation session source** seam on the pod exposes the small, stable operation surface the product already has - workspace and session listing, full-text search, open-with-live-stream, fork/delete/rename, titles and todo projections, approvals - with two implementations: local (today's in-process services) and remote (proxied over the pod-hub connection). The remote implementation speaks a scoped subset of the same contract the hub's apiProxy already exposes to its own browser client, so one contract serves both.

Rendering degrades, never refuses: unknown conversation node kinds fall back to the existing generic card; the handshake exchanges versions and the UI marks sessions containing nodes this pod cannot render.

`fork-to-local` and its reverse fall out of this surface as ordinary menu operations - the handoff story becomes "open the same work somewhere else."

## Approval and question routing

A successful `session/send` records that pod as the session's commander. When the hub agent then hits the fail-closed `approval/request` waterfall or `ctx.userQuestions.ask`, the hub forwards over that command-capable connection and claims the outcome; a missing, offline, or silent commander fails closed and does not fall through to the hub's local UI. The pod answers through a programmatic answerer or the `federation/approval-request` / `federation/question-request` waterfalls. Delegated runs on an unattended pod run under that pod's permission preset (sandboxed workspace-write); with no answerer available the call fails closed, as today.

## Security model

- Per-pod tokens, minted and stored through the credentials seam; TLS everywhere.
- Token capability levels: `read` (list, search, live streams), `command` (send, answer approvals), `manage` (fork, delete, rename), `takeover` (resume to this node). Default issuance is `read`.
- Bidirectional capability declaration: a pod declares what work it accepts (workspaces, sandbox mode, schedule); the hub's registry declares what each pod may reach. Requests exceeding either declaration are rejected.
- Credentials, model routes, and settings never transfer between nodes. Delegation carries a task, not a key; each side pays its own model usage and reports it in the subagent result.

## Wire and versioning

The delegation wire reuses the subagent vocabulary (start, message, stop reasons, continuation, usage) over the pod-hub persistent connection. The management wire is the apiProxy browser-contract subset above. Handshakes exchange dsh versions; a federated session envelope records the version that wrote it. A node that does not recognize an event type refuses takeover of that session rather than guessing; live streams tolerate unknown renderable kinds per the degradation rule.

Workspace files are not carried by session sync. Work spans nodes through a shared git remote (the hub can host it); a session resumed without its workspace is conversation continuity, not work continuity, and the UI says so.

## Package inventory

| Package | Side | Role |
|---|---|---|
| `dsh-federation-hub` | hub | pod registry, relay, lease table, delegation endpoint, management-contract exposure |
| `dsh-federation-client` | pod | dial-out connection, capability declaration, delegation execution, session upload |
| `dsh-subagent-remote` | both | the `ctx.subagents` remote provider (one wire, all delegation directions) |
| `dsh-session-source` | both | `ctx.sessionSources` Service Definition and multi-source registry |
| `dsh-session-source-local` | both | local SessionSource wrapping live sessions and persistence |
| `dsh-session-source-federation` | pod | remote SessionSource over the pod-hub connection |
| `dsh-session-persistence-federation` | pod | local JSON spool plus async `session/persist` upload to the hub writer store |
| profile additions | both | `federation` (hub = base + web-app + federation-hub); pod = existing profile + federation-client |

## Phasing

v0 through v3 are in the tree; v4 remains.

- v0: hub with registry, dial-out connections, and `dsh-subagent-remote` server endpoint; pod client plugin; hub delegates to pods; pods reach hub sessions by browser.
- v1: read-level federation session source — native listing, search, live rendering of remote sessions on a pod, with source badges and generic-card fallback for unknown node kinds.
- v2: command level — `/remote_send`, approval/question routing to the commanding pod, in-flight disconnect fail-closed, and idempotent resend after reconnect.
- v3: manage and takeover — fork-to-local, lease handoff, bidirectional roaming.
- v4: peer relay, optional capability-server granularity (remote `ctx.fs`/`ctx.subprocess` providers, E2B-shaped), direct pod-to-pod transport.

## Alternatives considered

**Peer-to-peer federation without a hub.** Rejected as the primary shape: every pod would need its own discovery, NAT traversal, and an ownership protocol to decide who writes; the hub centralizes exactly those three concerns and keeps pods dial-out-only. A hubless LAN mode remains possible later as an optimization, not a foundation.

**Multi-master session replication (CRDT or otherwise).** Rejected: the session log's single logical order is load-bearing for `deriveMessages()`, replay, and invariants, and turns have causal order that does not commute. Subscription plus single-writer lease delivers the wanted observable behavior - every end sees everything in real time - without consensus machinery.

**Gateway proxying the entire Web GUI.** Rejected: the browser bundle is a per-host plugin tree (`ctx.clientModules`, slots, HMR); proxying it means federating frontend composition. Native rendering from projections with local renderers avoids remote code delivery entirely.

**A unified cross-instance tool registry.** Rejected: syncing every node's tools into each request's tool view bloats prompts and invalidates KV caches from the first changed schema token. Delegation through one stable tool (the remote subagent) keeps each model's view local.

**A curated handoff-context format.** Rejected: the session log already is the complete portable work state; summaries lose fidelity and drift. Handoff carries an envelope (metadata, versions) plus the raw log suffix.

**The hub as a standalone non-dsh service.** Rejected: it would re-implement authentication, configuration, storage, and telemetry that a dsh profile already has. Running the hub as a dsh instance keeps one operational vocabulary.

**Capability-server granularity first (hub agent executing every tool call on a pod).** Deferred rather than rejected: subagent-grained delegation ships first because it matches the existing seam and its continuation semantics; remote fs/subprocess providers remain the v4 refinement for fine-grained remote control.

## Consequences

v0, v1, v2, and v3 are in the tree:

- The hub registry lists pods with live presence. A remote subagent run returns a structured result and usage; a mid-run disconnect maps to a stop reason. Credentials never cross nodes; delegation results carry task output and usage only.
- Hub-owned sessions are reachable over the authenticated pod connection and the hub's own web profile. Unauthenticated upgrades are refused.
- On a pod, remote sessions appear in `ctx.sessionSources` listings with source identity; disconnect marks them degraded and reconnect resumes subscriptions from the last seq. Opening a remote session uses local renderers; unknown conversation node kinds keep the existing generic card.

A command-capable pod delivers `session/send` into a live writer-node inbox, in order, with `clientMessageId` idempotency; a missing live agent fails as `writer-offline`. A successful send records that pod as commander: hub `approval/request` and `ctx.userQuestions.ask` for that session forward over that connection and fail closed without an answerer. An in-flight disconnect never auto-grants; a replaced socket's stale close does not offline the live successor; a duplicate in-flight approval `requestId` is coalesced.

A roaming pod mounts `dsh-session-persistence-federation` as `ctx.sessionPersistence`: appends are durable on a local JSON spool first, then uploaded with monotonic seq resume. The hub applies `session/persist` to its existing JSONL or SQLite backend; leases live in memory on `FederationHubService`. `prepare` acquires the writer lease when the client is connected; a lease held by another pod fails as stale-writer; going offline releases that pod's leases. `/fork_to_local` copies a hub log into local persistence with identical `deriveMessages()`; unknown required event types and foreign format versions are refused. `/push_to_hub` uploads a local log. Persist payloads carry session id, header, and events — credentials never go on that wire. Peer relay remains out of tree.

## Testing

- M1: `packages/federation/federation-hub/tests/federation-e2e.spec.ts` boots a hub and pods over real WebSockets; `packages/subagent/subagent-remote/tests/subagent-remote.spec.ts` maps stop reasons against a mock endpoint.
- M2: `packages/federation/session-source-federation/tests/federation-e2e-m2.spec.ts` lists, inspects, searches, streams, degrades, and resumes a hub session from a pod. Local-source equivalence is in `packages/session/session-source-local/tests/session-source-local.spec.ts`. Source badges and unknown-node generic cards are in the client UI unit tests (`packages/client/ui-workspace/tests/rows.client.spec.tsx`, `packages/client/ui-conversation/tests/chat-branch-tails.client.spec.tsx`).
- T3.1: `packages/federation/federation-hub/tests/federation-hub.spec.ts` delivers ordered, idempotent `session/send` into a live agent inbox and fails `read` tokens and missing writers. `packages/federation/federation-client/tests/remote-send.spec.ts` runs `/remote_send` over a real WebSocket.
- T3.2: the same hub spec forwards approval and question payloads to the commander, claims outcomes, and fails closed when the commander is missing or silent; the client spec answers over a real WebSocket through programmatic answerers and the pod waterfalls.
- T3.3: `packages/federation/federation-hub/tests/federation-e2e-m3.spec.ts` delivers a command to the writer inbox, routes approval to the commander without auto-grant, fails a pending approval on disconnect, and resends the same `clientMessageId` after reconnect. The client spec coalesces a duplicate in-flight `requestId`.
- M4: `packages/federation/session-persistence-federation/tests/session-persistence-federation.spec.ts` appends locally when hub upload fails, retries the unacked prefix, and refuses unknown required events. Hub persist/lease unit tests skip stored seqs, reject stale writers, and release leases on offline. `packages/federation/federation-hub/tests/federation-e2e-m4.spec.ts` uploads a spool batch, enforces a live lease, forks with identical derived messages, and asserts persist payloads carry no credentials.

## Risks

- **The hub is a high-value target.** It can task every pod; a compromised hub token set is game over for the fleet. Mitigation is least-privilege defaults, capability declarations on both ends, and pods treating the hub as untrusted for anything beyond declared work.
- **Availability coupling.** Sessions must complete turns while the hub is unreachable - hence local-first spool with async upload, not synchronous remote persistence on the turn path.
- **Fleet version skew.** Envelope versioning and refuse-on-unknown make old pods safe but noisy; a fleet upgrade discipline (hub first) is an operational cost the design knowingly takes on.
- **Scope creep toward multi-master.** Every "just let both ends write" request must be answered with fork or lease handoff; the seam should make the supported path the easy path.
- **Latency of remote management.** Listing and search across a slow link can feel worse than local; caching projections pod-side is acceptable, local mutation of remote state is not.
- **Operational burden.** Someone now hosts and backs up the hub and its session store; for a single user this is real cost that a pure overlay-network deployment (every node reachable, one browser tab per node) would avoid - which is why that mode remains supported as the zero-development floor.
