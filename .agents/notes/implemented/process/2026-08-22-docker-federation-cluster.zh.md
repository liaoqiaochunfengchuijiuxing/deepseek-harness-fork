# Agent Note: Docker Hub+Pod 联邦集群部署

Status: implemented

[English](2026-08-22-docker-federation-cluster.md) | 中文

## Problem

运行联邦拓扑（一个 hub、N 个 pod）需要逐台手工准备：每个节点都要自己的检出、构建、`DSH_HOME` 与环境变量接线，没有可复现的 pod Web UI 对接 hub 联邦 WebSocket 端点的组合方式。

## Decision

仓库根目录提供单镜像 Docker 部署。`Dockerfile` 构建一个镜像（`node:22-bookworm-slim`、pnpm 11.7.0、`pnpm install --frozen-lockfile && pnpm run build`），内含 CLI 与全部 workspace 包。`docker-compose.yml` 用该镜像运行三个服务：

| 服务 | Web UI | 角色 | `DSH_HOME`（命名卷） |
| --- | --- | --- | --- |
| `hub` | `3080:3080` | 联邦 hub + 会话权威 | `/data/hub`（`hub_data`） |
| `pod-1` | `3081:3080` | 外拨联邦客户端 | `/data/pod-1`（`pod1_data`） |
| `pod-2` | `3082:3080` | 外拨联邦客户端 | `/data/pod-2`（`pod2_data`） |

每个服务以 `node apps/cli/lib/bin.js --profile web --patch <联邦 patch> --no-open` 启动。hub 额外发布 `3088:3088` 供其联邦 WebSocket 使用。Pod 经 compose 桥接网络（`dsh-net`）拨向 `ws://hub:3088/federation/connect`，绝不监听入站连接，维持「pod 只外拨」规则。`DSH_HOME` 与 `DSH_STORAGE_DIR` 指向挂载卷，会话、存储、profile、设置与凭证在容器替换后得以存续。

两个联邦 profile patch 各新增 `webserver` 条目，从 `ctx.webStartup` 取 `host`/`port` 并以 `0.0.0.0` 兜底，因为 web profile 的 `127.0.0.1` 默认值在容器外不可达。hub patch 的联邦 WS 默认端口从 `3080` 改为 `3088`（仍可通过 `DSH_FEDERATION_PORT`/`DSH_FEDERATION_HOST` 覆盖）：`3080` 与同进程的 webserver 监听冲突。client patch 的默认端点随之改为 `ws://127.0.0.1:3088/federation/connect`，其 `||` 环境变量兜底改为 `??`，空字符串不再静默选中默认值。

`DEEPSEEK_API_KEY` 与 `DSH_FEDERATION_TOKEN` 为必填（compose 的 `${VAR:?message}` 语法）：缺少时部署在 `docker compose up` 即响亮失败并指向 `.env.example`，而不是带着失效凭证启动。仓库不携带任何凭证值。

## Alternatives considered

**每种角色一个镜像（hub 镜像、pod 镜像）。** 拒绝：角色差异只在启动参数与 patch 文件；单镜像共享构建缓存，部署矩阵只有一个制品。

**用提交的默认值配 compose `env_file`。** 拒绝：任何提交的凭证默认值都是泄漏面；必填变量语法在启动时响亮失败，`.env` 保持 gitignore。

**联邦 WS 留在 `3080` 并按路径区分。** 拒绝：webserver 已占用同进程的 `3080`；hub 需要独立的监听端口，`3088` 相邻且不冲突。

## Consequences

集群现在以 `cp .env.example .env`、填入两个密钥、然后 `docker compose up -d --build` 起步。联邦会话经命名卷在重启后存续。hub 联邦端口的默认值变更（`3080` → `3088`）作用于所有未设 `DSH_FEDERATION_PORT` 的 hub patch 使用方；预发布阶段，旧默认值不受任何兼容性承诺保护。两个 patch 中 webserver 的 `0.0.0.0` 兜底在 `ctx.webStartup` 缺失时绑定全部网卡，这只在容器网络内恰当——非 Docker 用户走 web profile 自身的 `127.0.0.1` 默认值，不受影响。
