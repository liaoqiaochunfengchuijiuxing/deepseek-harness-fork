# Agent Note: 远端权威会话的实时事件桥接进 Web mux

Status: implemented

[English](2026-08-23-federation-remote-authority-live-bridge.md) | 中文

## 问题

pod 的 Web UI 显示的 hub 会话冻结在读取时刻。detached history 路径（含 `remoteAuthority` 追赶）只在有人重新读取时刷新副本，而 api-proxy 的 mux 广播——每个 Web 客户端消费的流——只携带本地 `ctx.on('session/event')` 事件。hub 上运行的回合永远不会流到 pod；pod 的视图只在下一次完整读取时收敛。路由式执行模型要求相反的语义：查看即读取，权威追加的一切实时流向每个观察者。

第一个缺口之下还藏着第二个：hub 侧本地会话源的 `subscribeEvents` 对任何没有活 Agent 的会话都返回空退订函数。pod 订阅冷的 hub 会话后，即使会话被激活也收不到任何事件——流会静默错过会话的整个首次运行。

## 决策

桥住在 api-proxy 里，由需要它的那次读取建立。当 `session.history` 服务远端权威会话（盖有 `remoteAuthority` 标记的日志，或只有远端源认识的 id）时，它调用 `ensureRemoteStream(sessionId, tailSeq + 1, scope, authority)`：一条定向到标记权威的 `sessionSources.subscribeEvents` 订阅——与 `getSession` 使用的提示路径相同，因此注册表扫描不会被本地源的物化副本遮蔽——其事件经既有 `broadcast()` 以普通 `session/event` mux frame 重新广播，工具视图经同一 presenter 路径计算（按桥维护的 open-call 表，`turn/end` 时清理）。Web 客户端零改动：其既有的 liveBuffer 与 gap-repair 覆盖基线与流的竞态，`fromSeq = tail + 1` 加上 hub 订阅时的重放关闭读取-订阅间的窗口。

桥按进程去重且幂等：重复读取只刷新 presenter scope，federation source 自身断线重连时从 `lastSeq + 1` 重新订阅，桥接集合以用户实际打开的会话为界。从 cut 尾部 +1 开始订阅是安全的，因为 hub 在订阅时从 `fromSeq` 重放。

冷会话激活其持有的订阅。本地会话源的 `subscribeEvents` 现在区分活与冷：活会话从 `fromSeq` 重放并转发追加；冷会话将订阅保持打开直至发布——当会话被创建（resume 会重新发布它）时，重放与转发随即开始。仍处冷态时销毁订阅会无副作用地取消等待。

## 备选方案

**mux 连接时建桥（预先订阅所有远端会话）。** 否决：mux 对本地会话是"连接即全量订阅"，但从 pod 视角远端集合无界；首次读取时建桥把联邦流量限制在有人真正打开的会话上。

**给 Web 客户端教第二种远端 frame 类型。** 否决：客户端已经能用 gap repair 把活事件缝合到 history 基线上；把远端事件重新发成普通 `session/event` frame 保持单一协议、客户端零改动。

**把冷会话激活推进聚合服务。** 否决：聚合的扫描经 `getSession` 探测归属，解析冷 id 需要 persistence；激活契约属于知道自己的 store 何时发布的那个源。

## 后果

任意 pod 上打开的 hub 会话会把权威的每次追加实时流进该 pod 的 Web UI——已在 Docker 集群实测：hub 上执行的 prompt 以完整回合到达 pod 的 mux（user/message、turn 生命周期、五个 assistant chunk、turn/end，seq 1705–1719 连续）。阶段 2（把 `session.prompt` 路由到 `session/send`）在此基础上构建：pod 把执行转发给 hub 后，同一座桥就是在指挥 pod 上渲染被执行回合的回程路径。桥广播给所有已连接的 mux 消费者，因此一个 pod 上的两个浏览器看到相同的远端流。远端会话的投影仍走 detached 基线折叠；远端会话的实时 `session/projection` frame 已推迟（提案的阶段 1b）。
