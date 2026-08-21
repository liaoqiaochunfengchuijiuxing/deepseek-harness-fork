# 联邦接手文档（从 T5.2 续做）

本文件是当前树的**开工规格**，不是设计重写。任务定义见 [TASKS.md](TASKS.md)，勾选清单见 [TODO.md](TODO.md)，设计决策见 [hub-pod 联邦 Agent Note](../.agents/notes/implemented/feature/2026-08-21-dsh-hub-pod-federation.zh.md)（三元组 en/zh/i18n；路径是 `implemented/`，不是 `proposed/`）。仓库纪律以根 [AGENTS.md](../AGENTS.md) 为准。

**停在哪里：** M1–M4 与 T5.1 已在 `master`。T5.2（remote `ctx.fs` / `ctx.subprocess`）**尚未开包、没有未提交代码**。不要开始 T5.3。不要改 `agent-loop` 或 core spine。

## Git 快照（写本文时）

| 项 | 值 |
|---|---|
| 分支 | `master`，相对 `origin/master` **超前 18 commit，未 push** |
| HEAD | `a0b1f2efac` `feat(federation): relay pod-to-pod subagent runs through the hub (T5.1)` |
| 工作树代码 | 干净；T5.2 目录不存在 |
| 本接手文档 | `federation/HANDOFF.md` + `TASKS.md` / `TODO.md` / `PROMPT.md` 的配套更新 |

近期独立 commit（新 agent 不必重读对话）：

| Hash | 任务 |
|---|---|
| `6df8ab81b6` … `8648c077e0` | M1 T1.1–T1.6 |
| `498d018add` … `705cfa2db5` | M2 T2.1–T2.5 |
| `94b46b477d` | T3.1 `/remote_send` |
| `afd3b5b105` | T3.2 审批/问询回指挥 pod |
| `ee44a80373` | T3.3 断线 fail-closed e2e |
| `3a437ac112` | T4.1 + T4.2 spool/租约 |
| `7737fbe8c1` | T4.3 `/fork_to_local` `/push_to_hub` |
| `20a6cc60c0` | T4.4 M4 收口 |
| `a0b1f2efac` | T5.1 `targetPodId` peer 中继 |

## 进度

设计分期：M1=v0，M2=v1，M3=v2，M4=v3，M5=v4（可选）。Cloud 模式的产品句：**会话在 hub，工具落在 pod**。T5.1 仍是整段 subagent 任务；T5.2 把远控细化到文件系统与进程。

| 里程碑 | 树中行为 |
|---|---|
| M1 | hub 注册表 + 鉴权 WS；`dsh-subagent-remote` 打 `/federation/subagent`；pod 经 `/federation/connect` 外拨并执行委派 |
| M2 | `ctx.sessionSources`；pod 列出/检查/订阅 hub 会话；断线 degraded；未知节点 generic 卡片 |
| M3 | `/remote_send` → `session/send`；指挥者绑定；审批/问询 fail-closed 回指挥 pod |
| M4 | `dsh-session-persistence-federation` 本地 spool + 异步 `session/persist`；内存租约；`/fork_to_local`、`/push_to_hub` |
| T5.1 | `subagent/start.targetPodId`；hub 经目标 pod 既有连接中继；**未指定目标时**选一台在线 pod（仅 subagent） |
| T5.2 | **下一步**。包未创建 |
| T5.3 | overlay 下跳过 hub 中继。T5.2 不要做 |

决策状态：

- **#1 已定**：`ctx.sessionSources`；定义 `@deepseek-ai/dsh-session-source`；本地 `@deepseek-ai/dsh-session-source-local`；联邦 `@deepseek-ai/dsh-session-source-federation`。
- **#2 仍开**：token 铸造载体（CLI vs hub Web UI）。树里仍是手工 / 环境变量。T5.2 不关它。
- **#3 已定**：hub 复用已挂载的 `ctx.sessionPersistence`；租约是 `FederationHubService` 内存表。

