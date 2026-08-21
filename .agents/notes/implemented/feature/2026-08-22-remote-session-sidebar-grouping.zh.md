# Agent Note: 侧边栏按来源源分组远端联邦会话

Status: implemented

[English](2026-08-22-remote-session-sidebar-grouping.md) | 中文

## Problem

Pod 侧边栏把经联邦会话源导入的 hub 会话列在「未分组」下。分组逻辑用会话 cwd 匹配本地注册的 Workspace，而 hub 会话的 cwd 指向 pod 上没有任何 Workspace 注册的主机侧目录。分组信号本已端到端存在——host BFF 为每个远端行标记 `sourceId`、`sourceName`、`isRemote`、`isDegraded`、`readOnly`，API、runtime 与 UI 类型也都声明了这些字段——但 wire schema 漏掉了它们，zod 默认的未知键剥离在客户端解析时将其删除，runtime 的列表投影也未把它们拷入 store 行。

## Decision

三层各补自己拥有的字段，闭合该缺口：

- `sessionSummarySchema`（dsh-host-apiproxy）显式声明五个可选远端标记，客户端响应解析因此保留它们。API 类型 `SessionSummary` 早已声明这些字段；schema 相对其自身的 cast 类型过期了。
- `SessionRuntime.projectList` 把 `sourceId`、`sourceName`、`isRemote`、`isDegraded`、`readOnly` 从列表条目拷入 store 行，与其既有逐字段 spread 模式一致。
- `groupByWorkspace`（dsh-client-ui-workspace）把 `isRemote` 行路由到按 `sourceId` 一组（键 `remote:<sourceId>`，标签取 `sourceName`、以键兜底），置于 Workspace 组之后、未分组桶之前。`GroupNode` 新增 `remote?: true` 派生事实，组头渲染器据此选用来源标签而非「未分组」词条；导出的 `currentGroupKey(list, workspaces, sessionId)` helper 是 `deriveGroups` 与浏览器自动展开 effect 共用的唯一定位实现，选中的远端会话因此高亮并展开自己的 `remote:` 组而非未分组。

远端组在所有 `workspaceId` 缺席之处刻意与未分组桶同级降级：无重命名/删除菜单、无 Workspace 拖拽/hover 卡、不写 Host 顺序，成员顺序恒为 recency。远端 id 也被排除在浏览器的未分组顺序账目之外。

## Alternatives considered

**为每个远端来源注册虚拟 Workspace。** 拒绝：为解决展示问题在 Host 账目模型里伪造 Workspace 实体，污染 workspace 的重命名/删除/顺序语义。

**渲染器按键前缀识别远端组。** 拒绝：渲染器要跨树契约嗅探 `remote:` 字符串约定；`GroupNode.remote` 事实直接携带该分类。

**单一全局「远端」组。** 拒绝：存在多个联邦来源（多个 hub，或 hub 加 peer pod）时，单一桶丢失每个会话的来源信息，而这正是来源名携带的内容。

## Consequences

Pod 侧边栏现在按联邦来源显示带标签的分组（默认「Hub Sessions」），不再把远端会话散落在未分组中；选中远端会话展开其所属组。远端行保留既有的逐行远端/降级徽标。远端组不支持手动排序——顺序恒为 recency——也没有组内新建动作，因为其中的会话属于另一节点。分组只需客户端可见字段，因此该行为由各层的 keyless 单测（schema 解析、store 投影、树派生）完整覆盖，无需真实联邦部署。
