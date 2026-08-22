# @deepseek-ai/dsh-federation-hub

[English](README.md) | 中文

面向多节点 DeepSeek Harness 联邦的中心控制面服务插件。管理已连接 pod 的注册表，为外拨接入的设备与 subagent 委派提供带鉴权的 WebSocket 端点，追踪心跳保活状态，并在节点间分发执行路由。

## 架构与职责

1. **Pod 注册表（`ctx.federationHub`）：** 维护已连接 pod 的实时记录，包含唯一 `podId`、可读名称 `name`、声明的能力集 `capabilities`（工作区路径、沙箱模式、支持工具）、权限级别 `role` 以及 `online` / `offline` 状态。
2. **WebSocket 网关：**
   - `/federation/connect`：Pod 接入端点。通过 per-pod Bearer token 校验鉴权，注册 pod 元数据，并维持周期性心跳应答。
   - `/federation/subagent`：委派执行端点。接收来自远程委派方（如 [`dsh-subagent-remote`](../../subagent/subagent-remote/README.md)）的 `subagent/start`。带 `targetPodId` 的 start 会中继到该已注册 pod（pod↔pod）；否则 hub 选择一台在线 pod。chunk 与 stop/abort 走同一对 socket。
3. **心跳与保活管理：** 监测 pod 心跳；在超过可配置的 `heartbeatTimeoutMs` 未收到心跳时将 pod 标记为 `offline`，并以明确错误原因结算所有在途委派。
4. **只读会话线：** 已认证的 pod 可通过 `ctx.sessionSources` 列出、搜索、检查并订阅 hub 会话。插件需要该服务；bundle 同时挂载 `dsh-session-source` 与 `dsh-session-source-local`。未认证的升级一律拒绝。
5. **命令级会话发送：** 持有 `command`（或更高）token 的 pod 可通过 `session/send` 把消息送进活着的写者节点 inbox。同一会话的发送按到达顺序执行。重复的 `clientMessageId` 返回首次接受的 message id。没有活 agent 时以 `writer-offline` 失败；`read` token 以 `unauthorized` 失败。一次成功的发送把该 pod 记为该会话的指挥者。被替换连接的过期 close 不会把后继连接标成离线；重连后同一 `clientMessageId` 仍幂等。
6. **审批与问询路由：** hub 前置注册 `approval/request` 监听器，并拦截 `ctx.userQuestions.ask`。当请求 agent 属于被指挥会话时，hub 经该 pod 连接转发并认领结果。没有指挥者、指挥者离线或无应答时 fail-closed（审批为 `unavailable`，问询为 `COMMANDER_UNAVAILABLE`），不会落到 hub 本地 UI。审批在途断线结算为 `unavailable`，绝不自动批准。`interactionTimeoutMs`（默认 `300000`）限制往返时限。
7. **会话持久化与写者租约：** 持有 command 能力的 pod 可通过 `session/persist` 把事件批次写入 hub 现有的 `ctx.sessionPersistence`（hub profile 挂载的 JSONL 或 SQLite）。已存储的 seq 会被跳过。写者租约（`session/lease-acquire` / `session/lease-release`）记录唯一写者；其他 pod 持有租约时 persist 与 acquire 以 `stale-writer` 失败。pod 离线会释放其租约。persist 载荷只携带会话 id、header 与事件——凭据不会出现在这条线上。
8. **Per-pod 令牌注册表：** 在静态 `token`/`tokens` 配置之外，hub 还会查询位于 `tokensPath`（默认 `$DSH_HOME/federation/tokens.json`，属主只读 `0600`）的持久注册表。铸造出的令牌把一个密钥绑定到唯一 pod 身份与角色；注册 pod 的 `podId` 与绑定不符时以 `POD_IDENTITY_MISMATCH` 拒绝。吊销在下次连接即生效，无需重启 hub。用 `dsh federation-token issue|list|revoke`（以 hub 的 `$DSH_HOME` 运行）管理——issue 命令只向 stdout 打印一次密钥，绝不经过会被持久记录的会话转录。

## 模型体验

### 远程 subagent 委派路由

#### 模型所见

本包不向模型请求注入任何 prompt 文本、系统消息或工具声明。当父级 agent 通过 `tool_subagent` 使用 `remote` 提供方（经由 [`dsh-subagent-remote`](../../subagent/subagent-remote/README.md)）发起委派时，hub 服务端在 WebSocket 线上将执行请求分发至目标 pod。

#### Token 影响

hub 插件本身不消耗任何模型 token。被委派的 subagent 执行在目标 pod 上运行，消耗该 pod 自身的模型路由与凭据。

#### KV Cache 影响

中立：本包不引入任何静态 prompt 前缀或动态上下文注入。

### 审批与问询转发

#### 模型所见

写者节点会话仍会追加本地的 `approval/asked` / `approval/decided` 审计事件对。指挥 pod 上的模型看不到这次转发的提示。

#### Token 影响

hub 插件与指挥 pod 上为零。写者节点支付该操作获准或拒绝之后产生的任何 follow-up。

#### KV Cache 影响

中立：审计事件仅记日志，不进入模型 transcript。

## 已知限制与延后工作

- 多租户 token 吊销策略与细粒度访问控制列表不在 v3 范围内；注册表按 pod 身份吊销整张凭据。
- Web UI 铸造界面延后：把新密钥打印进 hub 会话转录会将其持久记录在日志里，因此 CLI stdout 是唯一认可的通道。
- Pod 间对等直连传输协商延后至 M5 里程碑。
