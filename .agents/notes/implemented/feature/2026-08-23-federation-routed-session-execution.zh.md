# Agent Note: 联邦会话的路由式执行

Status: implemented

[English](2026-08-23-federation-routed-session-execution.md) | 中文

## 问题

pod 此前仍在本地执行 hub 会话。打开 hub 会话会物化副本并由 `agentFor` 拉起本地写者，于是 pod 的 prompt 把执行迁移到 pod：hub 日志停止增长，其他观察者分叉，"会话在其创建处运行"的模型恰好在写路径上被破坏。[实时事件桥](2026-08-23-federation-remote-authority-live-bridge.md)修好了读；每一个会附着写者的动词——prompt、selectModel、updateQueue、cancel、rename，以及任何经共享解析器的无守卫 Agent 绑定 RPC——仍然在接管。

## 决策

远端权威会话绝不获得本地写者。执行路由到其属主节点；指挥 pod 成为登记的指挥者，并经实时桥观察事件流。

**pod 路由（宿主网关）。** api-proxy 预先解析每个会话的执行权威（`inspectApiRemoteAuthority`：先看带标记的本地行，否则聚合源扫描）。判定为路由会话后：`session.prompt` 经 `session/send` 转发（以请求 `rpcId` 作幂等键）；steer prompt 与含图 prompt 显式拒绝（远端转向尚无 wire 支持，附件引用只在存储侧可解析）；`updateQueue`、`cancel`、`selectModel` 走三条新 wire（`session/queue-update`、`session/cancel`、`session/select-model`）；rename 直接拒绝。缺 federation client 或链路断开时动词响亮失败——回退本地执行就是换了名字的接管模型。

**writer 冷启动（hub）。** hub 的 `FederationHubService` 接受绑定的 writer source：宿主网关注册它共享的 agent 解析器（`agentFor`）与选择席位应用器。`session/send` 遇到没有活 agent 的会话时在 per-session 发送链内 resume，冷写者按 hub 自身 Web RPC 完全一致的组装恢复；resume 失败应答 `writer-offline`（`session-not-found` 映射 `invalid`）。三个控制动词在同一条链上排在发送之后串行执行，要求 command 级 token，成功时登记指挥者；模型切换经 writer source 落进与本地 Web 切换相同的选择席位。

**接管退役。** `createApiRemoteAgentResolver` 拒绝一切本地持久层不持有的身份——带标记的副本直接拒绝；被远端源应答的身份即使源未自报姓名也拒绝。resume 路径不再创建或追加任何持久层行。既有带标记副本保留 inspect 时的追赶作为离线缓存：hub 可达时读保持新鲜，不可达时降级到最后快照。

## 已否决的替代

**让 hub 自己 resume（复制 preset 组装逻辑）。** 否决：从日志重建 agent 的组合逻辑在网关里，复制必然漂移，所以绑定解析器而非拷贝。

**伪造 RpcRequest 复用 hub 的 ApiProxy 方法。** 否决：这些 handler 围绕浏览器信封与错误 schema 成形；对活 agent 镜像少量动词核心，每个动词只有一份诚实实现，也不必把宿主类型引入能力包。

**物理清除既有物化副本。** 推迟：`SessionPersistence` 没有 delete 操作，补齐属 core seam 变更需单独设计重审。在此之前副本停止增长，仅作离线缓存。

## 后果

从 pod 向 hub 会话发消息会使 hub 日志增长、完整回合经桥回流、pod 登记为指挥者——审批与问询按 `/remote_send` 确立的语义 fail-closed 到指挥 pod。pod 与 hub 失联时得到明确报错而非静默本地执行，这正是路由与接管的可观察差异。保真度备注：`clientTimeZone` 来源不随 `session/send` 存活；图片内容需要先有内联传输，路由 prompt 才能携带；rename/delete 仍是 hub 侧操作。
