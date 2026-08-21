# @deepseek-ai/dsh-session-source

[English](README.md) | 中文

`ctx.sessionSources` 上的会话源 Service Definition 与多源注册表。为本地持久化存储与远端联邦节点提供统一的发现、列表、搜索和事件订阅接口。

## Service Role

- **Capability Seam**：会话源（Session Sources）服务定义
- **Service Name**：`ctx.sessionSources`
- **Consumer Packages**：Web Client、ACP/CLI 会话列表、Federation Hub、Federation Pod Client

## Configuration

本服务定义接收空配置对象：

```yaml
- id: session-sources
  name: '@deepseek-ai/dsh-session-source'
```

## Model Experience

### Session discovery and aggregation

#### What the model sees

本服务不注册模型提示词、工具或 schema。模型通过 `tool_subagent` 与会话引用等高级工具与会话生命周期和委派进行交互。

#### Token effect

无直接 token 开销。宿主平面会话聚合不会向模型上下文贡献 token。

#### KV Cache effect

无。会话发现不会改变模型请求前缀或 prompt 缓存。

## Known Limitations and Deferred Work

- **内存源注册表** — 动态会话源必须在启动时或实时联邦连接期间注册。
- **无分页多源列表** — 跨所有源的列表在内存中合并打平。
