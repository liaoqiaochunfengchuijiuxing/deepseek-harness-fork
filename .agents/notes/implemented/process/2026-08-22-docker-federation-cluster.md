# Agent Note: Docker Hub+Pod federation cluster deployment

Status: implemented

English | [中文](2026-08-22-docker-federation-cluster.zh.md)

## Problem

Running the federation topology (one hub, N pods) required a manual per-host setup: each node needed its own checkout, build, `DSH_HOME`, and environment wiring, with no reproducible composition of the pod web UIs against the hub's federation WebSocket endpoint.

## Decision

The repository root carries a single-image Docker deployment. `Dockerfile` builds one image (`node:22-bookworm-slim`, pnpm 11.7.0, `pnpm install --frozen-lockfile && pnpm run build`) containing the CLI and every workspace package. `docker-compose.yml` runs three services from that image:

| Service | Web UI | Role | `DSH_HOME` (named volume) | Workspace space (named volume) |
| --- | --- | --- | --- | --- |
| `hub` | `3080:3080` | federation hub + session authority | `/data/hub` (`hub_data`) | `/data/workspace` (`hub_workspace`) — the cloud space |
| `pod-1` | `3081:3080` | outbound federation client | `/data/pod-1` (`pod1_data`) | `/workspace` (`pod1_workspace`) — the pod's local space |
| `pod-2` | `3082:3080` | outbound federation client | `/data/pod-2` (`pod2_data`) | `/workspace` (`pod2_workspace`) — the pod's local space |

Each service launches `node apps/cli/lib/bin.js --profile web --patch <federation patch> --no-open`. The hub additionally publishes `3088:3088` for its federation WebSocket. Pods dial `ws://hub:3088/federation/connect` over the compose bridge network (`dsh-net`) and never listen for inbound connections, preserving the pod-only-dials-out rule. `DSH_HOME` and `DSH_STORAGE_DIR` point at the mounted volume so sessions, storages, profiles, settings, and credentials survive container replacement.

The workspace volumes separate the two session spaces: hub sessions belong to the cloud space (`/data/workspace`), pod sessions to each pod's local space (`/workspace`). A fresh deployment must register each space with `workspace.create` before creating sessions — the Web directory picker starts at the container's `HOME` (`/root`, an ephemeral layer path), and an unregistered first workspace picked there leaves a registration that survives rebuilds while its directory does not, so every new session recreates an empty ghost directory and pod-side materialization copies a meaningless path.

The two federation profile patches gained a `webserver` entry binding `host`/`port` from `ctx.webStartup` with `0.0.0.0` fallbacks, because the web profile's `127.0.0.1` default is unreachable from outside a container. The hub patch's federation WS default port moved from `3080` to `3088` (still overridable through `DSH_FEDERATION_PORT`/`DSH_FEDERATION_HOST`): `3080` collides with the webserver listener in the same process. The client patch's default endpoint moved to `ws://127.0.0.1:3088/federation/connect` to match, and its `||` env fallbacks became `??` so an empty string no longer silently selects the default.

`DEEPSEEK_API_KEY` and `DSH_FEDERATION_TOKEN` are required (`${VAR:?message}` compose syntax): the deployment fails at `docker compose up` with a pointer to `.env.example` instead of starting with dead credentials. No credential value ships in the repository.

Confined shell execution needs a sandbox backend the container kernel can actually enforce. Bubblewrap — the Linux chain's preferred rung — cannot run under Docker's default seccomp profile (unprivileged `CLONE_NEWUSER` is denied, so `bwrap` dies at "Creating new namespace failed"), so the image installs `musl-tools` and runs `pnpm build:native` in `native/landlock-run` after the workspace build, compiling the `landlock-run` launcher for the build architecture. Docker Desktop's kernel (6.x linuxkit) enforces Landlock fully; without the compiled launcher the sandbox-local provider fails closed with `SANDBOX_UNAVAILABLE` on every confined command, because the per-platform binary is a build artifact that neither git nor `pnpm install` ships.

## Alternatives considered

**One image per role (hub image, pod image).** Rejected: the roles differ only in launch arguments and patch file; one image keeps the build cache shared and the deployment matrix at one artifact.

**Compose `env_file` with committed defaults.** Rejected: any committed default for a credential is a leak surface; required-variable syntax fails loud at startup and `.env` stays gitignored.

**Keep the federation WS on `3080` behind a path.** Rejected: the webserver already owns `3080` in the same process; the hub needs a distinct listener port, and `3088` sits adjacent without colliding.

## Consequences

A cluster now comes up with `cp .env.example .env`, filling in two secrets, then `docker compose up -d --build`. Federation sessions survive restarts through the named volumes. The hub's federation port default change (`3080` → `3088`) applies to every consumer of the hub patch without `DSH_FEDERATION_PORT` set; pre-release, no compatibility promise covers the old default. The webserver `0.0.0.0` fallback in both patches binds all interfaces whenever `ctx.webStartup` is absent, which is only appropriate inside a container network — non-Docker users get the web profile's own `127.0.0.1` default and are unaffected.
