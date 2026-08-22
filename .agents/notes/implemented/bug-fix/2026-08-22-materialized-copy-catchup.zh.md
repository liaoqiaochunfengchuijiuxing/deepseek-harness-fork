# Agent Note: 物化的联邦会话副本在冷 resume 时补齐

Status: implemented

[English](2026-08-22-materialized-copy-catchup.md) | 中文

## Problem

BFF 在冷 resume 前把联邦来源的会话物化到本地持久层，因为 `agents.resume` 只从本地持久层 prepare。该副本是一次性写入的：首次冷 resume 时的快照。此后 hub 侧追加的事件永远到不了 pod，之后每次冷 resume 都从日渐陈旧的日志重建会话，而 hub 持有更新的事件——历史能加载，但提前结束。

## Decision

`createApiRemoteAgentResolver` 的同一条冷 resume 路径现在在 resume 前做补齐。身份已在本地存在时，经 session-sources seam 读取该会话，把本地副本缺失的远端后缀 append 进来——但仅当本地日志是远端日志的严格 deep-equal 前缀（逐事件按序 `isDeepStrictEqual`）。在相同 seq 位置内容分叉的本地日志，或已覆盖远端事件的本地日志，一概不动：单写者模型下，同 seq 内容分叉意味着两个所有者各写了一份日志，调和它属于租约协议的工作，不是这条读路径的。远端源不认识的本地身份是普通本地会话，从不付出调和读取。

两处远端读取（首次物化的 inspect 兜底与本次补齐）共享一个 `readRemoteSession` helper，它解开聚合 `SessionSourcesService` 的 `{ source, session }` 形状与裸单源形状，替换原先内联在 `inspectApiRemoteSession` 里的形状判别逻辑。

后缀 append 按构造满足 persistence seam 的 contiguous-seq 契约：本地尾的 next-seq 恰为后缀首事件的 seq。

## Alternatives considered

**只比较 seq 顺序。** 拒绝：不同所有者写的两份 append-only 日志可以在相同 seq 位置携带不同事件；前缀声明真正依赖的是内容相等。

**删除并重新物化陈旧副本。** 拒绝：它破坏副本可能合法持有的本地写入，且只缺后缀时重写全量日志。

**让本地副本订阅远端事件流。** 拒绝：持续同步属于 M2 镜像流与 M4 租约协议；本路径只需要副本在 resume 时刻是新的。

## Consequences

联邦来源身份的每次冷 resume 多一次远端全量日志读取加 O(n) 深比较——有界、一次性、且不在交互路径上（在 resume promise 内部）。补齐幂等：已当前的副本不 append 任何内容。本地原创会话与首次物化的行为不变。两次冷 resume 之间的陈旧窗口仍然存在（这是 resume 时拉取，不是推送）；关闭它需要租约协议的所有权转移。

物化副本同时出现在远端源的列表中，`sessions.list` 因此把两者合并为一行而非发出重复条目：本地服务的条目（attached 或 cold）保留其 cwd、投影与活跃状态，并获得远端标记与更新的远端 `updatedAt`。远端源列出但本地未服务的会话保持只读的远端视图。
