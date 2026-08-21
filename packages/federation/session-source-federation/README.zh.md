# @deepseek-ai/dsh-session-source-federation

[English](README.md) | 中文

`@deepseek-ai/dsh-session-source` 的远端联邦会话源提供者。通过 WebSocket 将边缘 pod 接入远端中心 federation hub，提供只读会话发现、检查、搜索与实时事件流订阅。

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

- **只读操作** — 远端会话修改操作（fork、delete、rename）递延至后续管理里程碑。
- **降级回退** — 与 hub 断开连接时，会话列表与搜索将返回降级的缓存视图直至重连成功。
