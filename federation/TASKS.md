# Hub-Pod 联邦开发任务书

状态依据与设计决策见 [Agent Note: hub-and-pod federation](../.agents/notes/proposed/feature/2026-08-21-dsh-hub-pod-federation.zh.md)。本文件把该设计的 v0–v4 分期拆成 PR 粒度的任务；[TODO.md](TODO.md) 是对应的执行清单。

## 阅读约定

- 任务 ID `T<里程碑>.<序号>`；每个任务目标是一个可独立合并的 PR。
- "依赖"列出的任务必须先行合并。
- 里程碑对应设计文档的 Phasing：M1=v0（委派通道），M2=v1（只读原生体验），M3=v2（命令级），M4=v3（管理与漫游），M5=v4（peer 与细粒度，可选）。

## 仓库纪律（每个任务 PR 都适用）

来自 [AGENTS.md](../AGENTS.md)，落地时逐条对照：

- **Agent Note**：非平凡改动同 PR 附 Agent Note；设计决策落地时把 proposed 三元组中对应部分推进为 implemented。
- **测试政策**：模型可见或产品用户可见的行为变化，同 PR 通过真实可运行示例补 keyless 快照（用 `llm-replay` 回放，不依赖真实 key）；能力 seam 需覆盖单测、生命周期路径与 transcript 输出。`test:coverage` 是覆盖率门禁。
- **双语**：新增包 README 三件套（en/zh/i18n.yaml），改完跑 `pnpm run verify-translation-pairing --write <file>` 记录。
- **门禁**：`pnpm run doc-sync`（含 capability-seams、config catalog 再生成）、`pnpm run build`、`pnpm run hygiene`。
- **seam 三角色**：新能力 = Service Definition + Provider + Consumer 成套出现，不单角色开包。
- **落地档位**（按此为每个任务选实现方式）：① 挂现有 seam = 纯新增包，不改任何既有代码（如 T1.1/T1.2/T1.3）；② 新建 seam 包 + 修改既有消费方 = 仓库级 PR，改的是既有包（如 T2.1 定义 seam / T2.4 把已发布的 client UI 包接到新 seam），仍不动 core；③ 动 core spine（session/tools/system-prompt/agent/agent-loop）= 默认禁止，确需触碰先升级设计文档并重审。
- **显式默认**：部署可变参数是验证过的 `Config` 字段，不写死常量；配置错误在加载期响亮失败。

## 里程碑总览

| 里程碑 | 交付 | 关键验收（摘自设计文档） | 规模预估 |
|---|---|---|---|
| M1 | 云端↔pod 双向委派可用 | hub 委派 pod 完成任务并返回结构化结果与用量；断线映射 stop reason | 3 个新包 + 组合 |
| M2 | pod 原生只读远端会话 | 远端会话本地列表/搜索/实时渲染；未知节点降级 generic 卡片 | 1 个 seam + 2 包 |
| M3 | pod 可指挥远端会话 | 命令到达远端 inbox；审批出现在指挥 pod，绝不静默自动批准 | 桥 ×2 |
| M4 | 会话漫游与共享存储 | fork-to-local 后 derived messages 一致；租约被持有时 resume 明确失败 | 持久化 provider + 租约 |
| M5 | peer 委派 / 细粒度远控 | pod↔pod 经 hub 中继；可选 remote fs/subprocess | 按需 |

---

## M1 委派通道（v0）

**目标**：hub 与 pod 双向的 agent 间委派跑通，全部走 `dsh-subagent-remote` 一份 wire。零开发底座（浏览器直连 hub）同期可用。

### T1.1 `dsh-subagent-remote` provider（客户端半边）

