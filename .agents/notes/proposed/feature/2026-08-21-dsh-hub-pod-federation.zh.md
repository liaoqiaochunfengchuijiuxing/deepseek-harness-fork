# Agent Note: 面向多节点 DeepSeek Harness 的 hub-pod 联邦

Status: proposed

[English](2026-08-21-dsh-hub-pod-federation.md) | 中文

## Problem

DeepSeek Harness 是单进程、单用户、本地优先的工作台。在多台机器上同时使用它的用户今天无法：从另一台设备打开某个节点的会话并实时看到进展；从另一个节点继续在别处开始的工作；或者让一个节点的 agent 把任务交给另一个节点执行。会话活在单个进程的内存里，持久化是本地文件上的单写者模型；Web 客户端是与宿主同进程的插件树；节点之间没有发现机制、没有跨节点传输，也没有共享的身份或授权。

用通用的分布式状态复制来解决这个问题会与产品自身的不变量正面冲突：会话日志是单一逻辑序的 append-only 流，`deriveMessages()` 和全部运行时 invariant 都依赖这个顺序，已发布的持久化实现对 stale writer 是拒绝而不是合并并发写。设计必须在引入多写者会话之外，交付多节点可达与委派能力。

## Proposal

**hub-pod 联邦**：一个云端 **hub** 作为控制面，任意数量的 **pod**（机器或设备）作为数据面。hub 本身是一个运行 federation profile 的 dsh 实例--pod 注册表、拨入中继、会话存储、token 认证。pod 是带联邦客户端插件的 dsh 实例：通过一条持久的认证连接向 hub 外拨、声明自身能力、接受委派的工作。

联邦中的全部交互恰好是**两种动词**：

- **会话客户端**（人驱动）：pod 或浏览器接入一个属于远端节点的活会话--实时看到事件流、发消息、回应审批。会话仍归属主所有，接入端只是遥控器。
- **委派**（agent 驱动）：一个节点的模型通过 `ctx.subagents` seam 把有边界的任务交给另一个节点上的 agent。会话属于委派方，执行和工具属于执行节点。

云端到 pod、pod 到云端、pod 到 peer 的委派都是**同一个**机制：指向不同 endpoint 的 remote subagent provider。一份 wire 协议、一份授权设计、一份断线词汇，覆盖三个部署方向。

## Topology and roles

- **Hub（云端，控制面）：** 运行 `federation` profile 的 dsh 实例。拥有 pod 注册表（身份、能力声明、在线状态）、pod 间消息中继（pod 无需任何入站端口）、联邦会话日志存储、token 认证终结点，以及供其他节点调用的委派端点。它复用现有的 webserver、credentials、settings、telemetry 服务，不另建平行技术栈。
- **Pod（设备，数据面）：** 带联邦客户端插件的 dsh 实例。用 per-pod token 向 hub 外拨，保持连接存活，声明接受什么工作（工作区、沙箱模式、可用时段），用自己的 agent 循环、模型路由和凭证执行委派任务，并可以在本地原生渲染 hub 与 peer 的会话。
- **连接方向：** pod 永远外拨；hub 从不主动连接 pod。Peer 流量初期经 hub 的连接对中继；直连传输（overlay 网络、打洞）是后续优化。

## Session ownership and synchronization

一个会话任一时刻只有一个写者节点，其余端都是读者。"完全同步"由订阅交付，而不是复制：

- 写者的 durable 事件批次在持久化时流向 hub（本地先落盘、异步上传；网络写不进 turn 关键路径）。
- 任何节点或浏览器通过 hub 订阅会话流，并用自己的 projection 渲染--既有的"UI 从日志渲染"规则使远程渲染是数据驱动的，不投递任何远端代码。
- 管理操作（删除、改名、fork）在属主节点执行；pod 只是发起方。
- 把工作挪到别处是 **fork-to-local** 或 **release 后 resume**：hub 中的所有权租约记录当前写者；交接在 flush 后释放租约，下一个节点从存储的日志 resume。多主并发写按设计排除在范围之外。

## Pod modes

Pod 模式是组合选择（profile），不是独立产品：

