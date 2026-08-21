# federation/：多节点 hub-pod 联邦能力家族

[English](README.md) | 中文

本家族实现 DeepSeek Harness 的 hub-pod 多节点联邦能力，支持 hub 与 pod 节点之间跨设备委派任务、节点发现以及远程会话实时观测。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`federation-hub/`](federation-hub/README.md) | 控制面中心服务：pod 注册表、WS 端点、鉴权认证、委派路由 | `ctx.federationHub` |
| [`federation-client/`](federation-client/README.md) | 数据面客户端插件：外拨连接、能力声明、委派执行 | 注册到 `ctx.federationClient` |
| [`session-source-federation/`](session-source-federation/README.md) | 远端会话源：列出、搜索、检查并订阅 hub 会话 | 注册到 `ctx.sessionSources` |
| [`session-persistence-federation/`](session-persistence-federation/README.md) | 本地优先会话持久化：JSON spool 加异步上传到 hub 写者存储 | 注册到 `ctx.sessionPersistence` |
| [`fs-federation/`](fs-federation/README.md) | 远程 `FileSystem` 提供者：通过联邦 WS 将文件系统操作委托给目标节点 | `ctx.fs` |
| [`subprocess-federation/`](subprocess-federation/README.md) | 远程 `SubprocessRuntime` 提供者：将子进程与终端执行委托给目标节点 | `ctx.subprocess` |

设计依据与拓扑细节参见 [hub-pod 联邦 Agent Note](../../.agents/notes/implemented/feature/2026-08-21-dsh-hub-pod-federation.md)。
