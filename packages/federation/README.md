# federation/ — multi-node hub-pod federation family

English | [中文](README.zh.md)

This family implements the hub-and-pod federation capability for DeepSeek Harness, allowing agents on hubs and pods to delegate tasks, discover connected nodes, and inspect remote execution across devices.

| Package | Role | ctx key |
|---|---|---|
| [`federation-hub/`](federation-hub/README.md) | Central control-plane service: pod registry, WS endpoint, authentication, delegation routing | `ctx.federationHub` |
| [`federation-client/`](federation-client/README.md) | Data-plane client plugin: outbound connection, capability declaration, subagent execution | registers on `ctx.federationClient` |

Design rationale and topology details are documented in the [hub-and-pod federation Agent Note](../../.agents/notes/proposed/feature/2026-08-21-dsh-hub-pod-federation.md).
