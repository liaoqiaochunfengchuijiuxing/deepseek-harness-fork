# @deepseek-ai/dsh-subagent-remote

[English](README.md) | 中文

远程 subagent 提供方通过 WebSocket 将 subagent 运行委派给远端端点（例如云端联邦 hub 或边缘 pod）执行。它是 hub-pod 联邦的核心传输后端，为所有委派方向（云端到 pod、pod 到云端、pod 到 peer）提供统一的 wire 协议和断线词汇。

## 启动与所有权

`start(request)` 建立（或复用）到配置的 `endpoint` 的 WebSocket 连接，发送携带被委派 prompt、标签和工作目录的 `subagent/start` 消息。子级的工作目录通过 seam 共享的进程外辅助工具（[`dsh-subagent`](../subagent/README.md)）解析：配置了 `cwd` 覆盖项时使用覆盖项（加载期校验），否则继承委派方父会话的工作区 cwd——绝不回退到宿主进程的启动目录。

返回的运行 id 在父级命名空间中铸造。以 `subagent/chunk` 消息下发的分块文本会累积到助手输出中。当远端端点完成任务时，它会发送包含最终输出块、停止原因和可选 token 用量摘要的 `subagent/stop` 消息。

`dispose()` 是幂等的：它在本地将结果结算为 `aborted`，在 socket 处于打开状态时通过 socket 发送 `subagent/abort` 消息，并关闭 WebSocket 连接。

## 停止原因映射

提供方将远端停止原因字符串映射到标准的 harness 词汇：`completed` → `completed`，`max-tokens` → `max-tokens`，`aborted` → `aborted`；未知的停止原因或连接断开故障映射为 `error`。发布后的传输和连接故障通过 `onError` 诊断接收器（接入 `ctx.logger.warn`）扁平化为 `stopReason: 'error'`；seam 契约禁止 `result` reject。

## 能力与上下文

提供方不声明任何启动期能力（`outputSchema`、`depthLimit`、`toolFilter`、`persona` 均为 false），且 `inheritsParentContext: false`：子级在拥有自身模型路由与工具的独立节点上运行，来自父级的唯一输入是工作区 cwd。在此提供方之上使用 `dsh-tool-subagent` 的部署配置 `maxDepth: 'provider-managed'`。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `remote` | `ctx.subagents` 上的注册名称。 |
| `endpoint` | 必填 | 远端联邦宿主的 WebSocket 端点 URL（例如 `ws://hub.internal:3080/federation/subagent` 或 `wss://...`）。 |
| `token` | 可选 | 字面量认证 Bearer token；建议使用 `tokenEnv`。 |
| `tokenEnv` | 可选 | 通过 `ctx.credentials` 或宿主环境解析的凭据引用（环境变量名）。 |
| `cwd` | 父会话 cwd | 工作目录覆盖。 |
| `connectTimeoutMs` | `5000` | 建立 WebSocket 连接的超时上限（毫秒）。 |

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

## 模型体验

### 子 agent 请求

#### 模型所见

远端节点的模型接收被委派的任务作为其用户消息，外加该节点配置的系统 prompt、工具和会话环境。它不接收父会话的历史记录。该提供方不声明启动期能力，因此对 persona、工具过滤、深度限制或结构化输出的请求在委派前即被拒绝。

#### Token 影响

远端 agent 使用其自身的凭据与模型路由支付自身上下文窗口与多轮轨迹的 token。这些 token 不会进入父级上下文。

#### KV 缓存影响

与父级请求缓存相互独立。每次远端执行使用自身模型路由与缓存前缀；远端节点上的 step 呈追加增长。

### 父级工具结果（间接）

#### 模型所见

通过 `dsh-tool-subagent`，委派方父级仅接收远端 subagent 的最终助手文本（或累积的部分文本）或该消费方的停止原因错误，而不接收中间执行轨迹或工具调用。

#### Token 影响

父级输入仅增加最终结果或错误消息，此内容取决于具体数据并保留至压缩。本提供方自身不增加父级 schema。

#### KV 缓存影响

追加写入；新可见内容接在可复用的请求前缀之后，不会使既有 KV 缓存条目失效。

## 已知局限与延后工作

- **仅限一次性运行**——跨远程 subagent 连接的可续跑后台会话延后至后续联邦里程碑。
- **每次运行单一活跃 socket**——跨多次并发 subagent 运行的持久连接多路复用已延后。
- **不传递凭证材料**——远端节点使用自身模型凭据执行；任务绝不跨节点转发委派方的 API key。
