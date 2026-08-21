# @deepseek-ai/dsh-federation-client

English | [中文](README.zh.md)

Data-plane client plugin for multi-node DeepSeek Harness federation. Connects edge pods (local workstations, developer laptops, on-premise compute nodes) outward to a central federation hub, advertises local capabilities, exchanges heartbeats, and executes delegated subagent tasks using the pod's local agent engine.

## Architecture & Responsibilities

1. **Outbound Connection & Reconnect Loop:** Connects to the hub's `/federation/connect` endpoint over WebSocket with Bearer authentication. Reconnects automatically with exponential backoff on network interruptions.
2. **Capability Advertisement:** Upon connection, sends a `federation/register` handshake with the pod's `podId`, `name`, permitted `workspaces`, available `tools`, and `sandboxModes`.
3. **Heartbeat Liveness:** Sends periodic `federation/heartbeat` messages at configured intervals (`heartbeatIntervalMs`) to maintain online status in the hub's pod registry.
4. **Delegated Task Execution:** Receives `subagent/start` messages from the hub, checks workspace constraints, executes tasks locally using the pod's own credentials and model routing, streams deltas via `subagent/chunk`, and returns final results via `subagent/stop`.
5. **Cancellation & Abort:** Listens for `subagent/abort` messages to cancel in-flight tasks via `AbortController` and clean up running processes.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | required | WebSocket URL of the federation hub (e.g. `ws://hub.internal:3080/federation/connect` or `wss://...`). |
| `podId` | required | Unique identifier for this pod in the federation cluster (e.g. `pod-mac-1`). |
| `name` | required | Human-readable display name for this pod (e.g. `MacBook Pro`). |
| `token` | optional | Literal Bearer authentication token; prefer `tokenEnv`. |
| `tokenEnv` | optional | Credential reference (environment variable name) providing the token. |
| `heartbeatIntervalMs` | `5000` | Heartbeat interval in milliseconds. |
| `reconnectDelayMs` | `2000` | Initial reconnect delay in milliseconds. |
| `maxReconnectDelayMs` | `30000` | Maximum reconnect delay cap in milliseconds. |
| `workspaces` | optional | Allowed workspace directory roots. If unspecified, execution is ambient. |
| `tools` | optional | List of supported tool names. |
| `sandboxModes` | optional | List of supported sandbox execution modes. |
| `role` | `command` | Declared capability role (`read`, `command`, `manage`, or `takeover`). |

```yaml
- id: federation-client
  name: '@deepseek-ai/dsh-federation-client'
  config:
    endpoint: ws://127.0.0.1:3080/federation/connect
    podId: pod-developer-workstation
    name: Dev Workstation
    tokenEnv: DSH_POD_TOKEN
    workspaces:
      - /Users/developer/projects
```

## Model Experience

### Delegated subagent execution on pod

#### What the model sees

The pod agent receives the delegated subagent `prompt` (delivered via `subagent/start`) as a fresh session turn, running with the pod's local system prompt, installed tools (`tool_bash`, `tool_fs`), and local filesystem context. It receives no parent conversation history from the delegating node.

#### Token effect

The pod pays for its own context window and token usage using its own local credentials and model route. Token usage is optionally reported back in the final `subagent/stop` result.

#### KV Cache effect

Neutral to the delegating parent. On the pod, local execution follows the normal append-only KV cache lifecycle of fresh subagent sessions.

## Known Limitations and Deferred Work

- Interactive multi-turn continuation over the federation client is deferred to milestone M2/M3.
- Persistent session caching and checkpoint upload to hub is scheduled for milestone M4.
