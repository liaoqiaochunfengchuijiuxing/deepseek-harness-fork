# Agent Note: 经持久 hub 注册表铸造 per-pod 联邦令牌

Status: implemented

[English](2026-08-22-federation-token-minting.md) | 中文

## Problem

Hub 认证只接受 `token` 配置里的一个共享静态密钥（外加一个 `podId` 限制从未被执行的 `tokens` 映射）。任何出示共享密钥的 pod 都能以任意 `podId` 注册，hub 因此无法区分 pod；凭据泄露迫使整个联邦轮换；吊销需要改配置并重启 hub。设计决策 #2（铸造载体）自 M1 起一直悬置。

## Decision

载体是 CLI，存储是 hub 包拥有的文件注册表。

`dsh-federation-hub` 中的 `token-registry.ts` 是针对单个 JSON 文件的独立模块（无 Cordis）——`tokensPath` 配置，默认 `$DSH_HOME/federation/tokens.json`，以 `0600` 权限经 `withFileLock` 原子写入，每次连接时读取。条目把一个随机 32 字节 base64url 密钥绑定到唯一 `podId`、一个角色（`read`/`command`/`manage`/`takeover`，默认 `command`）与一个标签。对同一 pod 重新签发即轮换：先前活跃条目被吊销，新密钥胜出。吊销设置 `revokedAt` 并在下次连接生效——hub 在每次升级握手时重读文件，无需重启。

`authenticateRequest` 现在解析 `{ role, podId }` 而非裸角色，先查静态配置再查注册表；`handlePodConnection` 强制绑定——声明的身份（`ownerPodId ?? podId`）与凭据绑定不符的注册会被以 `federation/error`（`POD_IDENTITY_MISMATCH`）拒绝并关闭。`ownerPodId` 声明的存在是因为 pod 进程持有第二条联邦连接：其只读会话镜像源（`dsh-session-source-federation`）以自身唯一 id 注册——绝不用 pod 的主 id，那会顶替 pod 的主连接——现在通过 `ownerPodId`（配置 `ownerPodId`/`ownerPodIdEnv`，客户端 bundle 接到 `DSH_POD_ID`）声明归属，绑定检查因此把它认证为所属 pod 的辅助连接。这同时让此前形同虚设的 `TokenConfig.podId` 静态配置字段有了实际语义。注册表路径默认开启，但文件缺失时不贡献任何凭据，既有部署只有铸造之后行为才改变。

`dsh federation-token issue|list|revoke`（`apps/cli` 的新 launcher 子命令）以 hub 的 `$DSH_HOME` 管理注册表——容器部署里即 `docker exec dsh-hub dsh federation-token issue pod-1`。`issue` 只向 stdout 打印一次密钥；`list` 只显示 8 字符前缀；吊销未知 pod 退出 1，让拼写错误暴露出来。

## Alternatives considered

**经 hub Web UI 或斜杠命令铸造。** 拒绝作为主载体：会话级表面会持久记录其转录，新铸造的密钥在展示的那一刻就被写进 hub 会话日志。CLI stdout 是唯一从不落盘密钥的通道。Web UI 在能不经过转录打印密钥之前保持延后。

**把令牌存进 credentials seam。** 拒绝：该 seam 解析并存储被引用的 provider 密钥（`resolve`/`describe`/`set`/`unset`）；它没有签发-轮换-吊销生命周期或 pod 身份绑定的概念，硬套会在通用密钥存储里复制注册表的语义。

**仅在首次注册时签发（首连信任）。** 拒绝：未认证的首连无法与攻击者区分，pod 身份声明必须来自 hub 的操作者而非连接方。

## Consequences

pod 个体可识别、个体可吊销；泄露一个 pod 凭据的代价是一次重签，而非全网轮换。hub 在每次 WebSocket 升级时做一次小文件读（连接很少发生），跨进程 CLI 编辑经锁文件串行化。密钥以明文存于属主独享的注册表文件——与其补充的静态 env token 同一信任姿态，静态 token 保留为引导凭据，使全新 hub 能在任何铸造之前认证 pod。Pod 侧配置不变（`DSH_POD_TOKEN`）；docker-compose 传递 per-pod 的 `DSH_POD1_TOKEN`/`DSH_POD2_TOKEN` 覆盖，缺省回落到共享引导密钥。
