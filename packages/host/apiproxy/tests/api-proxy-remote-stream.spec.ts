/**
 * The remote-authority live bridge: a history read of a federated session
 * establishes a hub-side event subscription through the session-sources seam
 * (bypassing the registry scan via the stamped authority), and every bridged
 * event re-emerges as a local `session/event` mux frame. Local sessions never
 * establish a bridge.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (value: string): SessionId => value as SessionId

function chunkEvent(seq: number): SessionEvent {
  return { type: 'assistant/chunk', seq, time: seq, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } } as SessionEvent
}

interface BridgeHarness {
  ctx: Context
  sessionId: SessionId
  subscribeCalls: { sessionId: SessionId; fromSeq: number | undefined; sourceId: string | undefined }[]
  emit: (event: SessionEvent) => void
}

async function bridgedHarness(): Promise<BridgeHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const sessionId = sid('session-hub-live')
  const meta: SessionHeader = {
    version: 0, id: sessionId, createdAt: 1, cwd: '/data/workspace', remoteAuthority: 'federation-hub',
  }
  const events = [chunkEvent(0), chunkEvent(1)]
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({ meta, events }),
    create: () => Promise.resolve(),
    append: () => Promise.resolve(),
  } as never)
  const subscribeCalls: BridgeHarness['subscribeCalls'] = []
  const listeners: ((event: SessionEvent) => void)[] = []
  ctx.provide('sessionSources', {
    getSession: (id: SessionId, hint?: string) => Promise.resolve(
      hint === 'federation-hub' && id === sessionId
        ? { source: { id: 'federation-hub' }, session: { header: meta, events } }
        : undefined,
    ),
    subscribeEvents: (id: SessionId, onEvent: (event: SessionEvent) => void, fromSeq?: number, sourceId?: string) => {
      subscribeCalls.push({ sessionId: id, fromSeq, sourceId })
      listeners.push(onEvent)
      return Promise.resolve(() => {})
    },
  } as never)
  return {
    ctx, sessionId, subscribeCalls,
    emit: (event) => { for (const listener of listeners) listener(event) },
  }
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
  cwd: '/tmp',
})

/** Drain the mux until one `session/event` frame for the target session arrives, then abort. */
async function collectEventFrames(
  iterable: AsyncIterable<RpcRequest<MuxFrame>>,
  sessionId: SessionId,
  count: number,
  abort: AbortController,
): Promise<MuxFrame[]> {
  const frames: MuxFrame[] = []
  for await (const envelope of iterable) {
    frames.push(envelope.payload)
    if (frames.filter(frame => frame.type === 'session/event' && frame.sessionId === sessionId).length >= count) {
      abort.abort()
    }
  }
  return frames
}

describe('remote-authority live bridge', () => {
  it('a history read subscribes through the stamped authority and bridges events into the mux', async () => {
    const { ctx, sessionId, subscribeCalls, emit } = await bridgedHarness()
    const proxy = api(ctx)
    const abort = new AbortController()
    const stream = proxy.events.mux({ rpcId: RpcId('t-bridge'), payload: {} }, abort.signal)
    const collected = collectEventFrames(stream, sessionId, 2, abort)

    const history = await proxy.sessions.history({ rpcId: RpcId('t-history'), payload: { sessionId, maxMessages: 50 } })
    if (!history.result.ok) throw new Error('history failed')

    // The bridge subscribes one past the inspected tail, targeted at the
    // stamped authority so the registry scan cannot be shadowed by the local
    // source's materialized copy.
    expect(subscribeCalls).toEqual([{ sessionId, fromSeq: 2, sourceId: 'federation-hub' }])

    emit(chunkEvent(2))
    emit(chunkEvent(3))
    const frames = await collected

    const bridged = frames.filter(frame => frame.type === 'session/event' && frame.sessionId === sessionId)
    expect(bridged).toHaveLength(2)
    expect((bridged[0] as { event: SessionEvent }).event.seq).toBe(2)
    expect((bridged[1] as { event: SessionEvent }).event.seq).toBe(3)
    await ctx.fiber.dispose()
  })

  it('a second history read refreshes the scope without resubscribing', async () => {
    const { ctx, sessionId, subscribeCalls } = await bridgedHarness()
    const proxy = api(ctx)
    for (const rpcId of ['t-history-1', 't-history-2']) {
      const history = await proxy.sessions.history({ rpcId: RpcId(rpcId), payload: { sessionId, maxMessages: 50 } })
      if (!history.result.ok) throw new Error('history failed')
    }
    expect(subscribeCalls).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('a local session history read establishes no bridge', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(sid('local-only'), { meta: { cwd: '/tmp' } })
    session.append('turn/start', { turn: 1 })
    const subscribeCalls: unknown[] = []
    ctx.provide('sessionSources', {
      subscribeEvents: (...args: unknown[]) => { subscribeCalls.push(args); return Promise.resolve(() => {}) },
    } as never)
    const proxy = api(ctx)

    const history = await proxy.sessions.history({ rpcId: RpcId('t-local'), payload: { sessionId: session.id, maxMessages: 50 } })
    if (!history.result.ok) throw new Error('history failed')

    expect(subscribeCalls).toEqual([])
    await ctx.fiber.dispose()
  })
})
