# Agent Note: 联邦会话的路由式执行

Status: proposed

[English](2026-08-23-federation-routed-execution.md) | 中文

四项决策已拍板（见文内决策记录）。阶段 1（实时视图）与阶段 2（执行路由 + 接管退役）已落地；本提案保持活跃，作为阶段 3（跨 pod 所有者路由）的设计记录。

## 问题

联邦的需求模型是：

1. hub 会话在 hub 执行；任意 pod 可见，且 pod 所见与 hub 实时同步。
2. pod 会话在 pod 执行；pod 可操作自己的会话、hub 的会话、其他 pod 的会话。

提案前的实现建立在**接管模型**上：pod 打开 hub 会话即物化副本并本地 resume，把执行迁移到 pod。`remoteAuthority` 定向追赶与 detached `models` 是修"读"的补丁，但模型本身与需求矛盾——执行主体迁移了，而且没有实时性。联邦 wire 层从来不是问题：`session/subscribe` 流、幂等 `session/send`、审批回路、capability 路由、hub→pod 定向请求（`delegateToPod`）、`session/persist` 都已具备正确语义。缺的是接线：pod 的 api-proxy 只向 mux 广播本地事件；`session.prompt` 走本地物化 + resume 而非 `session/send`；hub 的会话源对 pod 会话一无所知，跨 pod 路由无从谈起。

## 提案

执行路由到会话属主节点；其余节点只读与指挥。三个串行阶段，各自独立可合入：

### 阶段 1——实时视图（读路径）。已落地。

pod 的 Web 客户端打开 hub 会话时逐事件与 hub 一致，含生成中的 `assistant/chunk` 流。api-proxy 在 history 读到 remote-authority 会话时建立远端事件桥：以带标记权威为目标的 `sessionSources.subscribeEvents` 订阅，其事件以普通 mux `session/event` 帧重播（Web 客户端零改动）；基线经 detached 读取按 `fromSeq = 尾部 + 1` 衔接；冷会话持有订阅直至 hub 端激活。投影基线沿用 detached 折叠；实时增量折叠为推迟的 1b 工作。

### 阶段 2——执行路由（写路径）。已落地。

pod api-proxy 把 remote-authority 会话的 Agent 绑定动词送上 wire：`session.prompt` 走 `session/send`（请求 `rpcId` 作幂等键；steer 与含图 prompt 显式拒绝）；`updateQueue`/`cancel`/`selectModel` 走三条新 wire（`session/queue-update`、`session/cancel`、`session/select-model`）；rename 直接拒绝；链路离线响亮失败——绝不本地执行。hub 绑定宿主网关注册的 writer source：发送在同会话链内冷启动，组装与 hub Web RPC 完全一致；模型切换落进与本地切换相同的选择席位。接管退役：共享 agent 解析器拒绝一切非本地身份，不再产生新副本，带标记副本的追赶仅作离线缓存。

### 阶段 3——跨 pod 操作（所有者路由）。待做。

hub 升级为会话所有者路由器。所有权注册：pod 连接时上报会话清单（header 摘要 + 所有权声明）；hub 维护 `sessionKey → ownerPod` 路由表，断线摘除；`session/list`、`session/get`、`session/subscribe` 经新增的 pod-owned 远端源聚合这些清单，与本地源并列。执行转发：`session/send` 对 hub 活 agent 走现行路径，否则经属主 pod 连接转发（复用 `delegateToPod` 的请求-响应模式），发起 pod 登记为指挥者。事件回流：pod 会话的活事件经新 wire `session/stream-forward` 上行；hub 校验 seq 连续性后写入持久层并扇出。整段 `session/persist` 仍是非活跃会话的同步方式。一致性边界：离线属主的会话只读，发送应答 `owner-offline`——与 writer-offline 对称。

### 接管退役清单

| 项 | 处置 |
|---|---|
| `agentFor` 对 remote-authority 会话的物化 + 本地 resume | 阶段 2 删除 |
| `remoteAuthority` 标记 + 定向追赶 | 降级为离线缓存路径；不再产生新物化 |
| 既有物化副本 | 物理清除待 persistence seam 的 delete 操作（core seam 变更，先重审）；增长已停止 |
| detached `models` 分支 | 保留；阶段 2 后它是唯一路径 |

### 决策记录

1. **writer 冷启动**：B——hub 遇 send 无活 agent 自动 resume；仅 resume 失败回 `writer-offline`。
2. **pod 会话可见性**：A——pod 连接时全量上报清单并增量维护；全局任意节点可见。
3. **既有物化副本**：A——统一走远端读 + 实时流；`remoteAuthority` 降级为离线缓存路径。
4. **阶段 2 RPC 覆盖面**：B——一次补齐：prompt 走 `session/send` 加三条控制 wire，全部复用 request/response、指挥者登记与 command 角色检查。

## 已否决的替代

**保留接管模型，只在可观测性上打补丁。** 否决：补丁修好了读，但执行已迁移且没有实时性；无论读取如何收敛，模型都与需求矛盾。

**让 hub 为冷启动复制网关的 resume 逻辑。** 否决：从日志重建 preset 组装的逻辑在宿主网关里；复制必然漂移，所以 hub 经 writer-source seam 绑定网关解析器而非拷贝逻辑。

**伪造 RpcRequest 复用 hub 的 ApiProxy handler。** 否决：这些 handler 围绕浏览器信封与错误 schema 成形；对活 agent 镜像少量动词核心，每个动词只有一份诚实实现，也不必把宿主类型引入能力包。

**立即物理清除既有物化副本。** 推迟：persistence seam 没有 delete 操作，补齐属 core seam 变更需单独评审；期间副本停止增长并降级为缓存。

## 验收标准

- 阶段 1：hub 会话生成中，pod UI 实时看到 chunk；hub 改名 pod 标题实时更新；断线重连从断点续流无重复无缺口。
- 阶段 2：pod 发消息使 hub 日志增长并经桥回流完整回合；审批出现在指挥 pod；两个 pod 观察同一会话行为一致。
- 阶段 3：pod-1 向 pod-2 会话发消息在其上执行，hub 与两个 pod 实时可见；停掉 pod-2 后历史仍可读，发送应答 `owner-offline`。

## 风险

阶段 3 风险最大：`stream-forward` 的 seq 连续性校验与 pod 重连补偿（复用 `fromSeq` 语义可与 `session/persist` 既有校验思路对齐）。阶段 2 的审批回路有现成先例，风险低。沿途接受的保真度成本：`clientTimeZone` 来源不随 `session/send` 存活；图片内容需先有内联传输路由 prompt 才能携带；rename/delete 仍是 hub 侧操作。