## 必读顺序（T5.2 开工）

1. 根 `AGENTS.md`、本文件、[TASKS.md](TASKS.md) 的 T5.2 节。
2. [docs/architecture.md](../docs/architecture.md)（插件树、seam、不改 agent-loop）。
3. [Agent Note](../.agents/notes/implemented/feature/2026-08-21-dsh-hub-pod-federation.zh.md)：两种动词、拓扑、安全模型、Phasing v4、**Capability-server granularity first** 那条 alternatives（延后而非否决）。
4. [portable execution-world](../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md)：`ctx.fs` 与 `ctx.subprocess` 必须描述**同一个**路径/进程世界。Bash / PTY / LSP 消费这对 seam，不为每个远端 provider 再开工具包。
5. 模板：`packages/e2b/`（`dsh-e2b` + `dsh-fs-e2b` + `dsh-subprocess-e2b`）。联邦变体用 **pod 的本地 fs/subprocess** 当执行世界，用 **既有 federation WS** 当传输，不引入 E2B SDK。
6. Service Definition：`packages/fs/fs/src/index.ts`（`FileSystem`）、`packages/subprocess/subprocess/src/index.ts`（`SubprocessRuntime`）与 `types.ts`。
7. 中继先例：`FederationHubService.handlePodMessage` 的 `subagent/start` 分支；`FederationHubServer.relaySubagentStart`。
8. RPC 先例（复制 pending map，不要新发明）：`FederationPodClient.persistSession`（`packages/federation/federation-client/src/client.ts`）。
9. 新包流程：[docs/cookbook/adding-a-package.md](../docs/cookbook/adding-a-package.md)。

## 已落地包与入口

| 包 | 路径 | `ctx` | 关键文件 |
|---|---|---|---|
| `dsh-subagent-remote` | `packages/subagent/subagent-remote/` | `ctx.subagents` named provider | Config 含 `targetPodId`；`src/run.ts` |
| `dsh-federation-hub` | `packages/federation/federation-hub/` | `ctx.federationHub` | `src/service.ts` 注册表/中继/租约；`src/server.ts` WS；`src/types.ts` wire |
| `dsh-federation-client` | `packages/federation/federation-client/` | `ctx.federationClient` | `src/client.ts` 外拨与 pending map；`src/service.ts` 对外 API |
| `dsh-session-source` / `-local` / `-federation` | `packages/session/…` 与 `packages/federation/session-source-federation/` | `ctx.sessionSources` | — |
| `dsh-session-persistence-federation` | `packages/federation/session-persistence-federation/` | `ctx.sessionPersistence` | spool 优先；`ctx.get('federationClient')` 上传 |

组合：hub patch `packages/federation/federation-hub/cordis.patch.yml`；pod patch `packages/federation/federation-client/cordis.patch.yml`。环境变量：`DSH_FEDERATION_TOKEN`、`DSH_FEDERATION_ENDPOINT`、`DSH_POD_TOKEN`、`DSH_POD_ID`、`DSH_POD_NAME`。`dsh-subagent-remote` 默认打 `/federation/subagent`。

Hub 监听：`/federation/connect`（pod 外拨）与 `/federation/subagent`（委派拨入）。**不要为 capability 再开第三条 upgrade path**；在已有连接上加 `type`。

`FederationHubService` **没有**通用 `sendToPod` / RPC 助手。socket 在私有 `pods` Map。T5.2 必须在 service 上增加公开 RPC（见下文），不要让 `fs-federation` 去摸私有字段。

`FederationClientService` 目前只转发 `sendToSession` / `persistSession` / `leaseSession`。T5.2 同样要加公开 RPC，内部走 `FederationPodClient` 的 pending map。

## 现有 wire（`type` 字符串必须两端字节相同）

