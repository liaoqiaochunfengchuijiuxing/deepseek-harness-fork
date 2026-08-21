# Agent Note: Materialize session-source sessions before remote Agent resume

Status: implemented

English | [中文](2026-08-22-federation-remote-session-resume.zh.md)

## Problem

The Host BFF's `inspectApiRemoteSession` consumed `sessionSources.getSession(id)` as `{ header, events }`. The aggregated `SessionSourcesService` answers `{ source, session: { header, events } }`; only a single `SessionSource` returns the bare shape. A pod whose BFF inspected a hub session crashed with `TypeError: remote.events is not iterable`, so a federation-sourced session could not even render history.

Inspection alone did not make such a session servable. `ctx.agents.resume` reaches `sessionPersistence.prepare(id)`, which reads the local durable store, and a federation-sourced session exists only on the hub. A pod's cold resume therefore failed with `resume failed: session "..." not found`: history loaded, commands rejected.

## Decision

Both fixes live in `packages/api/remotes/src/agent-lookup.ts`.

`inspectApiRemoteSession` accepts both remote return shapes. A structural check unwraps the aggregate's `{ source, session }` wrapper when `session` is present and validates `header` and `events` before use, so the local-first path and both remote shapes converge on one `{ meta, events }` result.

The cold-resume path in `createApiRemoteAgentResolver` materializes an inspected session that no local persistence lists: after the subagent-ownership fences and before `ctx.agents.resume`, it checks `persistence.list()` membership and, for an absent identity, writes `persistence.create(inspected.meta)` followed by `persistence.append(sessionId, inspected.events)`. An already-local session is never rewritten, and the `resumes` promise map deduplicates concurrent resumes of one identity, so materialization runs at most once per cold identity.

The materialized copy is resume scaffolding, not ownership: the hub keeps the authoritative session and remains its single writer.

## Alternatives considered

**Change `SessionSourcesService.getSession` to return the bare shape.** Rejected: the wrapper names which source answered, and aggregate consumers need that; one BFF consumer's mismatch does not justify narrowing the seam's contract.

**Teach `ctx.agents.resume` to read through `sessionSources`.** Rejected: resume's prepare path is owned by `sessionPersistence`, and rerouting it would touch the core agent/session spine that federation work must not modify.

**Route through the M4 federation persistence provider (spool + upload).** Rejected: that provider serves a pod that authors sessions and uploads them to the hub. This path is the inverse — a read-side cold resume of a hub-authored session — and only needs a local copy so `prepare` succeeds.

## Consequences

A pod that resumes a hub session keeps a full local copy of that session's event log, so the pod's durable store grows by every federation session it serves. The copy is a snapshot taken at the first cold resume: hub-side appends after that moment are not replayed into it. The single-writer model is preserved because the copy only feeds the pod's resume, never a second writer.

The structural unwrapping is runtime shape discrimination at a boundary the BFF types inline (`ctx.get('sessionSources')` with a local cast, no package dependency). The inline union keeps both shapes explicit instead of asserting one; a future typed dependency on the session-source Service Definition can replace the cast and delete the check.
