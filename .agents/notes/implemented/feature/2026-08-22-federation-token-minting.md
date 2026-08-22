# Agent Note: Per-pod federation token minting through a durable hub registry

Status: implemented

English | [中文](2026-08-22-federation-token-minting.zh.md)

## Problem

Hub authentication accepted one shared static secret from `token` config (plus a `tokens` map whose `podId` restriction was never enforced). Any pod presenting the shared secret could register under any `podId`, so the hub could not tell pods apart, a leaked credential forced a whole-federation rotation, and revocation required editing config and restarting the hub. Design decision #2 (the minting carrier) was left open since M1.

## Decision

The carrier is the CLI, and the store is a file-backed registry owned by the hub package.

`token-registry.ts` in `dsh-federation-hub` is a standalone module (no Cordis) over one JSON file — `tokensPath` config, default `$DSH_HOME/federation/tokens.json`, written atomically at mode `0600` under `withFileLock`, read per connection. Entries bind a random 32-byte base64url secret to one `podId`, a role (`read`/`command`/`manage`/`takeover`, default `command`), and a label. Re-issuing for a pod rotates: the previous active entry is revoked, the new secret wins. Revocation sets `revokedAt` and takes effect on the next connection — the hub re-reads the file at every upgrade handshake, so no restart is needed.

`authenticateRequest` now resolves `{ role, podId }` instead of a bare role, consulting static config first and the registry second; `handlePodConnection` enforces the binding — a registration whose claimed identity (`ownerPodId ?? podId`) differs from the credential's binding is refused with a `federation/error` (`POD_IDENTITY_MISMATCH`) and closed. The `ownerPodId` claim exists because a pod process holds a second federation connection: its read-only session-mirror source (`dsh-session-source-federation`) registers under its own unique id — never the pod's primary id, which would replace the pod's main connection — and now declares `ownerPodId` (config `ownerPodId`/`ownerPodIdEnv`, wired to `DSH_POD_ID` in the client bundle) so the binding check authenticates it as the owning pod's auxiliary connection. This also makes the previously dead `TokenConfig.podId` static-config field meaningful. The registry path defaults on, but an absent file contributes no credentials, so existing deployments change behavior only by minting.

`dsh federation-token issue|list|revoke` (a new launcher subcommand in `apps/cli`) manages the registry against the hub's `$DSH_HOME` — in container deployments, `docker exec dsh-hub dsh federation-token issue pod-1`. `issue` prints the secret exactly once to stdout; `list` shows only an 8-character prefix; `revoke` of an unknown pod exits 1 so typos surface.

## Alternatives considered

**Mint through the hub's Web UI or a slash command.** Rejected as the primary carrier: a session-scoped surface durably logs its transcript, so a freshly minted secret would be persisted in the hub's session log the moment it was displayed. CLI stdout is the only channel that never writes the secret anywhere. A Web UI remains deferred until it can mint without printing through a transcript.

**Store tokens in the credentials seam.** Rejected: that seam resolves and stores referenced provider secrets (`resolve`/`describe`/`set`/`unset`); it has no notion of issue-rotate-revoke lifecycle or pod-identity binding, and stretching it would duplicate the registry's semantics inside a generic secret store.

**Issue tokens only at first registration (trust-on-first-connect).** Rejected: an unauthenticated first connection cannot be distinguished from an attacker's, and pod identity claims must originate from the hub's operator, not the connecting party.

## Consequences

Pods are individually identifiable and individually revocable; a leaked pod credential costs one re-issue, not a fleet rotation. The hub performs one small file read per WebSocket upgrade (connections are rare), and cross-process CLI edits serialize through the lock file. Secrets live in plaintext inside the owner-only registry file — the same trust posture as the static env token it complements, and the static token remains as the bootstrap credential so a fresh hub can authenticate pods before anything is minted. Pod-side config is unchanged (`DSH_POD_TOKEN`); docker-compose passes a per-pod `DSH_POD1_TOKEN`/`DSH_POD2_TOKEN` override that falls back to the shared bootstrap secret.