- **交付**：`packages/subagent/subagent-remote/`，注册到 `ctx.subagents` 的命名 provider。
- **要点**：`start(request)` 建立（或复用）到 endpoint 的连接，按 subagent 词汇映射 start/message/stop；复用 `subagent-dsh-sdk` 的 stop-reason 映射表（completed/max-tokens/aborted/error）；连接层故障 → `stopReason: 'error'`，契约禁止 result reject。config：`providerName`、`endpoint`、`token`（经 credentials 引用，不存明文）、`connectTimeoutMs`。cwd 语义照抄 seam 的 out-of-process 约定：委派方会话 cwd 传给对端。
- **依赖**：无（协议先行可 mock 对端开发）。
- **测试**：契约单测（start/message/stop/dispose 全路径）；对 mock server 的进程内 e2e；断线与超时路径。
- **快照**：`tool_subagent` 走 remote provider 的一次委派 transcript（`llm-replay` 驱动 mock 对端）。

### T1.2 `dsh-federation-hub` 服务包

- **交付**：`packages/federation/hub/`。内含：pod 注册表服务（身份、能力声明、在线状态）、WS 端点（pod 拨入 + 委派调用）、token 鉴权（credentials seam 铸造/校验）。
- **要点**：hub 本身是普通 dsh 组合，不新建进程模型；委派执行端在 hub 进程内经 `ctx.agents` 起 agent；未认证连接一律拒绝且不留半开状态；心跳超时把 pod 标记离线并在注册表内排队在途任务状态。
- **依赖**：T1.1 的 wire 词汇定稿（可并行开发，接口对齐后联调）。
- **测试**：注册/心跳/鉴权/离线转换单测；进程内委派往返 e2e。

### T1.3 `dsh-federation-client` pod 插件

- **交付**：`packages/federation/client/`。外拨连接、心跳、能力声明（工作区/沙箱模式）、接受委派并在本进程起 agent 执行。
- **要点**：只外拨不监听；能力声明之外的委派请求拒绝；执行用本 pod 的模型路由与凭证；结果携带 usage。
- **依赖**：T1.2。
- **测试**：能力声明过滤、委派执行、断线重连后注册表状态恢复。

### T1.4 组合层与 profile

- **交付**：`federation` profile（hub 侧）与 pod 组合（复用既有 profile + federation client 行）；cordis.patch.yml 行内注释说明每行职责；`--dump-config` 输出验证。
- **依赖**：T1.1–T1.3。
- **测试**：组合加载测试（参照既有 bundle 测试形态）；`verify-cordis-config` 通过。

### T1.5 跨进程 e2e 与快照

- **交付**：双进程 fixture（hub + pod，`llm-replay` 提供确定性模型行为）：委派往返、中途断线、恢复；快照收录。
- **依赖**：T1.4。
- **验收**：设计文档 Acceptance criteria 第 1 条全绿。

### T1.6 文档与笔记收口

- **交付**：三个新包双语 README；`gen-doc-graphs` 再生成（新 seam 入表）；config catalog 更新；Agent Note 从 proposed 推进 M1 已实现部分。
- **依赖**：T1.5。

---

## M2 只读原生体验（v1）

**目标**：pod 的本地 UI 原生呈现远端（hub）会话：列表、搜索、实时渲染，全部只读。

### T2.1 联邦会话源 seam

- **交付**：Service Definition（工作名 `ctx.sessionSources`，归属包定稿时确认）+ 本地实现（包装既有 sessions/sessionQuery/projections，行为与现状等价）。
- **要点**：操作面限定设计文档列出的稳定子集（列表/搜索/打开订阅/fork/删除/改名/标题/todo/审批读取）；不引入新词汇的本地方向零行为变化。
- **测试**：本地实现与既有路径的等价性测试（行为账本）。
- **依赖**：M1。

### T2.2 hub 侧管理契约暴露

- **交付**：hub 把 apiProxy 浏览器契约的读子集（+ `read` 级 token 校验）经 pod 连接暴露。
- **要点**：同一契约服务浏览器与 pod，不另立协议；版本号随握手交换。
- **依赖**：T2.1（接口冻结后）。

### T2.3 pod 侧远端源与镜像流

