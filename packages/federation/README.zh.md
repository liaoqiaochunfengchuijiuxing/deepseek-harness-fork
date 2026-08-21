# federation/：多节点 hub-pod 联邦能力家族

[English](README.md) | 中文

本家族实现 DeepSeek Harness 的 hub-pod 多节点联邦能力，支持 hub 与 pod 节点之间跨设备委派任务、节点发现以及远程会话实时观测。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`federation-hub/`](federation-hub/README.md) | 控制面中心服务：pod 注册表、WS 端点、鉴权认证、委派路由 | `ctx.federationHub` |
| [`federation-client/`](federation-client/README.md) | 数据面客户端插件：外拨连接、能力声明、委派执行 | 注册到 `ctx.federationClient` |

设计依据与拓扑细节参见 [hub-pod 联邦 Agent Note](../../.agents/notes/proposed/feature/2026-08-21-dsh-hub-pod-federation.md)。
