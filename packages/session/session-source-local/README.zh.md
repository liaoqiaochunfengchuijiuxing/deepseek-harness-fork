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
