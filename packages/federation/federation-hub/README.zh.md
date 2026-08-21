# @deepseek-ai/dsh-federation-hub

[English](README.md) | 中文

面向多节点 DeepSeek Harness 联邦的中心控制面服务插件。管理已连接 pod 的注册表，为外拨接入的设备与 subagent 委派提供带鉴权的 WebSocket 端点，追踪心跳保活状态，并在节点间分发执行路由。

## 架构与职责

1. **Pod 注册表（`ctx.federationHub`）：** 维护已连接 pod 的实时记录，包含唯一 `podId`、可读名称 `name`、声明的能力集 `capabilities`（工作区路径、沙箱模式、支持工具）、权限级别 `role` 以及 `online` / `offline` 状态。
2. **WebSocket 网关：**
   - `/federation/connect`：Pod 接入端点。通过 per-pod Bearer token 校验鉴权，注册 pod 元数据，并维持周期性心跳应答。
   - `/federation/subagent`：委派执行端点。接收来自远程委派方（如 [`dsh-subagent-remote`](../../subagent/subagent-remote/README.md)）的 `subagent/start` 消息，将执行路由至指定或在线的可用 pod，实时转发流式文本分块，并同步中断信号。
3. **心跳与保活管理：** 监测 pod 心跳；在超过可配置的 `heartbeatTimeoutMs` 未收到心跳时将 pod 标记为 `offline`，并以明确错误原因结算所有在途委派。
4. **只读会话线：** 已认证的 pod 可通过 `ctx.sessionSources` 列出、搜索、检查并订阅 hub 会话。插件需要该服务；bundle 同时挂载 `dsh-session-source` 与 `dsh-session-source-local`。未认证的升级一律拒绝。
5. **命令级会话发送：** 持有 `command`（或更高）token 的 pod 可通过 `session/send` 把消息送进活着的写者节点 inbox。同一会话的发送按到达顺序执行。重复的 `clientMessageId` 返回首次接受的 message id。没有活 agent 时以 `writer-offline` 失败；`read` token 以 `unauthorized` 失败。

## 模型体验

### 远程 subagent 委派路由

#### 模型所见

本包不向模型请求注入任何 prompt 文本、系统消息或工具声明。当父级 agent 通过 `tool_subagent` 使用 `remote` 提供方（经由 [`dsh-subagent-remote`](../../subagent/subagent-remote/README.md)）发起委派时，hub 服务端在 WebSocket 线上将执行请求分发至目标 pod。

#### Token 影响

hub 插件本身不消耗任何模型 token。被委派的 subagent 执行在目标 pod 上运行，消耗该 pod 自身的模型路由与凭据。

#### KV Cache 影响

中立：本包不引入任何静态 prompt 前缀或动态上下文注入。

## 已知限制与延后工作

- 多租户 token 吊销策略与细粒度访问控制列表将在后续里程碑（M3/M4）扩展。
- Pod 间对等直连传输协商延后至 M5 里程碑。
