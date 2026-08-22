# @deepseek-ai/dsh-session-source-federation

[English](README.md) | 中文

`@deepseek-ai/dsh-session-source` 的远端联邦会话源提供者。通过 WebSocket 将边缘 pod 接入远端中心 federation hub，提供会话发现、检查、搜索、实时事件流订阅、fork-to-local 与 push-to-hub。

## Service Role

- **Capability Seam**：会话源提供者（联邦 / 远端）
- **Provides**：在 `ctx.sessionSources` 上注册 `'remote'` SessionSource
- **Consumer Packages**：Edge pod runtime、Web UI 多源资源管理器

## Configuration

| 键 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | 必填 | 远端中心 federation hub 的 WebSocket 端点 URL。 |
| `token` | 可选 | 字面量身份认证 bearer token。 |
| `tokenEnv` | 可选 | 包含身份认证 token 的环境变量名。 |
| `ownerPodId` | 可选 | 注册时声明的归属 pod 身份；token 由注册表绑定到某 pod 时必填。 |
| `ownerPodIdEnv` | 可选 | 持有归属 pod 身份的环境变量名（如 `DSH_POD_ID`）。 |
| `sourceId` | `federation-hub` | 唯一定义的会话源标识符。 |
| `sourceName` | `Hub Sessions` | 本会话源的显示名称。 |
| `connectTimeoutMs` | `5000` | 连接建立超时时间（毫秒）。 |
| `requestTimeoutMs` | `10000` | 单次请求响应超时时间（毫秒）。 |
| `autoReconnect` | `true` | 断线时是否自动尝试重新连接。 |
| `reconnectDelayMs` | `2000` | 重新连接尝试前的延迟时间（毫秒）。 |

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

本提供者不注册模型提示词、工具或 schema。模型通过 `tool_subagent` 与会话引用等高级工具与会话生命周期进行交互。

#### Token effect

无直接 token 开销。远端会话代理与事件流订阅不会向模型上下文贡献 token。

#### KV Cache effect

无。远端会话源操作不会改变模型请求前缀或 prompt 缓存。

## Known Limitations and Deferred Work

- **Fork 只复制日志，不复制工作区** — `/fork_to_local` 把子会话写入本地持久化。工作区文件不会随会话同步；命令结果会说明会话连续性不是工作连续性。
- **未知必读事件拒绝接手** — 格式版本不是 `SESSION_FORMAT_VERSION`，或含有未知且非 `ignorable` 事件类型的日志会被拒绝，而不是猜测。
- **删除与重命名仍是本地操作** — 远端 delete/rename 不会被代理。
- **降级回退** — 与 hub 断开连接时，会话列表与搜索将返回降级的缓存视图直至重连成功；实时订阅在收到 `federation/registered` 后从 `lastSeq + 1` 续订。
