# @deepseek-ai/dsh-subprocess-federation

English | [中文](README.zh.md)

Federation `SubprocessRuntime` provider: delegates `ctx.subprocess` process and terminal execution to a target remote pod over the federation WebSocket transport.

This plugin occupies `ctx.subprocess`. A context mounts one subprocess backend (`dsh-subprocess-local`, `dsh-subprocess-e2b`, or `dsh-subprocess-federation`).

## Service Role

- **Capability Seam**: Subprocess Service Provider (Federation / Remote execution)
- **Provides**: `ctx.subprocess` delegating process trees and terminals to `targetPodId`
- **Consumer Packages**: Cloud Hub and Peer Pod runtimes executing bash/shell tools on edge pods

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `targetPodId` | required | Target pod identifier where subprocesses execute. |
| `timeoutMs` | `15000` | RPC request timeout in milliseconds. |

```yaml
- id: subprocess-federation
  name: '@deepseek-ai/dsh-subprocess-federation'
  config:
    targetPodId: pod-worker-1
    timeoutMs: 15000
```

`resolveExecutable`, `spawn`, and `spawnTerminal` are forwarded to the remote pod. Process stdio (collected text or raw pipe stream) is streamed over WebSocket frames. Terminals support interactive input writing, foreground process group inspection, signal delivery (`SIGINT`), and whole-session teardown.

## Model Experience

### Remote shell execution

#### What the model sees

The model interacts with bash/terminal execution tools identically to a local environment. Output text, exit codes, and cancellation semantics match the local subprocess execution world.

#### Token effect

Zero extra tokens.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Network dependency** — subprocess execution fails loud if the target pod disconnects during execution.
- **Environment scrubbing** — sensitive credentials (such as `DEEPSEEK_API_KEY`) are scrubbed by the remote pod prior to execution.
