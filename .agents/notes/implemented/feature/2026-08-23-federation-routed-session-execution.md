# Agent Note: Routed session execution across the federation

Status: implemented

English | [中文](2026-08-23-federation-routed-session-execution.zh.md)

## Problem

The pod still executed hub sessions locally. Opening a hub session materialized a copy and `agentFor` resumed a local writer, so a pod prompt migrated execution to the pod: the hub log stopped growing, other observers diverged, and the "session runs where it was created" model was violated at exactly the write path. The live bridge ([remote-authority live event bridge](2026-08-23-federation-remote-authority-live-bridge.md)) fixed reading; every verb that attached a writer — prompt, selectModel, updateQueue, cancel, rename, and any unguarded agent-bound RPC through the shared resolver — still took over.

## Decision

A remote-authority session never gains a local writer. Execution routes to its owning node; the commanding pod becomes the recorded commander and watches events through the live bridge.

**Pod routing (host gateway).** The api-proxy resolves each session's execution authority up front (`inspectApiRemoteAuthority`: stamped local row, else the aggregate source scan). A routed authority sends `session.prompt` through `session/send` with the request's `rpcId` as the idempotency key; steer prompts and image-bearing prompts are refused explicitly (steering a remote turn is unsupported until the wire grows it, and attachment references resolve only on the storing host). `updateQueue`, `cancel`, and `selectModel` ride three new wire verbs (`session/queue-update`, `session/cancel`, `session/select-model`); rename refuses outright. An absent federation client or a disconnected link fails the verb loudly — falling back to local execution would be the takeover model under another name.

**Writer cold start (hub).** The hub's `FederationHubService` accepts a bound writer source: the host gateway registers its shared agent resolver (`agentFor`) plus a selection applier. `session/send` for a session with no live agent resumes inside the per-session send chain, so the cold writer comes back under exactly the composition the hub's own Web RPC path composes; resume failure answers `writer-offline` (`session-not-found` maps to `invalid`). The three control verbs serialize behind sends on the same chain, require command-capable tokens, register the commander on success, and apply model switches through the writer source so they land in the same selection seat local Web switches use.

**Takeover retirement.** `createApiRemoteAgentResolver` refuses every identity the local durable store does not hold — stamped copies directly, and source-known identities even when the source names itself nowhere. No persistence row is created or appended on the resume path anymore. Existing stamped copies keep their inspect-time catch-up as an offline cache: reads stay fresh when the hub is reachable, degrade to the last snapshot when not.

## Alternatives considered

**Teach the hub to resume sessions itself (duplicate preset resolution).** Rejected: the composition logic that rebuilds an agent from its logged preset lives in the gateway; duplicating it would drift, so the resolver is bound, not copied.

**Reuse the hub's ApiProxy methods via synthetic RpcRequests.** Rejected: the handlers are shaped around the browser envelope and error schema; mirroring the small verb cores against the live agent keeps one honest implementation each without importing host types into a capability package.

**Physical purge of existing materialized copies.** Deferred: `SessionPersistence` has no delete operation, and adding one is a core-seam change that requires its own design review. Copies stop growing and serve only as offline caches in the meantime.

## Consequences

Prompting a hub session from a pod grows the hub's log, streams the full turn back through the bridge, and records the pod as commander — approvals and questions fail closed to the commanding pod exactly as `/remote_send` established. A pod cut off from the hub gets explicit errors instead of silent local execution, which is the observable difference between routing and takeover. Fidelity notes: `clientTimeZone` provenance does not survive `session/send`, image content requires inline transport before routed prompts can carry it, and rename/delete stay hub-side operations.
