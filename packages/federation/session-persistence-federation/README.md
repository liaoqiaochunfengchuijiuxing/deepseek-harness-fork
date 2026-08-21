# @deepseek-ai/dsh-session-persistence-federation

English | [中文](README.zh.md)

Federation `SessionPersistence` backend: each append is durable on a local JSON spool first, then uploaded asynchronously to the hub writer store. Hub unavailability does not fail a local turn. Resume and takeover use the same `append` / `readFrom` / `prepare` / revision path as the JSONL and SQLite backends.

This plugin occupies `ctx.sessionPersistence`. A context mounts one persistence backend; compose it in place of JSONL or SQLite on a roaming pod. The hub keeps its own JSONL or SQLite backend and applies `session/persist` batches to that store.

## Service Role

- **Capability Seam**: Session Persistence Provider (Federation / Remote upload)
- **Provides**: `ctx.sessionPersistence` with local spool plus async hub upload
- **Consumer Packages**: Edge pod runtime that must complete turns while the hub is unreachable

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `spoolRoot` | required | Directory for per-session JSON spool files. |
| `preparedSessionCacheSize` | `5` | Maximum unpublished Sessions retained after cold inspection for resume reuse. |
| `writeBatchMaxDelayMs` | `200` | Fixed live-event coalescing window. It is not a backend completion deadline. |

```yaml
- id: session-persistence-federation
  name: '@deepseek-ai/dsh-session-persistence-federation'
  config:
    spoolRoot: /var/lib/dsh/federation-spool
```

`locate(meta)` returns `{ kind: 'federation-spool', path }` for `<spoolRoot>/<id>.json`. The first durable append materializes the file. Upload sends events with `seq` greater than the last hub ack and includes the header until the hub has stored a prefix.

`prepare(id)` acquires the hub writer lease when `ctx.federationClient` is connected, then prepares the unpublished Session. A lease held by another pod rejects prepare as stale-writer. `releaseWriter(id)` releases the lease after a local flush so another node can acquire and resume.

`FederationSessionPersistence.assertTakeoverCompatible(events, version)` refuses a log whose format version is not `SESSION_FORMAT_VERSION`, or that contains an unknown required (non-`ignorable`) event type.

## Model Experience

### Resumed conversation history

#### What the model sees

This backend registers no live prompt or schema. Loading restores stored surface history the same way other persistence backends do; the new loop composes its current envelope. Recovery closers match the shared persistence contract (`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`).

#### Token effect

Zero live-request tokens. A resumed agent pays for retained history and its current envelope, plus quoted repair results for interrupted calls.

#### KV Cache effect

Spool and hub upload do not mutate live request prefixes. A resumed loop can reuse provider cache only when reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

- **Hub upload is best-effort** — a failed or disconnected upload leaves the local spool intact and retries the unacked prefix on a later append; turns never wait on the network.
- **One `ctx.sessionPersistence` per context** — this backend replaces JSONL/SQLite on the pod; the hub store is the hub profile's existing backend, not a second event-log schema.
- **Workspace files are not in the spool** — a resumed session without its workspace is conversation continuity, not work continuity.
- **Nothing deletes spool files** — logs accumulate under `spoolRoot` until removed externally.
