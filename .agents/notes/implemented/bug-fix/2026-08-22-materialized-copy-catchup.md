# Agent Note: Materialized federation session copies catch up on cold resume

Status: implemented

English | [中文](2026-08-22-materialized-copy-catchup.zh.md)

## Problem

The BFF materializes a federation-sourced session into local persistence before a cold resume, because `agents.resume` prepares only from the local durable store. That copy was write-once: a snapshot taken at the first cold resume. Hub-side appends after that moment never reached the pod, so every later cold resume reconstructed the session from an increasingly stale log while the hub held newer events — history loaded, but ended early.

## Decision

The same cold-resume path in `createApiRemoteAgentResolver` now reconciles before resume. When the identity already exists locally, it reads the session through the session-sources seam and appends the remote suffix the local copy lacks — but only when the local log is a strict deep-equal prefix of the remote log (`isDeepStrictEqual` per event, in order). A local log that diverged in content at the same seq positions, or already covers the remote events, is left untouched: under the single-writer model a same-seq content divergence means two owners each wrote one log, and reconciling that is lease-protocol work, not this read path's. A local identity no remote source knows is an ordinary local session and never pays a reconciliation read.

Both remote reads (the first materialization's inspect fallback and this catch-up) share one `readRemoteSession` helper that unwraps the aggregate `SessionSourcesService` `{ source, session }` shape and the bare single-source shape, replacing the shape-discrimination logic that previously lived inline in `inspectApiRemoteSession`.

The suffix append satisfies the persistence seam's contiguous-seq contract by construction: the local tail's next-seq is exactly the first suffix event's seq.

## Alternatives considered

**Compare seq order only.** Rejected: two append-only logs written by different owners can share a seq prefix while carrying different events at those positions; content equality is the actual prefix claim being relied on.

**Delete and re-materialize the stale copy.** Rejected: it destroys any local writes the copy may legitimately hold and rewrites the full log when only the suffix is missing.

**Subscribe the local copy to the remote event stream.** Rejected: continuous sync belongs to the M2 mirror stream and M4 lease protocol; this path only needs the copy current at the moment of resume.

## Consequences

Each cold resume of a federation-sourced identity performs one extra remote full-log read plus an O(n) deep comparison — bounded, one-shot, and off the interactive path (inside the resume promise). The catch-up is idempotent: a current copy appends nothing. Behavior for local-authored sessions and first-time materialization is unchanged. The stale-copy window between two cold resumes still exists (this is pull-at-resume, not push); closing it needs the lease protocol's ownership transfer.

Because a materialized copy also shows up in the remote source's listing, `sessions.list` merges the two into one row instead of emitting a duplicate: the locally served entry (attached or cold) keeps its cwd, projections, and liveness, and gains the remote markers plus the fresher remote `updatedAt`. A session the remote source lists but the host does not serve locally keeps the read-only remote-only view.
