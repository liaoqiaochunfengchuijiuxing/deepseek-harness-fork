# @deepseek-ai/dsh-session-source

English | [中文](README.zh.md)

Session source Service Definition and multi-source registry on `ctx.sessionSources`. Provides a unified discovery, listing, searching, and subscription interface over local persistent stores and remote federation nodes.

## Service Role

- **Capability Seam**: Service Definition for Session Sources
- **Service Name**: `ctx.sessionSources`
- **Consumer Packages**: Web Client, ACP/CLI session listings, Federation Hub, Federation Pod Client

## Configuration

This Service Definition accepts an empty configuration object:

```yaml
- id: session-sources
  name: '@deepseek-ai/dsh-session-source'
```

## Model Experience

### Session discovery and aggregation

#### What the model sees

This service registers no model prompts, tools, or schemas. The model interacts with session lifecycle and delegation through high-level tooling such as `tool_subagent` and session references.

#### Token effect

Zero direct token overhead. Host-plane session aggregation does not contribute tokens to model context.

#### KV Cache effect

None. Session discovery does not alter model request prefixes or prompt caching.

## Known Limitations and Deferred Work

- **In-memory source registry** — dynamic session sources must register on startup or during live federation connection.
- **Unpaginated multi-source listing** — listing across all sources flattens results in memory.
