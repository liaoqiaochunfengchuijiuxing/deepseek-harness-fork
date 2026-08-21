# @deepseek-ai/dsh-subprocess-federation

[English](README.md) | 中文

联邦 `SubprocessRuntime` 提供者：通过联邦 WebSocket 传输协议将 `ctx.subprocess` 子进程与终端执行委托给目标远程节点。

此插件占用 `ctx.subprocess`。一个上下文挂载一个子进程后端（`dsh-subprocess-local`、`dsh-subprocess-e2b` 或 `dsh-subprocess-federation`）。

## 服务角色

- **能力接缝**：子进程服务提供者（联邦 / 远程执行）
- **提供**：将进程树和终端委托给 `targetPodId` 的 `ctx.subprocess`
- **消费者包**：在边缘节点上执行 bash/shell 工具的 Cloud Hub 和 Peer Pod 运行时

## 配置

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `targetPodId` | 必填 | 实际执行子进程的目标节点标识符。 |
| `timeoutMs` | `15000` | RPC 请求超时时间（毫秒）。 |

```yaml
- id: subprocess-federation
  name: '@deepseek-ai/dsh-subprocess-federation'
  config:
    targetPodId: pod-worker-1
    timeoutMs: 15000
```

`resolveExecutable`、`spawn` 和 `spawnTerminal` 会被转发到远程节点。进程 stdio（收集的文本或原始管道流）通过 WebSocket 帧流式传输。终端支持交互式输入写入、前台进程组检查、信号传递（`SIGINT`）以及完整会话清理。

## 模型体验

通过 Consumer 间接影响模型，例如 `dsh-tool-bash` 背后的 Bash 执行器；这些 Consumer 会渲染远程输出、退出事实、后台增量和 spill 路径。

#### KV Cache 影响

不会直接失效；请求前缀变更由具名消费方负责。

## 已知限制与延后工作

- **网络依赖** — 如果目标节点在执行期间断开连接，子进程执行会明确失败。
- **环境清理** — 敏感凭据（如 `DEEPSEEK_API_KEY`）在远程节点执行前会被自动过滤。
