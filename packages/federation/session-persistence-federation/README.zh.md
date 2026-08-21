# @deepseek-ai/dsh-session-persistence-federation

[English](README.md) | 中文

联邦 `SessionPersistence` 后端：每次 append 先在本地 JSON spool 落盘，再异步上传到 hub 写者存储。hub 不可达不会让本地 turn 失败。resume 与 takeover 走与 JSONL、SQLite 后端相同的 `append` / `readFrom` / `prepare` / revision 路径。

本插件占用 `ctx.sessionPersistence`。一个 context 只挂载一个持久化后端；在漫游 pod 上用它替换 JSONL 或 SQLite。hub 继续使用自己的 JSONL 或 SQLite 后端，并把 `session/persist` 批次写入该存储。

## Service Role

- **Capability Seam**：会话持久化提供者（联邦 / 远端上传）
- **Provides**：`ctx.sessionPersistence`，本地 spool 加异步 hub 上传
- **Consumer Packages**：必须在 hub 不可达时仍能完成 turn 的边缘 pod runtime

## Configuration

| 键 | 默认值 | 含义 |
|---|---|---|
| `spoolRoot` | 必填 | 每会话 JSON spool 文件目录。 |
| `preparedSessionCacheSize` | `5` | 冷检查后为 resume 复用而保留的未发布 Session 上限。 |
| `writeBatchMaxDelayMs` | `200` | 固定的实时事件合并窗口。它不是后端完成期限。 |

```yaml
- id: session-persistence-federation
  name: '@deepseek-ai/dsh-session-persistence-federation'
  config:
    spoolRoot: /var/lib/dsh/federation-spool
```

`locate(meta)` 对 `<spoolRoot>/<id>.json` 返回 `{ kind: 'federation-spool', path }`。第一次耐久 append 才物化该文件。上传发送 `seq` 大于上次 hub 确认的事件，并在 hub 尚未存下前缀时附带 header。

`prepare(id)` 在 `ctx.federationClient` 已连接时先获取 hub 写者租约，再准备未发布 Session。租约被其他 pod 持有时 prepare 以 stale-writer 拒绝。`releaseWriter(id)` 在本地 flush 后释放租约，以便另一节点 acquire 并 resume。

`FederationSessionPersistence.assertTakeoverCompatible(events, version)` 拒绝格式版本不是 `SESSION_FORMAT_VERSION` 的日志，或含有未知且必读（非 `ignorable`）事件类型的日志。

## Model Experience

### Resumed conversation history

#### What the model sees

本后端不注册实时提示词或 schema。加载恢复已存储的 surface 历史，方式与其他持久化后端相同；新 loop 组装当前信封。恢复闭包遵循共享持久化契约（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`）。

#### Token effect

无实时请求 token。被 resume 的 agent 为保留历史与当前信封付费，外加中断调用的引用修复结果。

#### KV Cache effect

spool 与 hub 上传不修改实时请求前缀。被 resume 的 loop 仅在重建历史、当前信封与模型路由一致时才能复用 provider 缓存；崩溃修复结果会追加。

## Known Limitations and Deferred Work

- **hub 上传是尽力而为** — 失败或断线的上传保留本地 spool，并在后续 append 时重试未确认前缀；turn 从不等待网络。
- **每个 context 只有一个 `ctx.sessionPersistence`** — 本后端在 pod 上替换 JSONL/SQLite；hub 存储是 hub profile 已有的后端，不是另一套事件日志表结构。
- **工作区文件不在 spool 中** — 没有工作区的 resume 是会话连续性，不是工作连续性。
- **不会删除 spool 文件** — 日志在 `spoolRoot` 下累积，直到被外部删除。
