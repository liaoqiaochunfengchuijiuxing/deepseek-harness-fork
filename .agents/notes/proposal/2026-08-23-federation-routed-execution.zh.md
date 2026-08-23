# 设计提案：联邦会话的路由式执行模型

Status: approved（四项决策已拍板，按阶段实施中）

中文提案；实施完成后按 Agent Note 规范转正式双语记录。

## 1. 需求模型

1. hub 的会话在 hub 执行；任意 pod 可见；pod 所见与 hub 完全实时同步。
2. pod 的会话在 pod 执行；pod 可操作：自己的会话、hub 的会话、其他 pod 的会话。

## 2. 偏差判定

当前实现（含 2026-08-23 的两个修复）建立在**接管式模型**上：pod 打开 hub 会话 → 物化副本 → 本地 `agents.resume` → pod 自己执行。`remoteAuthority` 定向追赶与 `models` detached 是该模型上的补丁——修好了"读"，但模型本身与需求矛盾（执行主体迁移了，且没有实时性）。

**偏差的定位**：走偏的不是联邦 wire 层——wire 层已经实现了正确的模型。走偏的是 pod 的 RPC 层（api-proxy 的 Agent-bound 方法）没有路由到这套 wire，而是走了本地 resume。

## 3. 现状盘点（已验证）

### wire 层已有的正确零件

| 零件 | 位置 | 语义 |
|---|---|---|
| `session/subscribe` + `session/stream-event` | federation-hub service.ts L695-L728 | hub 把会话事件流推给订阅者，`fromSeq` 续订 |
| `session/send` | federation-hub service.ts L820-L879 | pod 向 **hub 上的活 agent** 投递消息：`agent.followup()`；幂等（clientMessageId）、会话内排序（sendTails）、`commanders` 记录指挥 pod |
| approval 回路 | federation-hub service.ts L881+ | hub 上的审批请求转发给指挥 pod 的 UI |
| `capability/request|result|stream|cancel` | federation-hub service.ts L763-L778 | hub 上会话的工具调用路由到 pod 执行（fs/subprocess 联邦的基础） |
| hub→pod 定向请求先例 | `delegateToPod`（subagent/start） | hub 可在 pod 的外拨连接上发请求并等待结果 |
| `session/persist` | federation-hub service.ts L1370+ | pod 把会话日志推入 hub 持久层（校验 + lease） |

### 缺失的接线

1. pod 的 api-proxy 只广播本地 `ctx.on('session/event')`（api-proxy.ts L3490-L3512）→ 联邦事件流没有桥进 mux（`/api/events.mux` SSE）。
2. pod 的 `session.prompt` 走 `agentFor` → 本地物化 + resume（agent-lookup.ts），而不是 `session/send` 转发。
3. hub 的 sessionSources 只有 local 源（federation-hub/cordis.patch.yml）→ pod 会话对 hub 及其他 pod 不可见；`session/send` 只查 hub 本地 agents → 无跨 pod 路由。

### 模型对照

| 需求 | 现状 |
|---|---|
| hub 会话在 hub 执行 | ❌ pod 打开即接管（本地执行） |
| pod 实时同步 hub 会话 | ❌ 读取时拉取追赶；无流 |
| pod 操作 hub 会话 | ❌ 半成品：`session/send` wire 存在，pod RPC 层未接 |
| pod 操作其他 pod 会话 | ❌ 无路由、无可见性 |
| pod 会话在 pod 执行 | ✅ 已经正确 |

## 4. 阶段 1：实时视图（读路径）

Status: implemented（桥 + 冷会话延迟激活订阅 + 测试）

**目标**：pod Web 客户端打开 hub 会话时，与 hub 视图逐事件实时一致（含生成中的 `assistant/chunk` 流）。

**设计**：pod 的 api-proxy 增加远端事件桥。

- 触发：`session.history` 读到 remoteAuthority 会话时建立（幂等；重复读仅刷新 presenter scope）。mux 是"连接即订阅全部本地会话"的全量模型，远端会话以 `session/event` frame 增量进入同一流，Web 客户端零改动（其内建的 liveBuffer/gap-repair 兜底覆盖基线与流的竞态）。
- 冷会话激活：hub 端 local source 的 `subscribeEvents` 对无活 agent 的会话保持"等待激活"订阅（`session/created` 触发重放 + 转发），pod 的订阅在会话冷启动后即刻生效。
- 桥接：经 `federation-source.subscribeEvents(sessionId, fromSeq)` 订阅 hub 流；收到的 `SessionEvent` 包装成 mux `session/event` frame 广播给本地 SSE 客户端（复用现有 `broadcast`/`muxQueues`，frame 结构不变，Web 客户端零改动）。
- 基线衔接：打开会话时先走现有 detached history 读（含 remoteAuthority 追赶）取得全量与尾部 seq，再从 `fromSeq = 尾部 + 1` 接流；断线重连由 federation-source 现有的 `lastSeq + 1` 续订语义覆盖。
- 生命周期：进程级（订阅随首次读取建立并保持；federation-source 断线自动重订）。远端流订阅按 sessionId 全局去重，`tool/call` 参数表随 `turn/end` 清理（与本地 mux 路径同构）。
- 涉及包：`dsh-host-apiproxy`（桥）、`dsh-session-source-local`（冷会话激活）、`dsh-session-source`（无改动——`subscribeEvents` 已有 `sourceId` 定向参数）、`dsh-session-source-federation`（无改动，能力已有）。

**投影（projections）**：阶段 1 远端会话的投影基线沿用现有 detached 折叠（`detachedProjectionsFor`）；实时增量投影折叠列为阶段 1b 可选项，不阻塞。