Hub 并集：`packages/federation/federation-hub/src/types.ts` 的 `FederationWireMessage`。Client 并集：`packages/federation/federation-client/src/types.ts` 的 `FederationClientWireMessage`。两份类型是**复制**的，没有共享协议包。T5.2 **继续对称加字段，不要新开协议包**。

已知不一致（不要再复制）：hub 心跳 ack 是 `federation/heartbeat_ack`，client 期望 `federation/heartbeat-ack`。新消息的 `type` 在 hub 与 client **必须是同一字符串**。推荐风格对齐 `session/persist`：斜杠 + 短横线。

`handlePodMessage` 与 client `handleMessage` 对未知 `type` 都是 `default: break`（静默忽略）。新 type 必须两端都加 case，否则 RPC 会超时。

## 不变量（对照实现）

- **档位①**：新包挂现有 `ctx.fs` / `ctx.subprocess`。不改 `agent-loop`、session/tools/system-prompt/agent。不为联邦再造 `tool-fs` / `tool-bash` / `tool-lsp`。
- **一 context 一实现**：`ctx.fs`、`ctx.subprocess`、`ctx.sessionPersistence` 都是单实例 Service。调用方挂联邦 provider **替换**本地实现；执行方 pod **保留** `dsh-fs-local` + `dsh-subprocess-local`。同一 context 不要同时挂 `dsh-fs-local` 与 `dsh-fs-federation`。
- **pod 只外拨**：hub 永不主动连 pod。Capability RPC 走 pod 已拨入的 `/federation/connect`。
- **凭证不跨节点**：capability 载荷与 spawn `env` 不得出现 API key。子进程环境沿用 `scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN`（`packages/subprocess/subprocess/src/index.ts`）。负向测试断言 spawn `env` 无 `DEEPSEEK_API_KEY`。
- **单写者会话**：T5.2 不改变会话写权。远程 fs 写的是 **pod 工作区文件**，不是 hub 会话日志。
- **模型可见 ⟺ 日志**：远程工具结果仍由现有 tool Consumer 写入调用方会话；联邦线上不发明第二套模型可见事件。
- **注册即 effect**：hub/client 上的 capability 处理器用 `ctx.effect()` / `ctx.on()`。
- **无硬编码 tunable**：`targetPodId`、`requestTimeoutMs` 是 Config。client 已有 `requestTimeoutMs`（默认 10000，覆盖 send/persist/lease）；capability 复用或加并列字段。
- **未认证连接拒绝**。突变（write/edit/spawn）要求 `roleAllowsCommand`（`command`/`manage`/`takeover`）。只读 `stat`/`readText`/`listDir`/`resolve`：推荐鉴权通过即可（与 T5.1 读路径一致），选定后写进两个新包 README，不要两种行为。
- **waterfall 必须 `next()`**，除非拥有决策。T5.2 不要动审批/问询。`ctx.userQuestions` 是 exclusive slot：hub 包装 `ask()`，不要 `registerProvider`。

## T5.2 目标与非目标

目标：调用方（hub Cloud 或另一 pod）的 `ctx.fs` / `ctx.subprocess` 把完整 seam 方法发到**显式** `targetPodId` 上的 local 实现。

非目标：

- 不改 tool 包；模型打到远端是因为调用方挂了联邦 fs/subprocess，tool-fs / tool-bash 仍然只看 `ctx.fs` / `ctx.subprocess`。
- 不默认「第一台在线 pod」。capability 没有 subagent 那种 fallback；缺 `targetPodId` 或目标离线 = 响亮失败。
- 不把 fs-federation 塞进默认 hub patch（没有 pod 的 hub 会失去本地 fs）。Cloud 组合用额外 insert 或 overlay，README 写清；e2e 在测试里手动 `plugin()`。
- 不抽共享协议包、不修 heartbeat ack 拼写、不开始 T5.3 直连。
- 不发明 `env.FEDERATION_TARGET_POD`（T5.1 已改成 Config 字段）。

## 推荐 wire

在 hub `types.ts` 与 client `types.ts` **同时**加入（名称可微调，语义不要拆成两套）：

