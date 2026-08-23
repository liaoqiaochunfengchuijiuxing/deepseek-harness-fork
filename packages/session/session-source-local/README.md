# @deepseek-ai/dsh-session-source-local

English | [中文](README.zh.md)

Local SessionSource provider for `@deepseek-ai/dsh-session-source`. Connects in-process `ctx.sessionPersistence`, projections, and `ctx.sessionQuery` to the unified multi-source federation seam.

## Service Role

- **Capability Seam**: Session Source Provider (Local)
- **Provides**: Registers `'local'` SessionSource on `ctx.sessionSources`
- **Consumer Packages**: App profiles, Web UI, federation pod client

## Configuration

This provider accepts an empty configuration object:

```yaml
- id: session-source-local
  name: '@deepseek-ai/dsh-session-source-local'
```

## Model Experience

### Local session operations

#### What the model sees

This provider registers no model prompts, tools, or schemas. The model interacts with session lifecycle and delegation through high-level tooling such as `tool_subagent` and session references.

#### Token effect

Zero direct token overhead. Host-plane session persistence and queries do not contribute tokens to model context.

#### KV Cache effect

None. Local session source operations do not alter model request prefixes or prompt caching.

## Live event subscriptions

`subscribeEvents` serves both live and cold sessions. For a live session it replays events at or after `fromSeq` and forwards every later append. For a cold session (no live store entry — e.g. a persisted session no Agent holds) the subscription stays OPEN against activation: when the session is published (a resume republishes it), the `fromSeq` replay and forwarding begin, so a subscriber connected before activation still sees the whole session from its requested seq. Disposing a still-cold subscription cancels the wait without side effects. This is what lets a federation hub stream a session's events to pods from the moment the session first runs on the hub, not just from the moment an Agent happens to be live.

## Known Limitations and Deferred Work

- **Single-node scope** — only covers sessions stored locally on the active process.
- **In-process coordination** — requires local `SessionPersistence` or active `SessionStore` to resolve metadata.