| 模式 | 会话归属 | 执行位置 | 形态 |
|---|---|---|---|
| 云端 | hub | hub，工具落到 pod 或远程沙箱 | hub agent + pod 作为执行者 |
| 本地 | pod 自己 | pod 自己 | 今天的 dsh web，不变 |
| Peer | 发起委派的节点 | 被指向的 peer pod | 指向 peer 的 remote subagent |

模式切换永不热迁移活会话；它开启新会话或 fork，加上指针交接。

## Native experience: the federation session source

远端会话必须作为一等对象出现在 pod 自己的 UI 里，而不是别处的一个浏览器标签。pod 上的**联邦会话源** seam 暴露产品已有的一小组稳定操作面--工作区与会话列表、全文搜索、带实时流的打开、fork/删除/改名、标题与 todo projection、审批--配两个实现：本地（今天的进程内服务）与远端（经 pod-hub 连接代理）。远端实现说 hub 的 apiProxy 已暴露给自家浏览器客户端的契约的一个受限子集，一份契约两处使用。

渲染降级，永不拒绝同步：不认识的会话节点类型回退到既有的 generic 卡片；握手交换版本，UI 标出包含本 pod 无法渲染节点的会话。

`fork-to-local` 及其反向操作从这张表面自然产生，成为普通菜单项--交接的体验变成"在别处打开同一份工作"。

## Approval and question routing

当 pod 指挥一个 hub 会话、hub 的 agent 触发 fail-closed 的 approval waterfall 或 `ctx.userQuestions` 时，请求沿指挥 pod 的连接路由回来，渲染在该 pod 的 UI 上。无人值守 pod 上的委派 run 按该 pod 的 permission preset（沙箱化的 workspace-write）运行；没有应答者时按现状 fail closed。

## Security model

- Per-pod token，经 credentials seam 铸造与存储；全程 TLS。
- Token 能力分级：`read`（列表、搜索、实时流）、`command`（发言、回应审批）、`manage`（fork、删除、改名）、`takeover`（resume 到本节点）。默认只发 `read`。
- 双向能力声明：pod 声明接受什么工作（工作区、沙箱模式、时段）；hub 注册表声明每个 pod 可以触达什么。超出任一侧声明的请求被拒绝。
- 凭证、模型路由、settings 永不在节点间转移。委派传递的是任务不是 key；各自支付自己的模型用量，并在 subagent 结果中上报。

## Wire and versioning

委派 wire 在 pod-hub 持久连接上复用 subagent 词汇（start、message、stop reason、continuation、usage）。管理 wire 是上述 apiProxy 浏览器契约子集。握手交换 dsh 版本；联邦会话信封记录写入它的版本。不认识某事件类型的节点拒绝接手该会话而不是猜测；实时流按降级规则容忍不可渲染的未知类型。

会话同步不携带工作区文件。跨节点的工作经由共享 git remote 展开（hub 可以托管）；一个 resume 时没有工作区的会话是会话连续性而不是工作连续性，UI 要如实说明。

## Package inventory (planned)

| 包 | 侧 | 角色 |
|---|---|---|
| `dsh-federation-hub` | hub | pod 注册表、中继、租约表、委派端点、管理契约暴露 |
| `dsh-federation-client` | pod | 外拨连接、能力声明、委派执行、会话上传 |
| `dsh-subagent-remote` | 两侧 | `ctx.subagents` 的 remote provider（一份 wire，全部委派方向） |
| `dsh-session-source-federation` | pod | 远端会话源 + 基于 `ctx.sessionSources`（工作名）的 UI 聚合 |
| profile 增补 | 两侧 | `federation`（hub）、`pod-cloud` / `pod-local` 组合 |

## Phasing

- v0：hub 带注册表、外拨连接和 `dsh-subagent-remote` 服务端端点；pod 客户端插件；hub 委派 pod；pod 用浏览器触达 hub 会话。两个日常方向（云端驱动 pod、pod 指挥云端）都可用。
- v1：只读级联邦会话源--pod 上原生的远端会话列表、搜索、实时渲染。
- v2：命令级--`remote_send`、审批与问询路由回指挥 pod。
- v3：manage 与 takeover--fork-to-local、租约交接、双向漫游。
- v4：peer 中继、可选的 capability-server 粒度（远端 `ctx.fs`/`ctx.subprocess` provider，E2B 形状）、pod 直连传输。

