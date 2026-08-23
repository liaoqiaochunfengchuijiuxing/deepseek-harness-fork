# Agent Note: 远端权威标记的物化会话副本

Status: implemented

[English](2026-08-23-federation-remote-authority-catchup.md) | 中文

> 部分被[路由式会话执行](2026-08-23-federation-routed-session-execution.md)取代：物化与本地 resume 已退役，标记及其追赶仅作为离线缓存读路径保留。

## 问题

pod 打开 hub 会话时会把它物化到本地持久层（resume 路径的 `persistence.create` + `append`），好让 `agents.resume` 能从本地存储准备。此后该 pod 的读取就被冻结在物化时刻：`inspectApiRemoteSession` 在之后每次 history 读取都返回本地副本，而设计中的追赶机制（经 `sessionSources` 聚合服务的 `readRemoteSession`）也永远看不到 hub——聚合服务按注册顺序扫描各源，pod 的本地源最先命中并返回同一份过期副本。线上实测：hub 会话增长到 990 个事件，pod 视角停在 517，没有任何收敛路径。

## 决策

物化副本携带自己的来源。`SessionHeader` 新增 `remoteAuthority?: string`——副本物化自的会话源 id。`readRemoteSession` 现在报告应答源的 id，`inspectApiRemoteSession` 的远端分支把它盖在返回的 header 上，于是 `agentFor` 的物化经由既有的 `persistence.create(inspected.meta)` 调用写入标记，不需要单独的写入路径。

读取尊重标记而不是信任注册表扫描。当 `inspectApiRemoteSession` 找到盖有 `remoteAuthority` 的本地副本时，直接从该源获取（聚合服务的 `getSession(sessionId, sourceId)` 提示路径，完全绕过本地源），经既有的前缀校验 `appendRemoteSuffix` 追加远端增量，然后返回刷新后的本地检查结果。未打标的本地会话保持今天的早返回不变——pod 自有会话永远不会为此多付一次聚合往返。追赶是失效降级的：权威不可达或抛错时返回过期副本，它仍是一份有效的前缀快照。

resume 路径自己的追赶分支现在区分两种情况：带标记的副本已被 resume 之前的 `inspectApiRemoteSession` 调用追平（重试只会多一次无新信息的 hub 往返），未打标的本地副本保留注册表扫描追赶，服务没有遮蔽本地源的组合。

两个持久化后端都往返该字段：JSONL 后端的 `HeaderLine` 序列化/解析对携带 `remoteAuthority`，SQLite 后端将其存为 `remote_authority` 列（单调 `SCHEMA_VERSION` 从 17 升到 18；旧数据库照旧被拒绝，符合预发布阶段的无迁移立场）。

查看不得附着写者。Web 输入栏的模型座位在每次打开会话视图时调用 `session.models`（ModelSelect 的挂载效应），而该处理器经由 `agentFor` 恢复 Agent——于是在 pod 上仅仅打开一个 hub 会话就会附着一个活 agent，其内存事件日志随后服务每一次 history 读取，把视图冻结在附着时刻，detached 追赶对此无能为力。`session.models` 现在对远端权威会话（带标记的本地副本，或本地存储不认识的 id）以 DETACHED 方式服务：当前选择经 `foldRequestHeader` 从追平后的日志折叠——与附着分支在无进程内覆盖时读取的来源相同——不再恢复任何 agent。活 agent（经 `session.prompt` 或 `session.selectModel` 的刻意接管）仍通过 agent 服务，保留接管路径。

## 备选方案

**让聚合服务优先远端源而非本地源。** 否决：每个 pod 自有会话的查找都要先付一次联邦往返等 hub 回答"未知 id"，而聚合的首个命中即返回正是本地会话依赖的廉价路径。

**用侧表而非 header 标记物化副本。** 否决：header 是随日志一起穿过持久化、备份、恢复的唯一记录；侧表会与它描述的会话文件漂移，还要多维护一个一致性存储。

**在本地会话源内部追赶。** 否决：会话源需要在读取中途取得持久层会话的写权限，而读取路径（`agent-lookup`）本来就拥有前缀校验加追加的调和逻辑。

## 后果

hub 会话增长后，pod 的视角在下一次读取即收敛，无需重新物化。分叉保持其单写者语义：pod 写入过的副本（在 pod 上续跑的 hub 会话）无法通过深等值前缀校验，按原样返回。两个限制是有意的：生成中途的物化可能分叉（resume 会用本地收尾事件修复悬空的 step/turn，永远无法前缀匹配 hub 的真实续写——调和它属于推迟的租约协议工作），且本变更之前物化的副本没有标记，运维需要删一次这类副本，让下次打开重新物化出带标记的副本。

[路由式会话执行](2026-08-23-federation-routed-session-execution.md)落地后，不再产生新的物化副本：`agentFor` 拒绝一切非本地持有的身份，本 note 的追赶只在 `inspectApiRemoteSession` 中运行，作为既有副本的离线缓存读。
