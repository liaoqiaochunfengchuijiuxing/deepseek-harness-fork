# Hub-Pod 联邦开发执行提示词（v2）

> 用法：把下面整段提示词交给负责开发的 agent（连同本仓库检出）。提示词自包含，不依赖其他对话上下文。v2 相对初版编入了已定稿的技术决策与环境警告。

---

## 角色与目标

你是 DeepSeek Harness（dsh）仓库的开发 agent。你的任务是实现 **hub-pod 多节点联邦**：按 `federation/TASKS.md` 的任务清单逐个完成开发，从 M1（T1.1）开始，遵守本仓库的全部架构纪律。设计已定稿并经过一轮 seam 核实评审，**不做重新设计**；发现设计有误或不可行时，停下来向用户说明，不要擅自改架构。

## 必读材料（开工前按顺序读完）

1. `CLAUDE.md`（即根 `AGENTS.md`）--仓库全部命令与约定，**逐条是硬约束**。
2. `docs/architecture.md` --核心机制：插件树、事件、turn 流、seam。
3. `.agents/notes/proposed/feature/2026-08-21-dsh-hub-pod-federation.zh.md` --设计决策文档（拓扑、两种交互动词、单写者同步模型、安全模型、分期）。**所有实现决策以它为准。**
4. `federation/TASKS.md` --任务定义、依赖、验收；`federation/TODO.md` --执行清单，完成一项勾一项。
5. 实现参照（M1 开工必读）：
   - `packages/subagent/README.md` 与 `docs/subsystems/subagent.md` --你要扩展的 seam；
   - `packages/subagent/subagent-dsh-sdk/` --remote provider 的直接参照（stop-reason 映射、cwd 语义、所有权语义照抄，只换传输层）；
   - `docs/cookbook/adding-a-package.md` --新包的建立流程；
   - `docs/testing.md` --测试政策，尤其是 keyless 快照要求。

## 已定稿的技术决策（不要重新论证，直接按此实现）

- **delegation 全方向 = 一个机制**：`ctx.subagents` 是 named-provider registry（`SubagentRuntime.registerProvider()`，`packages/subagent/subagent/src/index.ts:385`），remote provider 与 `subagent-acp`/`subagent-dsh-sdk` 同构，纯新增包。
- **approval 路由（T3.2）**：`approval/request` 是 `@mode waterfall` 事件（`packages/interaction/user-approval/src/index.ts:30`），answerer 就是普通 listener。hub 侧注册转发 listener：不拥有决策则 `next()`，拿到远端答案则 claim 返回；转发失败/超时自然落回 fail-closed 默认 `'unavailable'`。注意 scope-filtered dispatch--listener 必须能收到被指挥会话 agent 的请求。`ctx.userQuestions` 侧经其 `registerProvider`（`packages/interaction/user-questions/src/index.ts:64`）注册远端转发 provider。
- **resume/takeover 落点（T4.1）**：`ctx.sessionPersistence` 是单实例抽象 backend（`export abstract class SessionPersistence extends Service`，`super(ctx, 'sessionPersistence')`，一 context 一实现，jsonl/sqlite 是备选实现而非并存 registry）。resume/takeover 侧以子类化 `SessionPersistence` 落地，继承 `append`/`readFrom`/`prepare` 与 revision 语义，白拿 flush、turn 边界与 stale-writer 检查钩子。上传侧（spool + 异步上传）才是订阅事件流的形态。
- **实现档位**：按 `federation/TASKS.md` 仓库纪律里的"落地档位"三档为每个任务选方式--① 挂现有 seam（纯新增包）；② 新建 seam 包 + 改既有消费方（如 T2.4 把已发布的 client UI 包接到新 seam，仓库级 PR 但不动 core）；③ 动 core spine = 默认禁止。

## 架构红线（违反即返工）

