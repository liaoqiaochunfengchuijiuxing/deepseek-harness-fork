# Agent Note: Remote-authority live event bridge into the Web mux

Status: implemented

English | [中文](2026-08-23-federation-remote-authority-live-bridge.zh.md)

## Problem

A pod's Web UI showed hub sessions frozen at read time. The detached history path (with the `remoteAuthority` catch-up) refreshed a copy only when someone re-read it, and the api-proxy's mux broadcast — the stream every Web client consumes — carried only local `ctx.on('session/event')` events. A turn running on the hub never streamed to pods; the pod's view converged only on the next full read. The routed-execution model requires the opposite: viewing is reading, and everything the authority appends flows to every observer in real time.

A second gap hid under the first: the hub-side local session source's `subscribeEvents` returned an empty disposer for any session without a live Agent. A pod subscribing to a cold hub session would receive nothing even after the session activated — the stream would silently miss the session's entire first run.

## Decision

The bridge lives in the api-proxy, established by the read that needs it. When `session.history` serves a remote-authority session (a log stamped `remoteAuthority`, or an identity only a remote source knows), it calls `ensureRemoteStream(sessionId, tailSeq + 1, scope, authority)`: a `sessionSources.subscribeEvents` subscription targeted at the stamped authority — the same hint path `getSession` uses, so the registry scan cannot be shadowed by the local source's materialized copy — whose events are re-broadcast through the existing `broadcast()` as ordinary `session/event` mux frames with tool views computed through the same presenter path (per-bridge open-call table, cleared on `turn/end`). The Web client is unchanged: its existing liveBuffer and gap-repair cover the baseline-vs-stream race, and `fromSeq = tail + 1` with the hub's subscribe-time replay closes the read-subscribe window.

Bridges are per-process and idempotent: a repeated read refreshes the presenter scope only, the federation source's own reconnect re-subscribes from `lastSeq + 1`, and the bridged set is bounded by the sessions users actually open. Starting the subscription one past the cut tail is safe because the hub replays from `fromSeq` on subscribe.

Cold sessions activate their held subscriptions. The local session source's `subscribeEvents` now distinguishes live from cold: a live session replays from `fromSeq` and forwards appends; a cold session holds the subscription open against publication — when the session is created (a resume republishes it), replay and forwarding begin. A subscription disposed while still cold cancels the wait with no side effects.

## Alternatives considered

**Bridge on mux connect (subscribe to every remote session upfront).** Rejected: the mux model is connect-then-subscribe-all for local sessions, but the remote set is unbounded from the pod's perspective; bridging on first read bounds federation traffic to sessions someone actually opened.

**Teach the Web client a second, remote frame type.** Rejected: the client already stitches live events against a history baseline with gap repair; re-emitting remote events as ordinary `session/event` frames keeps one protocol and zero client changes.

**Push cold-session activation into the aggregate service.** Rejected: the aggregate's scan probes ownership via `getSession`, which needs persistence to resolve a cold identity; the activation contract belongs to the source that knows when its store publishes.

## Consequences

A hub session opened on any pod streams every authority append into that pod's Web UI in real time — verified live on the Docker cluster: a prompt executed on the hub arrived on the pod's mux as the full turn (user/message, turn lifecycle, five assistant chunks, turn/end, seq 1705–1719 contiguous). Stage 2 (routing `session.prompt` through `session/send`) builds on this: once the pod forwards execution to the hub, the same bridge is the return path that renders the executed turn on the commanding pod. The bridge broadcasts to every connected mux consumer, so two browsers on one pod see the same remote stream. Remote-session projections still ride the detached baseline fold; live `session/projection` frames for remote sessions are deferred (the proposal's stage 1b).