```
type CapabilitySeam = 'fs' | 'subprocess'

capability/request  { requestId, targetPodId?, seam, method, args }
capability/result   { requestId, ok, value?, error?: { code, message } }
capability/stream   { requestId, seq, chunk, done? }
capability/cancel   { requestId }
```

`targetPodId`：

- Cloud（hub 上的 provider）：hub 本地已知道目标，发出去给该 pod 的消息可以不带（pod 是执行方）；若带，必须等于该连接的 podId。
- Peer（发起方 pod）：**必填**。hub 只转给该 pod。无 `targetPodId` 的 capability 请求无效，不要选第一台在线 pod。

约定：

- `args` / `value` / `chunk` JSON 可序列化。`Uint8Array` 用 base64 字符串，两端编解码。
- `FsTarget` / `FsVersion` / `FsTargetKey` 当普通字段传。调用方不得伪造 key——只回传 `resolve()` 得到的目标。
- `FsError` 经 `error.code` 还原为 `FsError`（`packages/fs/fs/src/types.ts` 的 `FsErrorCode`），不要变成无类型 `Error`。
- 流式方法（`streamText`、pipe stdout/stderr、terminal `output`）先 `capability/stream` 再以 `capability/result` 结束；`cancel` 映射为执行方 `AbortSignal`。
- subprocess **handle 是远端 id**：`spawn` / `spawnTerminal` 立即返回 `{ handleId, pid }`；后续 `terminate` / `waitForExit` / `readFrom` / stdin write / `inspectForeground` / `signalForeground` 带同一 `handleId`。调用方投影成 `SubprocessHandle` / `SubprocessTerminalHandle`（宿主侧 `PassThrough` 当 `Readable`/`Writable`）。
- 目标离线、socket 非 OPEN、seam 未挂载：失败 result 或 spawn 级 `done` reject。**不要**静默落到 hub 本地 `ctx.fs`。
- disconnect 时 pending map **resolve 成 structured failure**，不要 `reject` 成未捕获（照抄 persist）。
- `markSocketClosed(podId, socket)` 必须 `record.socket === socket`，已实现；capability 离线清理走同一条 `failPendingForPod`。

### 建议 method 名（与 seam 方法 1:1）

fs：`resolve` `processPath` `fileUrl` `contains` `stat` `lstat` `readText` `streamText` `readBytes` `listDir` `writeText` `editText`。

`processPath` / `fileUrl` / `contains` 是纯函数，但 containment 必须用**执行世界**路径规则。hub 可能是 macOS、pod 是 Linux：不要在 hub 上用 `path.win32`。推荐每次 RPC 到 pod，或 resolve 时把 canonical POSIX 路径放进返回值、调用方只用 `path.posix`。

subprocess：`resolveExecutable` `spawn` `spawnTerminal`，以及 handle 后续 `terminate` `waitForExit` `readFrom` `writeStdin` `writeTerminal` `inspectForeground` `signalForeground` `terminateTerminal`。

## 必须新增的服务 API

### Hub（`FederationHubService`）

公开方法，供 `dsh-fs-federation` 在 Cloud 模式调用，例如：

- `rpcToPod(podId, request): Promise<CapabilityResult>` — 检查 online + socket OPEN，发 `capability/request`，pending map + timeout；失败 structured，不 throw 未捕获。
- 处理来自 pod 的 `capability/result` / `capability/stream`（执行方回复）。
- 中继：origin pod 发来带 `targetPodId` 的 `capability/request` → 转给目标 pod；把目标的 result/stream/ 错误打回 origin socket（对标 `handlePodMessage` 的 `subagent/start` 分支，约 `service.ts:416`）。
- `capability/cancel` 按 requestId 转发并 abort。

`handlePodMessage` 的 `default` 今天会丢掉这些消息，必须加 case。

### Client（`FederationPodClient` + `FederationClientService`）