## Alternatives considered

**无 hub 的对等联邦。** 作为主形态被否决：每个 pod 都要自带发现、NAT 穿透和决定写权的所有权协议；hub 恰好把这三件事集中化，并使 pod 保持纯外拨。无 hub 的局域网模式以后可以作为优化保留，但不作为地基。

**多主会话复制（CRDT 或其他）。** 被否决：会话日志的单一逻辑序对 `deriveMessages()`、replay 和 invariant 是承重结构，而 turn 具有不可交换的因果序。订阅加单写者租约交付了想要的可观察行为--每个端实时看到一切--而无需共识机制。

**网关代理整个 Web GUI。** 被否决：浏览器 bundle 是每宿主一份的插件树（`ctx.clientModules`、slots、HMR）；代理它等于做前端组合的联邦。用本地渲染器从 projection 原生渲染，彻底避免投递远端代码。

**统一的跨实例工具注册表。** 被否决：把每个节点的工具同步进每次请求的工具视图会膨胀 prompt，并从首个变更 schema token 起使 KV cache 失效。通过一个稳定工具（remote subagent）委派，让每个模型的视图保持本地。

**策展式交接上下文格式。** 被否决：会话日志本身已是完整的可移植工作状态；摘要损失保真且会漂移。交接携带信封（元数据、版本）加原始日志后缀。

**hub 作为独立的非 dsh 服务。** 被否决：那会重新实现 dsh profile 已有的认证、配置、存储和遥测。hub 以 dsh 实例运行，保持一套运维词汇。

**先做 capability-server 粒度（hub agent 的每个工具调用都落在 pod 上执行）。** 延后而非否决：subagent 粒度的委派先落地，因为它匹配既有 seam 及其 continuation 语义；远端 fs/subprocess provider 留作 v4 的细粒度远程控制精修。

## Acceptance criteria

- 两台机器加一个 hub 部署：hub 的 UI 列出两个 pod 及实时在线状态；hub agent 的 `tool_subagent` 调用经 remote provider 在 pod 上完成工作、返回结构化结果与用量，并在 pod 中途断连时映射出 stop reason。
- 任意设备的浏览器经认证通道打开 hub 所属会话，看到流式输出与多标签一致性，无未认证端口。
- 在 pod 上，远端会话出现在本地会话列表并带来源徽标；打开后用本地渲染器渲染；未知节点类型降级为 generic 卡片而不是报错。
- 从 pod 发往 hub 会话的命令到达该会话 inbox；该会话触发的审批出现在指挥 pod 上，任何地方都不会静默自动批准。
- fork 到 pod 的会话 resume 后 derived messages 完全一致；对写权租约仍被另一个活节点持有的会话发起 resume 时，以明确的理由失败。
- 任何节点都不会收到其他节点的凭证材料；委派结果只携带任务输出与用量。

## Risks

- **hub 是高价值目标。** 它可以指挥每个 pod；hub 的 token 集失守即整个集群失守。缓解是默认最小权限、两端能力声明，以及 pod 对 hub 在声明工作之外保持不信任。
- **可用性耦合。** hub 不可达时会话必须仍能完成 turn--因此是本地先落盘加异步上传，不是 turn 路径上的同步远端持久化。
- **集群版本偏斜。** 信封版本与遇未知即拒绝让旧 pod 安全但嘈杂；"先升 hub"的集群升级纪律是设计明知承担的运维成本。
- **向多主蔓延的范围失控。** 每一个"让两端都能写"的请求都要用 fork 或租约交接回答；seam 应让受支持的路径成为容易的路径。
- **远端管理的延迟。** 慢链路上的列表与搜索可能不如本地流畅；pod 侧缓存 projection 可以接受，远端状态的本地变更不行。
- **运维负担。** 现在需要有人托管并备份 hub 及其会话存储；对单用户而言这是真实成本，纯 overlay 网络部署（每个节点可达、每节点一个浏览器标签）可以避开它--这也是该模式被保留为零开发底座的原因。
