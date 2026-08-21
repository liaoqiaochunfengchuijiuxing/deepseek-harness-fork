# Agent Note: Remote federation sessions grouped by origin source in the sidebar

Status: implemented

English | [中文](2026-08-22-remote-session-sidebar-grouping.zh.md)

## Problem

A pod's sidebar listed hub sessions imported through the federation session source under "Ungrouped". Grouping matches a session's cwd against locally registered Workspaces, and a hub session's cwd names a host-side directory no pod Workspace registers. The grouping signal already existed end to end — the host BFF stamps every remote row with `sourceId`, `sourceName`, `isRemote`, `isDegraded`, `readOnly`, and the API, runtime, and UI types declare those fields — but the wire schema omitted them, so zod's default unknown-key stripping deleted them at the client parse, and the runtime's list projection never re-copied them into the store rows.

## Decision

Three layers close the gap, each carrying the fields it already owns:

- `sessionSummarySchema` (dsh-host-apiproxy) names the five optional remote markers, so the client-side response parse keeps them. The API type `SessionSummary` already declared the fields; the schema was stale against its own cast type.
- `SessionRuntime.projectList` copies `sourceId`, `sourceName`, `isRemote`, `isDegraded`, and `readOnly` from list entries into store rows, matching its existing per-field spread pattern.
- `groupByWorkspace` (dsh-client-ui-workspace) routes `isRemote` rows into one group per `sourceId` (key `remote:<sourceId>`, label `sourceName` with the key as fallback), placed after Workspace groups and ahead of the Ungrouped bucket. `GroupNode` gains a `remote?: true` derivation fact so the header renderer picks the source label instead of the "Ungrouped" dictionary entry; the exported `currentGroupKey(list, workspaces, sessionId)` helper is the one implementation both `deriveGroups` and the browser's auto-expand effect use to find the owning group, so a selected remote session tints and expands its `remote:` group instead of Ungrouped.

Remote groups deliberately degrade like the Ungrouped bucket everywhere `workspaceId` is absent: no rename/delete menu, no Workspace drag/hover card, no Host-order writes, and member order is recency only. Remote ids also stay out of the browser's Ungrouped order account.

## Alternatives considered

**Register a virtual Workspace per remote source.** Rejected: it fabricates Workspace entities in the Host's account model to solve a display concern, polluting workspace rename/delete/order semantics.

**Detect remote groups in the renderer by key prefix.** Rejected: the renderer would sniff the `remote:` string convention across the tree contract; the `GroupNode.remote` fact carries the classification instead.

**One global "Remote" group.** Rejected: with multiple federation sources (several hubs, or hub plus peer pods) a single bucket loses which origin each session came from, which is exactly the information the source name carries.

## Consequences

A pod's sidebar now shows one labeled group per federation source ("Hub Sessions" by default) instead of scattering remote sessions through Ungrouped, and selecting a remote session expands its own group. Remote rows keep the existing per-row remote/degraded badge. Remote groups support no manual reordering — their order is always recency — and no create-in-group action, since sessions there belong to another node. Grouping needs only client-visible fields, so the behavior is fully covered by keyless unit tests at each layer (schema parse, store projection, tree derivation) without a live federation deployment.