- `rpcCapability(request): Promise<CapabilityResult>` — 照抄 `persistSession`：未连接 → `{ ok:false, code:'disconnected' }`；timeout → `'timeout'`；pending map keyed by `requestId`。
- `handleMessage` 增加：作为**调用方**收 `capability/result`/`stream`；作为**执行方**收 `capability/request`/`cancel`。
- 执行方 dispatcher：`seam === 'fs'` → `ctx.get('fs')`；`subprocess` → `ctx.get('subprocess')`。缺服务则 result `ok:false`。把 method 名映射到实参；`cancel` 接到该次 RPC 的 `AbortController`。
- 执行方维护 `Map<handleId, SubprocessHandle | SubprocessTerminalHandle>`，进程结束后删除。

传输选择（联邦 provider `apply` 时响亮失败，不要第一次调用才发现）：

1. `ctx.get('federationHub')` 存在 → Cloud：`rpcToPod(config.targetPodId, …)`。
2. 否则 `ctx.get('federationClient')` 存在 → Peer：经 client 发出，消息带 `targetPodId`。
3. 两者都无 → 加载失败。

`targetPodId` 为 Config **必填**。

## 包布局（档位①）

不必再做一个 `dsh-federation-runtime` owner：pod 身份已由 `federationHub` / `federationClient` 拥有。对标 e2b 的两个 adapter，不要第三个生命周期包。

| 包 | 路径 | 注册 | 依赖 |
|---|---|---|---|
| `@deepseek-ai/dsh-fs-federation` | `packages/federation/fs-federation/` | `ctx.fs` | `dsh-fs`；`dsh-federation-hub` 与/或 `dsh-federation-client`（`ctx.get` 可选） |
| `@deepseek-ai/dsh-subprocess-federation` | `packages/federation/subprocess-federation/` | `ctx.subprocess` | `dsh-subprocess` + 同一 federation 服务 |

执行方不新开包：改 `dsh-federation-client`。

每个新包清单（抄 `session-persistence-federation` 与 `fs-e2b`）：

- `package.json`：`@deepseek-ai/dsh-<name>`，`private` 按家族惯例、`version` 与根 `package.json` 相同（当前 `0.1.0-rc.8`）、`type: module`、`main`/`types`/`exports`/`files` 符合 constraints；`@deepseek-ai/cordis` 同时 peer + dev；每个 dsh peer 镜像到 devDependencies；`schemastery` 在 `dependencies`。
- `tsconfig.json`：`extends ../../../tsconfig.base.json`，`rootDir src`，`outDir lib/types`，references：cosmokit、cordis、schemastery、以及 `dsh-fs`/`dsh-subprocess` 与 federation 包。
- `src/index.ts`、`src/invariant.ts`（空 companion 必须**命名**为什么没有持续可观察关系，抄 persistence-federation 的说明）。
- README 三件套 en/zh/i18n.yaml；含 Known Limitations；跑 `pnpm exec tsx scripts/verify-translation-pairing.ts --write <pair>`。
- `tsconfig.host.json` 的 `references` 在现有 federation 四条旁加两行（约 276 行）。
- `scripts/gen-doc-graphs.ts`：`fs` 的 `implementations` 加 `fs-federation`；`subprocess` 加 `subprocess-federation`。
- `packages/federation/README.md` + `.zh.md` 表各加两行；`packages/fs/README.md` 与 `packages/subprocess/README.md` 各加一行。
- `pnpm install`（workspace 新包）。
- Config：**模块级** `export const Config: z<Config> = z.object({...})`，字段要 `description`，catalog 静态可走。不要只用 class-static 别名。`targetPodId` required；超时有 default。

插件形态：`FileSystem` / `SubprocessRuntime` 子类 + `export default`（与 `dsh-fs-local` / `dsh-fs-e2b` 相同），`static inject` 尽量空，内部 `ctx.get`。

## 必须实现的 seam 方法

