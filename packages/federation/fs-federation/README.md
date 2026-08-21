# @deepseek-ai/dsh-fs-federation

English | [中文](README.zh.md)

Federation `FileSystem` provider: delegates `ctx.fs` filesystem operations to a target remote pod over the federation WebSocket transport. In Cloud Hub mode, the hub delegates tools/file operations to an edge worker pod; in Peer mode, an agent on Pod A can access workspaces located on Pod B.

This plugin occupies `ctx.fs`. A context mounts one filesystem backend (`dsh-fs-local`, `dsh-fs-e2b`, or `dsh-fs-federation`).

## Service Role

- **Capability Seam**: Filesystem Service Provider (Federation / Remote execution)
- **Provides**: `ctx.fs` delegating calls to `targetPodId`
- **Consumer Packages**: Cloud Hub and Peer Pod runtimes executing file tools against edge workspaces

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `targetPodId` | required | Target pod identifier where the actual filesystem operations execute. |
| `timeoutMs` | `15000` | RPC request timeout in milliseconds. |

```yaml
- id: fs-federation
  name: '@deepseek-ai/dsh-fs-federation'
  config:
    targetPodId: pod-worker-1
    timeoutMs: 15000
```

`resolve`, `stat`, `lstat`, `readText`, `streamText`, `readBytes`, `listDir`, `writeText`, and `editText` are forwarded as `capability/request` messages and executed by the target pod's local filesystem provider (`dsh-fs-local`). Binary bytes are encoded in Base64 across the wire. Errors are mapped back into typed `FsError` instances.

## Model Experience

### Remote workspace operations

#### What the model sees

The model interacts with filesystem tools (`read_file`, `write_to_file`, `replace_file_content`, `list_dir`) identically to a local backend. Path displays, diffs, and error diagnostics reflect the remote pod workspace.

#### Token effect

Zero extra tokens. Response shapes and error envelopes match the local filesystem contract.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Network dependency** — filesystem operations fail loud (`FS_DISCONNECTED`) if the target pod goes offline.
- **Single filesystem per context** — one context mounts one `ctx.fs` provider. Multi-pod routing uses subagent delegation (`dsh-subagent-remote`).
