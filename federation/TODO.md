# Hub-Pod 联邦 TODO

执行清单，任务定义与验收见 [TASKS.md](TASKS.md)。勾选一个任务前确认其"依赖"列全部完成。

## M0 前置（已完成）

- [x] 设计文档落档：`.agents/notes/implemented/feature/2026-08-21-dsh-hub-pod-federation`（en/zh/i18n 三元组）
- [x] 任务书与 TODO 拆解（本文件）
- [ ] 待决策 #2：token 铸造载体（M1 可暂用手工配置）

## M1 委派通道（v0）

- [x] T1.1 `dsh-subagent-remote` provider 客户端半边
- [x] T1.2 `dsh-federation-hub` 服务包（注册表/WS/鉴权/委派端）
- [x] T1.3 `dsh-federation-client` pod 插件（外拨/能力声明/执行）
- [x] T1.4 组合层：federation profile + pod 组合
- [x] T1.5 双进程 e2e + keyless 快照
- [x] T1.6 文档与 Agent Note 收口

## M2 只读原生体验（v1）

- [x] 决策 #1：会话源 seam 命名为 `ctx.sessionSources`，Service Definition 归属 `@deepseek-ai/dsh-session-source`，本地实现归属 `@deepseek-ai/dsh-session-source-local`，联邦远端实现归属 `@deepseek-ai/dsh-session-source-federation`
- [x] T2.1 联邦会话源 seam（Service Definition + 本地实现）
- [x] T2.2 hub 管理契约读子集暴露
- [x] T2.3 pod 远端源 + 镜像流
- [x] T2.4 UI 聚合与降级渲染
- [x] T2.5 测试/快照/文档收口

## M3 命令级（v2）

- [x] T3.1 `remote_send` 命令路由
- [x] T3.2 审批与问询回传桥
- [x] T3.3 断线语义 e2e

## M4 管理与漫游（v3）

- [ ] 待决策 #3：hub 会话存储后端
- [ ] T4.1 远端会话持久化 provider（spool + 异步上传）
- [ ] T4.2 所有权租约与转移协议
- [ ] T4.3 fork-to-local / push-to-hub
- [ ] T4.4 测试/文档收口

## M5 peer 与细粒度（v4，可选）

- [ ] T5.1 hub 中继 pod↔pod
- [ ] T5.2 capability-server 粒度（remote fs/subprocess）
- [ ] T5.3 直连优化

## 完成定义（里程碑级）

- **M1**：两台机器 + hub 部署下，hub agent 经 `tool_subagent` remote provider 在 pod 完成工作；断线映射 stop reason；pod 浏览器经认证通道实时看 hub 会话。
- **M2**：pod 本地会话列表含远端会话（来源徽标）；打开用本地渲染器；未知节点降级 generic。
- **M3**：pod 发言到达远端 inbox；审批出现在指挥 pod；任何路径无静默自动批准。
- **M4**：fork-to-local 后 derived messages 一致；租约被活节点持有时 resume 以明确理由失败；无凭证跨节点（负向测试）。