`FileSystem`（`packages/fs/fs/src/index.ts`）全部抽象方法。`sandboxMode` 默认 `undefined`，除非远端声明了沙箱；不要假装 hub 在围栏里。`readBytes` 的 `maxBytes` 在远端执行，超限 `FS_TOO_LARGE`，不要截断。

`SubprocessRuntime`：`resolveExecutable`、`spawn`、`spawnTerminal`。Handle 合同见 `packages/subprocess/subprocess/src/types.ts`：`pid`（远端启动完成前可为 `-1`，与 E2B 相同）、collect 的 offset `readFrom`、`terminate` 的 TERM→grace→KILL、`waitForExit` 等整棵树、`spawnTerminal` 的 write / inspectForeground / signalForeground / 单一 `terminate()`。

E2B 把 pipe/PTY 做全了，因为 Bash / `dsh-terminal-bash` / `dsh-lsp-stdio` 都坐在这对 seam 上。T5.2 按任务书是同一形状：**完整 seam，不是只做 `readText`**。实现顺序可以 fs 全量 → collect `spawn` → pipe → terminal，但仍是 **一个任务、一个 commit**。

`spawn` 的 `env` 在**执行方 pod** 上合并进 `scrubbedParentEnv()`。调用方不要把 `process.env` 整包塞进 RPC。

## 建议实现顺序（一个 T5.2 commit）

1. hub/client **types + rpcToPod / rpcCapability + pending map + 中继 + 执行方 dispatcher**（对标 persist 的 requestId / timeout / disconnect resolve）。
2. `fs-federation`：对 fake hub 或 mock service 跑 `resolve`/`stat`/`readText`/`writeText`/`editText`/`listDir`/`readBytes`/`streamText`/`lstat`。
3. pod dispatcher：method → `ctx.fs`；取消令牌 → `AbortSignal`；`FsError.code` 往返。
4. `subprocess-federation`：`resolveExecutable` + collect `spawn` + `terminate`/`waitForExit`/`readFrom`。
5. pipe 与 `spawnTerminal`（WS 上的 byte 流；宿主 `PassThrough`）。
6. e2e：真 WS；目标 pod 挂 `dsh-fs-local` / `dsh-subprocess-local` + federation-client；调用方挂联邦 provider；读/写文件；collect spawn 回显；`env` 无 `DEEPSEEK_API_KEY`；目标离线失败响亮；错误 `targetPodId` 失败；`read` token 不能 write/spawn。
7. 双语 README、`pnpm run gen-doc-graphs`、`pnpm run gen-config-catalog`、更新 Agent Note Consequences（remote fs/subprocess **已在树中**；T5.3 仍未）、勾选 `TODO.md`。

## 测试落点

| 层 | 位置 |
|---|---|
| fs RPC 单测 | `packages/federation/fs-federation/tests/` |
| subprocess 单测 | `packages/federation/subprocess-federation/tests/` |
| hub 中继 | `packages/federation/federation-hub/tests/federation-hub.spec.ts`（假 socket，对标 peer `subagent/start`） |
| client 分发 | `packages/federation/federation-client/tests/` |
| 双端 e2e | 并列新增 `packages/federation/federation-hub/tests/federation-e2e-t52.spec.ts`（抄 `federation-e2e-m5.spec.ts`：`port: 0`、`vi.waitFor` pod online、`afterEach` dispose） |

覆盖率：CI 是 `packages/*/*/src` **每文件 100%**。新包必须满。改下面这些文件时，**既有未覆盖分支仍在**；只覆盖你新增的路径。一旦改到未覆盖旧行，整文件门禁会红：

- `packages/federation/federation-hub/src/server.ts`
- `packages/federation/federation-client/src/client.ts`
- `packages/subagent/subagent-remote/src/run.ts`

