# @deepseek-ai/dsh-federation-hub

English | [中文](README.zh.md)

Central control-plane service plugin for multi-node DeepSeek Harness federation. Manages the connected pod registry, provides authenticated WebSocket endpoints for incoming device connections and subagent delegations, tracks heartbeat liveness, and routes execution between nodes.

## Architecture & Responsibilities

1. **Pod Registry (`ctx.federationHub`):** Maintains live records of connected pods, including unique `podId`, human-readable `name`, declared `capabilities` (workspaces, sandbox modes, tools), permission `role`, and `online`/`offline` status.
2. **WebSocket Gateway:**
   - `/federation/connect`: Pod connection endpoint. Authenticates incoming connections via per-pod Bearer tokens, registers pod metadata, and tracks periodic heartbeats.
   - `/federation/subagent`: Delegation endpoint. Accepts `subagent/start` messages from remote delegators (e.g. [`dsh-subagent-remote`](../../subagent/subagent-remote/README.md)), routes runs to designated or available online pods, streams chunks back, and forwards abort signals.
3. **Heartbeat & Liveness Management:** Monitors pod heartbeats; marks unresponsive pods `offline` after configurable `heartbeatTimeoutMs` and cancels in-flight delegations directed to unreachable pods with explicit error reasons.
4. **Read-only session wire:** Authenticated pods may list, search, inspect, and subscribe to hub sessions through `ctx.sessionSources`. The plugin requires that service; the bundle mounts `dsh-session-source` and `dsh-session-source-local` beside it. Unauthenticated upgrades are refused.
5. **Command-level session send:** A pod with a `command` (or higher) token may deliver `session/send` into a live writer-node inbox. Sends for one session run in arrival order. A repeated `clientMessageId` returns the first accepted message id. A missing live agent fails with `writer-offline`; a `read` token fails with `unauthorized`. A successful send records that pod as the session's commander. A replaced connection's stale close does not offline the live successor; after reconnect, the same `clientMessageId` is idempotent.
6. **Approval and question routing:** The hub prepends an `approval/request` listener and intercepts `ctx.userQuestions.ask`. When the requesting agent belongs to a commanded session, the hub forwards over that pod's connection and claims the outcome. A missing, offline, or silent commander fails closed (`unavailable` for approval, `COMMANDER_UNAVAILABLE` for questions) and does not fall through to the hub's local UI. Disconnect while an approval is pending is `unavailable`, never an auto-grant. `interactionTimeoutMs` (default `300000`) bounds the round-trip.

## Model Experience

### Remote subagent delegation routing

#### What the model sees

This package injects no prompt text, system messages, or tool declarations into model requests. When a parent agent invokes `tool_subagent` using the `remote` provider (via [`dsh-subagent-remote`](../../subagent/subagent-remote/README.md)), the hub server routes the execution request over WebSocket to the destination pod.

#### Token effect

No model tokens are consumed directly by the hub plugin. Delegated subagent executions run on the target pod using that pod's own model routing and credentials.

#### KV Cache effect

Neutral: this package introduces no static prompt prefixes or dynamic context injections.

### Approval and question forwarding

#### What the model sees

The writer-node session still appends the local `approval/asked` / `approval/decided` audit pair. The commanding pod's model does not see the forwarded prompt.

#### Token effect

Zero on the hub plugin and the commanding pod. The writer node pays for any follow-up that the granted or rejected action produces.

#### KV Cache effect

Neutral: audit events are log-only and are not in the model transcript.

## Known Limitations and Deferred Work

- Multi-tenant token revocation policies and granular access-control lists will be extended in future milestones (M3/M4).
- Direct peer-to-peer relay negotiation is deferred to milestone M5.
