# @deepseek-ai/dsh-subagent-remote

English | [中文](README.zh.md)

The remote subagent provider delegates execution of subagent runs over WebSocket to a remote endpoint — such as a cloud federation hub or an edge pod. It is the primary transport backend for hub-and-pod federation, providing a single wire protocol and disconnection vocabulary across all delegation directions (cloud-to-pod, pod-to-cloud, and pod-to-peer).

## Start and ownership

`start(request)` establishes (or reuses) a WebSocket connection to the configured `endpoint`, sending a `subagent/start` message with the delegated prompt, label, and working directory. The child's working directory resolves through the seam's shared out-of-process helpers ([`dsh-subagent`](../subagent/README.md)): the configured `cwd` override when set (validated at load), else the delegating parent session's workspace cwd — never the server process launch directory.

The run id is minted in the parent namespace. Streamed text deltas sent as `subagent/chunk` messages are accumulated into the assistant output. When the remote endpoint completes the task, it sends a `subagent/stop` message containing the final output blocks, stop reason, and optional token usage summary.

`dispose()` is idempotent: it settles the result locally as `aborted`, sends a `subagent/abort` message over the socket if open, and closes the WebSocket connection.

## Stop-reason mapping

The provider maps remote stop reason strings into the standard harness vocabulary: `completed` → `completed`, `max-tokens` → `max-tokens`, `aborted` → `aborted`; unknown reasons or disconnection errors map to `error`. Post-publication transport and connection failures flatten to `stopReason: 'error'` through the `onError` diagnostic sink (wired to `ctx.logger.warn`); the seam contract forbids `result` rejecting.

## Capabilities and context

The provider advertises no start-time capabilities (`outputSchema`/`depthLimit`/`toolFilter`/`persona` all false) and `inheritsParentContext: false`: the child runs on a separate node with its own model route and tools, and the only parent-derived input is the workspace cwd. Deployments using `dsh-tool-subagent` over this provider configure `maxDepth: 'provider-managed'`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `remote` | Registry name on `ctx.subagents`. |
| `endpoint` | required | WebSocket endpoint URL of the remote federation host (e.g. `ws://hub.internal:3080/federation/subagent` or `wss://...`). |
| `token` | optional | Literal authentication bearer token; prefer `tokenEnv`. |
| `tokenEnv` | optional | Credential reference (environment-variable name) resolved via `ctx.credentials` or ambient environment. |
| `cwd` | parent session cwd | Working-directory override. |
| `connectTimeoutMs` | `5000` | Bound (ms) on establishing WebSocket connection. |

```yaml
- id: subagent-remote
  name: '@deepseek-ai/dsh-subagent-remote'
  config:
    providerName: remote
    endpoint: ws://127.0.0.1:3080/federation/subagent
    tokenEnv: DSH_POD_TOKEN
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: remote
    toolName: subagent
    maxDepth: 'provider-managed'
```

## Model Experience

### Child-agent request

#### What the model sees

The remote node's model receives the delegated task as its user message plus that node's configured system prompt, tools, and session environment. It receives no parent conversation history. This provider advertises no start-time capabilities, so requests for persona, tool filtering, depth enforcement, or structured output are rejected before delegation.

#### Token effect

The remote agent pays for its own context window and multi-turn trajectory using its own credentials and model route. These tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Each remote execution uses its own model route and cache prefix; steps on the remote node grow append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the delegating parent receives only the remote subagent's final assistant text (or accumulated partial text) or that consumer's stop-reason error, without intermediate execution traces or tool calls.

#### Token effect

Parent input grows only by the final result or error message, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **One-shot runs only** — continuable background sessions over remote subagent connections are deferred to later federation milestones.
- **Single active socket per run** — persistent connection multiplexing across multiple concurrent subagent runs is deferred.
- **No credential transfer** — remote nodes execute using their own model credentials; tasks cannot forward delegator API keys across nodes.