空 `catch` 必须命名吞掉的是什么。catalog 的 `TYPE_LINK_EXEMPTIONS` 只给确实无法链接的 payload 类型。ApprovalOutcome / 问询类型从**拥有包** import，不要在 federation `types.ts` 再导出一遍（hub types 已 `export type { ApprovalOutcome }`——不要为 capability 再复制 FsError）。

快照：若示例组合让模型经 `tool_fs` / `tool_bash` 打到远端，同 PR 要有 keyless 快照（真实可运行 example + `llm-replay`）。若 T5.2 只提供 seam、Cloud 示例组合留到以后，在 README 写明，并至少有双进程 e2e 覆盖工具会打到的方法。

建议命令（不要默认全量 `test:coverage`）：

```
pnpm exec vitest run packages/federation/fs-federation packages/federation/subprocess-federation packages/federation/federation-hub/tests packages/federation/federation-client/tests
pnpm exec vitest run --coverage --coverage.include='packages/federation/fs-federation/src/**' --coverage.include='packages/federation/subprocess-federation/src/**' packages/federation/fs-federation packages/federation/subprocess-federation
pnpm run typecheck
pnpm run lint
pnpm run gen-doc-graphs
pnpm run gen-config-catalog
```

改 catalog 后双语围栏必须字节相同。Windows `check:windows-wine` 仅在诊断已知 Windows 失败时用。

## 已知陷阱（已踩过，不要再踩）

- **`ctx.userQuestions` exclusive wrap**（T3.2）。T5.2 不要动。
- **`markSocketClosed(podId, socket)`** 比较 socket 身份。capability 离线必须走现有 `failPendingForPod`。
- **pending map disconnect 要 resolve**，不要 reject。
- **`SessionPreparation` 用 `[Symbol.dispose]`**，不是 `.dispose()`。
- **Config catalog** 要模块级、静态可走的 schemastery `z.object`；description 缺失会导致 catalog 生成不稳定。
- **双语围栏**（config-catalog 的英文/中文代码块）必须字节相同。
- **oxlint**：不要未用 import；不要对 `at(-1)` 非空断言；`expect(() => …)` 若表达式是 void，用花括号。
- **`contains` / `processPath` 的世界在 pod 上**。
- **不要**同一 context 双挂 local + federation fs。
- **不要**用「第一台在线 pod」给 fs。
- **invariant companion** 空实现要说明为什么没有持续可观察关系（runtime invariants 检查权威事件流或可变数据，不检查 service 是否存在）。
- **文件末尾恰好一个换行**；`git diff --cached --check`。
- 相对 import 用 `.ts` 后缀。

## T5.3（不要提前做）

直连优化：overlay / 打洞后跳过 hub 中继。不改变 capability 字段与 `targetPodId` 寻址。T5.2 的消息里保留 `targetPodId`，不要把路由写死在 URL 路径里，以便以后把「经 hub 转发」换成「同一消息打到直连 socket」。

## 仍开放

- **#2 token 铸造载体**：CLI 还是 hub Web UI；T5.2 不关。
- Capability 只读是否允许 `read` token：上文有推荐，选定后写进 README。

## 给下一任的开工指令

把 [PROMPT.md](PROMPT.md) 整段交给开发 agent，并附加：

> 从 T5.2 开始。先读 `federation/HANDOFF.md`。HEAD 是 T5.1（`a0b1f2efac`）。不要开 T5.3，不要改 agent-loop。按 HANDOFF 的包路径、wire、rpcToPod/rpcCapability、完整 FileSystem + SubprocessRuntime 实现。一次一个 commit：`feat(federation): … (T5.2)`。新包需要 `pnpm install`。

## 提交约定

一次一个任务。T5.2 一个 `feat(federation): add remote fs and subprocess providers (T5.2)`（措辞可按仓库现有风格微调）。本接手文档单独 `docs(federation): …`。非平凡实现同 PR 更新 Agent Note 三元组，然后 `pnpm exec tsx scripts/verify-translation-pairing.ts --write .agents/notes/implemented/feature/2026-08-21-dsh-hub-pod-federation.md`。
