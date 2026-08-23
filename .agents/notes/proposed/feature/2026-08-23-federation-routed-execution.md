# Agent Note: Routed execution for federated sessions

Status: proposed

English | [中文](2026-08-23-federation-routed-execution.zh.md)

Four decisions are finalized (see the decision record inside). Phases 1 (live view) and 2 (execution routing + takeover retirement) have shipped; this proposal stays active as the design record for phase 3 (cross-pod owner routing).

## Problem

The federation requirement model is:

1. A hub session executes on the hub; every pod can see it, and what a pod sees is live-synchronized with the hub.
2. A pod session executes on the pod; a pod can operate its own sessions, hub sessions, and other pods' sessions.

The pre-proposal implementation was built on the **takeover model**: a pod opening a hub session materialized a copy and resumed it locally, migrating execution to the pod. The `remoteAuthority` targeted catch-up and detached `models` were patches that fixed reading but not the model itself — the executor migrated, and nothing was live. The federation wire layer was never the problem: `session/subscribe` streaming, idempotent `session/send`, the approval loop, capability routing, hub→pod targeted requests (`delegateToPod`), and `session/persist` all already implemented the correct semantics. What was missing was wiring: the pod's api-proxy broadcast only local events into the mux, `session.prompt` went through local materialization + resume instead of `session/send`, and the hub's session sources knew nothing about pod sessions, so no cross-pod routing existed.

## Proposal

Execution routes to the session's owning node; every other node views and commands. Three serial phases, each independently mergeable:

### Phase 1 — live view (read path). Shipped.

A pod's Web client opening a hub session matches the hub view event by event, including in-flight `assistant/chunk` streams. The api-proxy establishes a remote event bridge when a history read serves a remote-authority session: a `sessionSources.subscribeEvents` subscription targeted at the stamped authority, whose events re-broadcast as ordinary mux `session/event` frames (Web client unchanged); baseline joins via the detached read at `fromSeq = tail + 1`; cold sessions hold their subscription until activation on the hub. Projection baselines keep the detached fold; folding live increments is deferred phase-1b work.

### Phase 2 — execution routing (write path). Shipped.

The pod api-proxy routes remoteAuthority sessions' Agent-bound verbs over the wire: `session.prompt` rides `session/send` (the request `rpcId` as idempotency key; steer and image prompts refused explicitly), `updateQueue`/`cancel`/`selectModel` ride three new wires (`session/queue-update`, `session/cancel`, `session/select-model`), rename refuses outright, and an offline link fails loudly — never local execution. The hub binds a writer source registered by the host gateway: sends cold-start inside the send chain under exactly the hub Web RPC composition, model switches land in the same selection seat local switches use. Takeover retires: the shared agent resolver refuses every non-local identity, no new copies materialize, and stamped copies keep their catch-up as an offline cache only.

### Phase 3 — cross-pod operations (owner routing). Remaining.

The hub becomes the session-owner router. Ownership registration: pods report their session inventory on connect (header summaries + ownership claims); the hub maintains a `sessionKey → ownerPod` routing table, removed on disconnect; `session/list`, `session/get`, and `session/subscribe` aggregate these inventories through a new pod-owned remote source beside the local one. Execution forwarding: `session/send` follows today's path for hub-live agents and forwards over the owner pod's connection otherwise (reusing the `delegateToPod` request-response pattern), recording the originating pod as commander. Event backflow: live events of pod-owned sessions stream up to the hub over a new `session/stream-forward` wire; the hub validates seq continuity, writes to persistence, and fans out. Whole-log `session/persist` remains the sync method for inactive sessions. Consistency boundary: an offline owner's sessions are read-only, and sends answer `owner-offline` — symmetric with writer-offline.

### Takeover retirement checklist

| Item | Disposition |
|---|---|
| `agentFor` materialization + local resume for remote-authority sessions | Removed in phase 2 |
| `remoteAuthority` stamp + targeted catch-up | Demoted to the offline-cache path; no new materializations |
| Existing materialized copies | Physical purge awaits a delete operation on the persistence seam (core-seam change, review first); growth has stopped |
| Detached `models` branch | Kept; after phase 2 it is the only path |

### Decision record

1. **Writer cold start**: B — the hub auto-resumes on a send with no live agent; only a failed resume answers `writer-offline`.
2. **Pod session visibility**: A — a pod reports its full session inventory on connect and maintains it incrementally; visible from every node.
3. **Existing materialized copies**: A — unify on remote reads + live streaming; `remoteAuthority` demotes to the offline-cache path.
4. **Phase 2 RPC coverage**: B — complete in one pass: prompt via `session/send` plus three new control wires, all reusing request/response, commander registration, and command-role checks.

## Alternatives considered

**Keep the takeover model and patch observability onto it.** Rejected: patches fixed reading but left execution migrated and nothing live; the model contradicted the requirement no matter how the reads converged.

**Let the hub duplicate the gateway's resume logic for cold starts.** Rejected: preset composition rebuilt from the log lives in the host gateway; duplicating it invites drift, so the hub binds the gateway's resolver through a writer-source seam instead of copying the logic.

**Route verbs through the hub's ApiProxy handlers with synthetic RpcRequests.** Rejected: those handlers are shaped around the browser envelope and error schema; mirroring small verb cores against the live agent keeps one honest implementation each without importing host types into a capability package.

**Physically purge existing materialized copies now.** Deferred: the persistence seam has no delete operation, and adding one is a core-seam change requiring its own review; growth stopped and copies degraded to caches meanwhile.

## Acceptance criteria

- Phase 1: while a hub session generates, a pod UI sees chunks arrive live; hub renames update pod titles live; reconnect resumes streaming from the break without duplicates or gaps.
- Phase 2: a pod prompt grows the hub log and streams the full turn back through the bridge; approvals appear on the commanding pod; two pods observing one session behave identically.
- Phase 3: pod-1 messaging pod-2's session executes there and is visible live on the hub and both pods; stopping pod-2 leaves its history readable and sends answering `owner-offline`.

## Risks

Phase 3 carries the largest risk: `stream-forward` seq-continuity validation and pod-reconnect compensation (reusing the `fromSeq` semantics aligns with `session/persist`'s existing validation approach). Phase 2's approval loop had a working precedent and stayed low-risk. Known fidelity costs accepted along the way: `clientTimeZone` provenance does not survive `session/send`, image content needs inline transport before routed prompts can carry it, and rename/delete stay hub-side operations.
