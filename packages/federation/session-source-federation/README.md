# @deepseek-ai/dsh-session-source-federation

English | [中文](README.zh.md)

Remote Federation SessionSource provider for `@deepseek-ai/dsh-session-source`. Connects an edge pod to a remote federation hub over WebSocket, providing session discovery, inspection, search, live event stream subscriptions, fork-to-local, and push-to-hub.

## Service Role

- **Capability Seam**: Session Source Provider (Federation / Remote)
- **Provides**: Registers a `'remote'` SessionSource on `ctx.sessionSources`
- **Consumer Packages**: Edge pod runtime, Web UI multi-source explorer

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | required | WebSocket endpoint URL of the remote federation hub. |
| `token` | optional | Literal authentication bearer token. |
| `tokenEnv` | optional | Environment variable containing authentication token. |
| `ownerPodId` | optional | Owning pod identity claimed at registration; required when the token is registry-bound to a pod. |
| `ownerPodIdEnv` | optional | Environment variable holding the owning pod identity (e.g. `DSH_POD_ID`). |
| `sourceId` | `federation-hub` | Unique session source identifier. |
| `sourceName` | `Hub Sessions` | Display name for this session source. |
| `connectTimeoutMs` | `5000` | Connection timeout in milliseconds. |
| `requestTimeoutMs` | `10000` | Request timeout in milliseconds. |
| `autoReconnect` | `true` | Whether to automatically reconnect on disconnect. |
| `reconnectDelayMs` | `2000` | Delay before attempting reconnect. |

```yaml
- id: session-source-federation
  name: '@deepseek-ai/dsh-session-source-federation'
  config:
    endpoint: ws://127.0.0.1:3080/federation/connect
    tokenEnv: DSH_POD_TOKEN
    ownerPodIdEnv: DSH_POD_ID
    sourceId: federation-hub
```

## Model Experience

### Remote session queries and live streams

#### What the model sees

This provider registers no model prompts, tools, or schemas. The model interacts with session lifecycle and delegation through high-level tooling such as `tool_subagent` and session references.

#### Token effect

Zero direct token overhead. Remote session proxying and event streaming do not contribute tokens to model context.

#### KV Cache effect

None. Remote session source operations do not alter model request prefixes or prompt caching.

## Known Limitations and Deferred Work

- **Fork copies the log, not the workspace** — `/fork_to_local` writes a child session into local persistence. Workspace files are not carried; the command result states that session continuity is not work continuity.
- **Unknown required events refuse takeover** — a log whose format version is not `SESSION_FORMAT_VERSION`, or that contains an unknown non-`ignorable` event type, is rejected rather than guessed.
- **Delete and rename stay local** — remote delete/rename are not proxied.
- **Degraded fallback** — when disconnected from the hub, session listings and searches return degraded cached views until reconnection; live subscriptions resume from `lastSeq + 1` after `federation/registered`.
