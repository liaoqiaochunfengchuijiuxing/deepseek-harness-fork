# @deepseek-ai/dsh-federation-client

[English](README.md) | 中文

面向多节点 DeepSeek Harness 联邦的数据面客户端插件。将边缘 pod（本地工作站、开发者电脑、私有算力节点）向外单向连接至中心 federation hub，声明本地能力，维持心跳保活，并通过 pod 本地的 agent 引擎执行委派的 subagent 任务。

## 架构与职责

1. **外拨连接与重连循环：** 通过携带 Bearer 鉴权的 WebSocket 主动连接至 hub 的 `/federation/connect` 端点。在网络抖动或断线时采用指数退避机制自动重连。
2. **能力声明：** 建立连接后，发送 `federation/register` 握手报文，声明 pod 的 `podId`、`name`、允许的工作区目录 `workspaces`、可用工具 `tools` 以及沙箱模式 `sandboxModes`。
3. **心跳保活：** 按照配置的时间间隔（`heartbeatIntervalMs`）周期性发送 `federation/heartbeat` 心跳消息，维持 hub 注册表中的在线状态。
4. **委派任务执行：** 接收来自 hub 的 `subagent/start` 消息，校验工作区权限约束，使用 pod 本地的模型路由与凭据启动任务，通过 `subagent/chunk` 实时回传流式文本分块，并在完成后返回 `subagent/stop` 终态结果。
5. **任务中断与取消：** 监听 `subagent/abort` 消息，通过 `AbortController` 中断在途任务执行并清理资源。
6. **`/remote_send`：** 当挂载了 `ctx.commands` 时，注册一条人类命令，把 `<sessionId> <message>` 经 `session/send` 送到写者节点 inbox。断线、未授权、写者离线与非法发送返回错误结果，不会把文本当作本地模型 prompt 提交。

## 配置项

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | 必填 | 联邦 hub 的 WebSocket 端点 URL（例如 `ws://hub.internal:3080/federation/connect` 或 `wss://...`）。 |
| `podId` | 必填 | 该 pod 在联邦集群中的唯一标识（例如 `pod-mac-1`）。 |
| `name` | 必填 | 该 pod 的可读显示名称（例如 `MacBook Pro`）。 |
| `token` | 可选 | 字面量 Bearer 鉴权 token；优先建议使用 `tokenEnv`。 |
| `tokenEnv` | 可选 | 提供鉴权 token 的凭据引用（环境变量名称）。 |
| `heartbeatIntervalMs` | `5000` | 心跳发送间隔（毫秒）。 |
| `reconnectDelayMs` | `2000` | 初始重连退避延迟（毫秒）。 |
| `maxReconnectDelayMs` | `30000` | 最大重连延迟上限（毫秒）。 |
| `workspaces` | 可选 | 允许执行的工作区根目录列表。未指定时为环境默认目录。 |
| `tools` | 可选 | 支持的工具名称列表。 |
| `sandboxModes` | 可选 | 支持的沙箱执行模式列表。 |
| `role` | `command` | 声明的能力角色（`read`、`command`、`manage` 或 `takeover`）。 |
| `requestTimeoutMs` | `10000` | `session/send` 往返超时（毫秒）。 |

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

## 模型体验

### 在 Pod 上执行委派 Subagent

#### 模型所见

Pod 上的 agent 将收到的 subagent `prompt`（通过 `subagent/start` 报文接收）作为全新会话 turn 执行，使用 pod 本地的系统提示词、已安装工具（例如 `tool_bash`、`tool_fs`）及本地文件系统上下文。它不会收到委派方的上级历史对话。

#### Token 影响

Pod 消耗自身的上下文窗口和 token 额度，使用本地凭据和模型路由。Token 消耗情况可在终态 `subagent/stop` 结果中回传。

#### KV Cache 影响

对发起委派的父节点中立。在 pod 本地，执行遵循全新 subagent 会话的标准追加式 KV cache 生命周期。

### `/remote_send`

#### 模型所见

指挥 pod 上的模型看不到这条命令文本。写者节点会话在 inbox 里收到一条普通用户 follow-up；该内容在写者节点上对模型可见，并可从其会话日志重建。

#### Token 影响

指挥 pod 上为零。写者节点支付这次 follow-up turn。

#### KV Cache 影响

与指挥 pod 的请求缓存无关。写者节点的下一次请求随新的用户消息追加增长。

## 已知限制与延后工作

- 经 pod 连接的审批与问询路由递延至 T3.2。
- 会话落盘缓存与向 hub 的检查点上传递延至 M4。
