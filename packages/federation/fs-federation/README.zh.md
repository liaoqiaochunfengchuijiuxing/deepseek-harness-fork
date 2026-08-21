# @deepseek-ai/dsh-fs-federation

[English](README.md) | 中文

联邦 `FileSystem` 提供者：通过联邦 WebSocket 传输协议将 `ctx.fs` 文件系统操作委托给目标远程节点执行。在 Cloud Hub 模式下，Hub 将工具/文件操作委托给边缘工作节点；在 Peer 模式下，Pod A 上的智能体可以访问位于 Pod B 上的工作空间。

此插件占用 `ctx.fs`。一个上下文挂载一个文件系统后端（`dsh-fs-local`、`dsh-fs-e2b` 或 `dsh-fs-federation`）。

## 服务角色

- **能力接缝**：文件系统服务提供者（联邦 / 远程执行）
- **提供**：将调用委托给 `targetPodId` 的 `ctx.fs`
- **消费者包**：针对边缘工作区执行文件工具的 Cloud Hub 和 Peer Pod 运行时

## 配置

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `targetPodId` | 必填 | 实际执行文件系统操作的目标节点标识符。 |
| `timeoutMs` | `15000` | RPC 请求超时时间（毫秒）。 |

```yaml
- id: fs-federation
  name: '@deepseek-ai/dsh-fs-federation'
  config:
    targetPodId: pod-worker-1
    timeoutMs: 15000
```

`resolve`、`stat`、`lstat`、`readText`、`streamText`、`readBytes`、`listDir`、`writeText` 和 `editText` 会作为 `capability/request` 消息转发，并由目标节点的本地文件系统提供者（`dsh-fs-local`）执行。二进制字节通过 Base64 在网络上传输。错误会映射回类型化的 `FsError` 实例。

## 模型体验

### 远程工作空间操作

#### 模型可见内容

模型与文件系统工具（`read_file`、`write_to_file`、`replace_file_content`、`list_dir`）的交互与本地后端完全一致。路径展示、diff 和错误诊断反映远程节点工作空间。

#### Token 影响

零额外 token。响应结构和错误包装与本地文件系统契约完全匹配。

#### KV Cache 影响

无影响。

## 已知限制与延后工作

- **网络依赖** — 如果目标节点离线，文件系统操作会明确失败（`FS_DISCONNECTED`）。
- **每个上下文单一文件系统** — 一个上下文挂载一个 `ctx.fs` 提供者。多节点路由使用子智能体委托（`dsh-subagent-remote`）。
