# federation/ — multi-node hub-pod federation family

English | [中文](README.zh.md)

This family implements the hub-and-pod federation capability for DeepSeek Harness, allowing agents on hubs and pods to delegate tasks, discover connected nodes, and inspect remote execution across devices.

| Package | Role | ctx key |
|---|---|---|
| [`federation-hub/`](federation-hub/README.md) | Central control-plane service: pod registry, WS endpoint, authentication, delegation routing | `ctx.federationHub` |
| [`federation-client/`](federation-client/README.md) | Data-plane client plugin: outbound connection, capability declaration, subagent execution | registers on `ctx.federationClient` |
| [`session-source-federation/`](session-source-federation/README.md) | Remote session source: list, search, inspect, and subscribe to hub sessions | registers on `ctx.sessionSources` |
| [`session-persistence-federation/`](session-persistence-federation/README.md) | Local-first session persistence: JSON spool plus async upload to the hub writer store | registers on `ctx.sessionPersistence` |
| [`fs-federation/`](fs-federation/README.md) | Remote `FileSystem` provider: delegate filesystem operations to a target pod over federation WS | `ctx.fs` |
| [`subprocess-federation/`](subprocess-federation/README.md) | Remote `SubprocessRuntime` provider: delegate process and terminal execution to a target pod | `ctx.subprocess` |

Design rationale and topology details are documented in the [hub-and-pod federation Agent Note](../../.agents/notes/implemented/feature/2026-08-21-dsh-hub-pod-federation.md).
