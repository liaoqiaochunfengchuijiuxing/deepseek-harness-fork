# Agent Note: Remote-authority stamped materialized session copies

Status: implemented

English | [中文](2026-08-23-federation-remote-authority-catchup.zh.md)

## Problem

A pod that opens a hub session materializes it into local persistence (the resume path's `persistence.create` + `append`) so `agents.resume` can prepare from the local store. From then on the pod's reads were frozen at materialization time: `inspectApiRemoteSession` returns the local copy on every later history read, and the designed catch-up (`readRemoteSession` through the `sessionSources` aggregate) never saw the hub either — the aggregate scans sources in registration order and the pod's local source answers first with the same stale copy. Observed live: the hub's session grew to 990 events while a pod's view stayed at 517 with no path to converge.

## Decision

Materialized copies carry their origin. `SessionHeader` gains `remoteAuthority?: string` — the id of the session source the copy was materialized from. `readRemoteSession` now reports the answering source's id, and `inspectApiRemoteSession`'s remote arm stamps it onto the header it returns, so `agentFor`'s materialization writes the marker through the existing `persistence.create(inspected.meta)` call with no separate write path.

Reads honor the stamp instead of trusting the registry scan. When `inspectApiRemoteSession` finds a local copy stamped `remoteAuthority`, it fetches directly from that source (the aggregate's `getSession(sessionId, sourceId)` hint path, which bypasses the local source entirely), appends the remote suffix through the existing prefix-checked `appendRemoteSuffix`, and serves the refreshed local inspection. Unstamped local sessions keep today's early return unchanged — one aggregate round trip is never spent on pod-authored sessions. The catch-up is fail-soft: an unreachable or throwing authority serves the stale copy, which remains a valid strict-prefix snapshot.

The resume path's own catch-up branch now distinguishes the two cases: stamped copies were already caught up by the `inspectApiRemoteSession` call that precedes the resume (retrying it would be a second hub round trip with no new information), while unstamped local copies keep the registry-scan catch-up for compositions without a shadowing local source.

Both persistence backends round-trip the field: the JSONL backend's `HeaderLine` serialize/parse pair carries `remoteAuthority`, and the SQLite backend stores it as the `remote_authority` column (monotonic `SCHEMA_VERSION` bump 17 → 18; older databases are rejected as before, per the no-migration pre-release stance).

Viewing must not attach a writer. The Web composer's model seat calls `session.models` on every session view open (ModelSelect's mount effect), and that handler resumed an Agent through `agentFor` — so merely opening a hub session on a pod attached a live agent whose in-memory event log then served every later history read, freezing the view at attach time regardless of the detached catch-up. `session.models` now serves remote-authority sessions (a stamped local copy, or an identity no local store knows) DETACHED: the current selection folds from the caught-up log via `foldRequestHeader` — the same source the attached arm reads when no in-process override exists — and no agent is resumed. A live agent (a deliberate takeover through `session.prompt` or `session.selectModel`) still serves through the agent, preserving the takeover path.

## Alternatives considered

**Make the aggregate prefer remote sources over local.** Rejected: every pod-authored session lookup would pay a federation round trip before the hub answers "unknown id", and the aggregate's first-hit-wins scan is the cheap path local sessions rely on.

**Mark materialized copies in a side table instead of the header.** Rejected: the header is the one record that travels with the log through persistence, backup, and restore; a side table can drift from the session files it describes and adds a second durable store to keep consistent.

**Catch up inside the local session source.** Rejected: the source would need write access to the persistence seam's session mid-read, and the read path (`agent-lookup`) already owns the prefix-check-and-append reconciliation logic.

## Consequences

A pod's view of a hub session converges on the next read after the hub grows, without re-materializing. Divergence keeps its single-writer meaning: a copy the pod wrote to (a prompted hub session running on the pod) fails the deep-equal prefix check and is served as-is, exactly as before. Two limitations remain deliberate: mid-generation materialization can diverge (the resume repairs the dangling step/turn with local closers, which never prefix-match the hub's real continuation — reconciling that is the deferred lease-protocol work), and copies materialized before this change carry no stamp, so an operator deletes those once to let the next open re-materialize a stamped copy.
