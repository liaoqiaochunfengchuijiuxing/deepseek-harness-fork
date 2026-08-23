# @deepseek-ai/dsh-session-source-local

[English](README.md) | 中文

`@deepseek-ai/dsh-session-source` 的本地会话源提供者。将进程内 `ctx.sessionPersistence`、投影服务以及 `ctx.sessionQuery` 接入统一的联邦多源 seam。

## Service Role

- **Capability Seam**：会话源提供者（本地）
- **Provides**：在 `ctx.sessionSources` 上注册 `'local'` SessionSource
- **Consumer Packages**：App profiles、Web UI、Federation Pod Client

## Configuration

本提供者接收空配置对象：

```yaml
- id: session-source-local
  name: '@deepseek-ai/dsh-session-source-local'
```

## Live event subscriptions

`subscribeEvents` 同时服务活会话与冷会话。活会话：重放 `fromSeq` 及之后的事件，并转发后续每次追加。冷会话（无活 store 条目——如已持久化但没有 Agent 持有的会话）：订阅保持打开并等待激活——当会话被发布（resume 会重新发布它）时，`fromSeq` 重放与转发随即开始，因此激活前已连接的订阅者仍能看到该会话从所请求 seq 起的全部事件。销毁仍处冷态的订阅会取消等待且无副作用。这让联邦 hub 能从会话首次在 hub 上运行的那一刻起向 pod 流式转发其事件，而不是只在恰好有活 Agent 时才可用。

## Model Experience

### Local session operations

#### What the model sees

本提供者不注册模型提示词、工具或 schema。模型通过 `tool_subagent` 与会话引用等高级工具与会话生命周期进行交互。

#### Token effect

无直接 token 开销。宿主平面会话持久化与查询不会向模型上下文贡献 token。

#### KV Cache effect

无。本地会话源操作不会改变模型请求前缀或 prompt 缓存。


## Known Limitations and Deferred Work

- **单节点作用域** — 仅覆盖当前活动进程本地存储的会话。
- **进程内协调** — 需要本地 `SessionPersistence` 或活跃的 `SessionStore` 来解析元数据。
