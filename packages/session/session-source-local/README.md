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

## Known Limitations and Deferred Work

- **Single-node scope** — only covers sessions stored locally on the active process.
- **In-process coordination** — requires local `SessionPersistence` or active `SessionStore` to resolve metadata.