**验收**：hub 上会话生成中，pod UI 打开该会话 → chunk 流实时出现；hub 上 rename → pod 实时看到标题更新；pod 断网重连后从断点续流无重复无缺口。

## 5. 阶段 2：执行路由（写路径）

**目标**：pod 对 hub 会话的"操作"在 hub 执行。

**设计**：pod 的 api-proxy 对 remoteAuthority 会话的 Agent-bound RPC 改为联邦转发。

RPC 映射表：

| pod RPC | 路由 | 状态 |
|---|---|---|
| `session.prompt` | → `session/send`（wire 已有，幂等/排序/approval 回路齐备） | 本阶段核心 |
| `session.models` | detached（已实现，2026-08-23） | ✅ |
| `session.history` | detached + 追赶（已实现） | ✅ |
| `session.updateQueue` / `session.cancel` / `session.selectModel` | 需新 wire（`session/queue-update`、`session/cancel`、`session/select-model`），或暂缓（远端运行中会话仅支持追加消息） | 决策点 4 |
| `session.rename` / `session.delete` | 暂缓，pod UI 对远端会话隐藏（现有限制保持） | — |

**关键行为变更**：`agentFor` 的物化分支对 remoteAuthority 会话退役——pod 不再把 hub 会话物化到本地持久层、不再本地 resume。接管模型随写路径一并消失；prompt 后 pod 是"指挥者"（`commanders` 登记），执行在 hub，事件经阶段 1 的流回显。

**writer 冷启动**（决策点 1 → B）：pod 的 `session/send` 到达 hub 时若无活 agent，hub 在 send 排队链内冷启动（resume hub 本地存储的会话，复用与 hub Web RPC 相同的冷 resume 路径以保证 preset 组装一致），成功后 `followup`；resume 失败才回 `writer-offline` 错误。冷启动纳入既有 `sendTails` 会话内排序，不产生并发写者。

**降级**：hub 不可达时，pod 对远端会话的 prompt 明确报错（不本地执行——这正是与接管模型的本质区别）；只读视图降级为最后已知快照（remoteAuthority fail-soft，已有）。

**验收**：pod UI 向 hub 会话发消息 → hub 日志增长、pod 实时看到完整回合（含工具调用）；hub 会话中的审批弹窗出现在 pod 的 UI；两个 pod 同时观察同一 hub 会话，行为一致。

## 6. 阶段 3：跨 pod 操作（所有者路由）

**目标**：pod-1 可操作 pod-2 的会话；任意节点可见任意 pod 的会话。

**设计**：hub 升级为会话所有者路由器。

- **所有权注册**：pod 连接时上报自己的会话清单（header 摘要 + 所有权声明），hub 维护 `sessionKey → ownerPod` 路由表；pod 断线即摘除。hub 的 `session/list`、`session/get`、`session/subscribe` 经 `sessionSources` 聚合这些远端清单（新增一个 pod-owned 远端源，与 local 源并列）。
- **执行转发**：`session/send` 到达 hub 后：hub 本地有活 agent → 现行路径；路由表指向某 pod → 经该 pod 的连接转发（复用 `delegateToPod` 的请求-响应模式），由 pod 上的活 agent `followup` 执行；`commanders` 登记发起 pod，approval 回路指向发起 pod。
- **事件回流**：pod 上活会话的事件增量实时上报 hub（新 wire `session/stream-forward`：pod → hub 的流式追加），hub 校验 seq 连续性后写入 hub 持久层并扇出给所有订阅者。单写者不变：pod 是其会话的唯一写者，hub 是权威副本；已推送的 `session/persist` 整段上传保留为非活跃会话的同步方式。
- **一致性边界**：owner pod 离线时其会话只读（可见、可订阅历史，send 返回 owner-offline）——与 writer-offline 对称。

**验收**：pod-1 的 UI 中向 pod-2 的会话发消息 → pod-2 执行 → hub 与两个 pod 实时看到回合；pod-2 容器停止后，pod-1 仍可查看该会话历史，发消息得到 owner-offline 明确报错。

## 7. 接管模型的退役清单

| 项 | 处置 |
|---|---|
| `agentFor` 对 remoteAuthority 会话的物化 + 本地 resume（agent-lookup.ts） | 阶段 2 删除 |
| `remoteAuthority` 标记 + 定向追赶（2026-08-23 引入） | 降级为离线缓存路径：hub 不可达时 pod 读最后已知快照；已有副本不再增长新物化 |
| 既有物化副本（pod 上已存在的 hub 会话副本） | 决策点 3 |
| `models` detached 分支（2026-08-23 引入） | 保留，阶段 2 后它就是唯一路径 |

## 8. 决策记录（已拍板）

1. **writer 冷启动**：B——hub 遇 send 无活 agent 时自动 resume，随时可续；resume 失败才回 writer-offline。
2. **pod 会话可见性**：A——pod 连接 hub 时全量上报会话清单，之后增量维护；全局任意节点可见。
3. **既有物化副本**：A——一次性清除 pod 上的 hub 会话物化副本，统一走远端读 + 实时流；`remoteAuthority` 降为离线缓存路径。
4. **阶段 2 RPC 覆盖面**：B——一次补齐：`session.prompt`（走既有 `session/send`）+ `session.updateQueue`（新 wire `session/queue-update`）+ `session.cancel`（新 wire `session/cancel`）+ `session.selectModel`（新 wire `session/select-model`），全部复用 request/response 模式、`commanders` 登记与 command 角色权限检查。

## 9. 实施顺序与风险

阶段 1 → 2 → 3 串行，每阶段独立可验收、可独立合入。最大风险点：阶段 3 的 `stream-forward` seq 连续性校验与 pod 重连补偿（复用 `fromSeq` 语义可对齐 `session/persist` 的既有校验思路）；阶段 2 的 approval 回路已有现成实现，风险低。