- **交付**：远端源实现（代理到 T2.2 端点）+ 会话事件订阅 + projection 基线同步。
- **要点**：断线时远端源标记 degraded 而非报错；重连后从上次 seq 续传。
- **依赖**：T2.2。

### T2.4 UI 聚合与降级渲染

- **交付**：会话列表来源徽标与筛选；远端会话用本地渲染器打开；未知节点类型 generic 卡片降级；含不可渲染节点的会话打标。
- **依赖**：T2.3。
- **测试**：UI 组件测试 + 快照（远端会话打开的 transcript 渲染）。

### T2.5 收口

测试补全、双语 README、Agent Note 推进。验收：设计文档 Acceptance criteria 第 2、3 条。

---

## M3 命令级（v2）

**目标**：pod 可对远端会话发言，审批/问询路由回指挥端。

### T3.1 `remote_send` 命令路由

pod → 写者节点 inbox 的消息投递；顺序与幂等语义；写者离线时的明确失败。依赖 T2.3。

### T3.2 审批与问询回传桥

hub 侧注册 `approval/request` waterfall 转发 listener——不拥有决策则 `next()`，拿到远端答案则 claim；转发失败自然落回 fail-closed 默认（`'unavailable'`）。注意 scope-filtered dispatch：listener 必须能收到被指挥会话 agent 的请求。`ctx.userQuestions` 经其 `registerProvider` 注册远端转发 provider。目标为持有 `command` token 的连接，pod 本地弹窗；无应答者保持 fail-closed。依赖 T3.1。

### T3.3 断线语义与 e2e

命令在途断线、重发、重复审批请求的端到端覆盖。验收：设计文档 Acceptance criteria 第 4 条。

---

## M4 管理与漫游（v3）

**目标**：会话可跨节点漫游，共享存储落地，单写者租约成立。

### T4.1 远端会话持久化 provider

本地先落盘（spool）+ 异步上传 hub 存储；seq 单调续传；hub 不可达不影响本地完成 turn。参照 SQLite provider 的写批/校验纪律，网络路径不进 turn 关键路径。resume/takeover 侧以 `ctx.sessionPersistence` 后端落地——子类化 `SessionPersistence` 继承 `append`/`readFrom`/`prepare` 与 revision 语义，直接拿到 flush、turn 边界与 stale-writer 检查钩子，无需在外部自行对齐。

### T4.2 所有权租约与转移协议

hub 租约表；交接 = flush → release → 新节点 acquire → resume；stale-writer 拒绝（语义对齐现有持久化检查）。

### T4.3 fork-to-local / push-to-hub

会话管理菜单项；信封携带 dsh 版本，读端不认识的事件类型拒绝接手；UI 如实提示"会话连续性 ≠ 工作连续性"。依赖 T4.1、T4.2。

### T4.4 收口

验收：设计文档 Acceptance criteria 第 5、6 条（含"无凭证材料跨节点"负向测试）。

---

## M5 peer 与细粒度（v4，可选）

按需启动，不阻塞前四个里程碑：

- **T5.1** hub 中继 pod↔pod 委派（同一 wire 第三方向）。
- **T5.2** capability-server 粒度：remote `ctx.fs`/`ctx.subprocess` provider（E2B 形状的联邦变体）。
- **T5.3** 直连优化（overlay 网络下跳过 hub 中继）。

---

## 待决策清单（开工前定稿，随决策更新本文档）

1. `ctx.sessionSources` 的最终命名与归属包（M2 开工前）。
2. token 的铸造/吊销载体：CLI 子命令还是 hub Web UI（M1 开工前，M1 可先用手工配置文件）。
3. hub 侧联邦会话存储后端：复用 SQLite provider 还是新增表结构（M4 前）。
4. 心跳间隔、离线判定、在途任务排队上限等 tunable 的默认值（M1 实现时按 Config 字段落，取值进 Agent Note）。
5. M2 管理 wire 的版本协商具体形式（握手字段 vs URL 版本段）。