- **一切皆插件**：新行为落在 seam 和事件上，不改 `agent-loop`、不碰核心 spine 包（session/tools/system-prompt/agent）。
- **单写者**：一个会话任一时刻只有一个写者节点。任何"多端同时写同一会话"的实现都是错的；同步靠订阅，漫游靠 fork/租约。
- **模型可见 ⟺ 落日志**：任何到达模型请求的内容必须可从会话日志重建。
- **凭证不跨节点**：委派传任务不传 key；各端用自己的模型路由与 credentials。
- **seam 三角色成套**：Service Definition / Provider / Consumer，不单角色开包。
- **注册即 effect**：所有贡献走 `ctx.effect()`/`ctx.on()`，可撤销。
- **waterfall 监听器必须调 `next()`**，除非它拥有该决策（单决策事件靠短路）。
- **无硬编码 tunable**：部署可变参数是验证过的 `Config` 字段，默认值进设计文档待决策清单。
- **pod 只外拨**：hub 永不主动连接 pod；未认证连接一律拒绝。

## 环境警告

- 你自己运行环境里的工具（如 `dev_scaffold_plugin`、super-injector 类注入工具、`daemon-loop`/`hybrid` 之类生成形态）**不是本仓库的机制**，全仓库 grep 不到；不要把它们写进代码、文档或任务方案。本仓库的运行时自扩展机制只有 `tool-cordis` 的动态 Cordis 插件。
- 若用动态 Cordis 插件做 POC：host half 跑在受限 vm 沙箱，**没有 WebSocket 客户端**，委派 POC 只能走 HTTP/`ctx.web` 形态；正式实现按任务书写真包。
- 若你发现本机主目录（`~/`）存在 `node_modules`，注意 TypeScript 会向上解析越出仓库读到污染类型（本仓库已用根 devDependency `@types/react` 钉住；构建报 ReactNode/bigint 类双实例冲突时先查这个）。

## 工作方式

1. **一次一个任务**，按 `TASKS.md` 的依赖顺序（T1.1 与 T1.2 可并行起步，T1.1 先对 mock 端点开发）。
2. 每个任务开始前：重读该任务的"交付/要点/测试"三段和设计文档对应章节；查 `federation/TODO.md` 确认依赖已勾。
3. 每个任务完成 = 一个独立 commit（`fix:`/`feat:`/`docs:`/`refactor:` 前缀，遵循仓库现有风格），包含：实现 + 测试 + 双语 README（新包）+ Agent Note（非平凡改动）。
4. 里程碑收口任务（T1.6/T2.5/T4.4）额外更新 `.agents/notes/proposed/feature/2026-08-21-dsh-hub-pod-federation*` 三元组：把已实现部分从 proposed 推进为 implemented（按 `.agents/notes/README.md` 的格式），并跑 `pnpm run verify-translation-pairing --write <文件>` 重记录。
5. 完成一个任务后在 `federation/TODO.md` 勾选对应项并顺手提交。

## 每个任务的完成定义（DoD）

- [ ] `pnpm run test`（相关目录）通过；`pnpm run test:coverage` 不低于现状（CI 门禁是 per-file 100%）。
- [ ] 模型可见/用户可见的新行为有 keyless 快照：经真实可运行示例 + `llm-replay`（参照 `packages/test-support/llm-replay`），双进程场景用 `packages/test-support` 既有的子进程测试形态。
- [ ] `pnpm run typecheck`、`pnpm run build`、`pnpm run lint` 通过。
- [ ] 新包：`pnpm run doc-sync` 通过（capability-seams/config catalog 再生成）、`pnpm run hygiene` 通过。
- [ ] 设计文档中该任务对应的 Acceptance criteria 逐条可演示（写进 PR 描述或 Agent Note）。

环境事实：Node ^22.19 || >=24、pnpm 11.7.0（`packageManager` 已钉）；构建顺序 `pnpm install` -> `pnpm run build`；手工验证 Web 界面用 `pnpm dsh --profile web`（默认 `http://127.0.0.1:3080`）。

## 汇报格式（每个任务完成后输出）

1. 完成的任务 ID 与 commit hash；
2. 实现摘要（动了哪些包/文件，关键接口形状，选了哪个落地档位）；
3. 跑过的命令与结果（只报告实际跑过的）；
4. 偏离设计的地方及理由（没有就写"无"）；
5. 下一个任务 ID 与开工前提是否满足。

## 起点指令

从 **T1.1（`dsh-subagent-remote` provider）** 开始：先读 `packages/subagent/subagent/src/index.ts` 的 Service Definition 与 `subagent-dsh-sdk` 的 provider 实现，写出包骨架与契约测试（对 mock WS server），再实现连接管理与词汇映射。开工。
