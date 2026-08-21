# Agent Note: 远端 Agent resume 前物化会话源会话

Status: implemented

[English](2026-08-22-federation-remote-session-resume.md) | 中文

## Problem

Host BFF 的 `inspectApiRemoteSession` 按 `{ header, events }` 消费 `sessionSources.getSession(id)`。聚合的 `SessionSourcesService` 返回 `{ source, session: { header, events } }`；只有单个 `SessionSource` 返回裸形状。Pod 的 BFF 检查 hub 会话时因此崩溃于 `TypeError: remote.events is not iterable`，联邦来源的会话连历史都无法渲染。

仅修好检查并不能让此类会话可服务。`ctx.agents.resume` 走到 `sessionPersistence.prepare(id)`，它读取本地持久层，而联邦来源的会话只存在于 hub 上。Pod 的冷 resume 因此失败于 `resume failed: session "..." not found`：历史能加载，命令被拒绝。

## Decision

两处修复都位于 `packages/api/remotes/src/agent-lookup.ts`。

`inspectApiRemoteSession` 同时接受两种远端返回形状。结构化检查在 `session` 存在时解开聚合的 `{ source, session }` 包装，并在使用前校验 `header` 与 `events`，本地优先路径与两种远端形状由此收敛到同一个 `{ meta, events }` 结果。

`createApiRemoteAgentResolver` 的冷 resume 路径会物化本地持久层未列出的已检查会话：在 subagent 所有权栅栏之后、`ctx.agents.resume` 之前，检查 `persistence.list()` 成员关系，身份缺失时先写 `persistence.create(inspected.meta)` 再写 `persistence.append(sessionId, inspected.events)`。已在本地的会话不会被重写；`resumes` promise map 对同一身份的并发 resume 去重，因此物化对每个冷身份至多运行一次。

物化副本是 resume 的脚手架，不是所有权：hub 持有权威会话并始终是其唯一写者。

## Alternatives considered

**把 `SessionSourcesService.getSession` 改为返回裸形状。** 拒绝：包装标明了由哪个源应答，聚合的消费方需要该信息；一个 BFF 消费方的形状不匹配不足以收窄 seam 契约。

**让 `ctx.agents.resume` 经 `sessionSources` 读取。** 拒绝：resume 的 prepare 路径归 `sessionPersistence` 所有，改道会触碰联邦工作不得修改的核心 agent/session spine。

**改走 M4 联邦持久化 provider（spool + 上传）。** 拒绝：该 provider 服务于编写会话并上传到 hub 的 pod。本路径恰好相反——对 hub 编写的会话做读侧冷 resume——只需要一份本地副本让 `prepare` 成功。

## Consequences

resume 过 hub 会话的 pod 会在本地保留该会话的完整事件日志副本，pod 的持久层随其服务的每个联邦会话增长。副本是首次冷 resume 时的快照：此后的 hub 侧追加不会重放进副本。单写者模型得以保留，因为副本只服务于 pod 的 resume，绝不构成第二个写者。

结构化解包是 BFF 内联类型化边界（`ctx.get('sessionSources')` 加本地 cast，无包依赖）上的运行时形状判别。内联 union 让两种形状显式共存而非断言其一；未来对 session-source Service Definition 的类型化依赖可以替换该 cast 并删除此检查。
