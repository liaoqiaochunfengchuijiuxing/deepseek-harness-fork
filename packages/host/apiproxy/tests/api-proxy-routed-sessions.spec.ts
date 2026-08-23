/**
 * Routed session execution: a remote-authority session's Agent-bound verbs
 * ride the pod's federation channel to the owning node instead of attaching a
 * local writer. An offline or absent link fails the verb loudly, and the
 * shared agent resolver refuses stamped sessions as the safety net for any
 * verb that reaches it unguarded.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (value: string): SessionId => value as SessionId

const meta: SessionHeader = {
  version: 0,
  id: sid('session-hub-live'),
  createdAt: 1,
  cwd: '/data/workspace',
  remoteAuthority: 'federation-hub',
}

interface ChannelCalls {
  sends: { sessionId: string; content: unknown; clientMessageId: string }[]
  queueUpdates: { sessionId: string; itemId: string; action: unknown }[]
  cancels: string[]
  selections: { sessionId: string; selection: unknown }[]
}

interface ChannelBehavior {
  connected?: boolean
  sendResult?: { ok: true; messageId: string } | { ok: false; code: string; message: string }
  queueResult?: { ok: true; accepted: true } | { ok: false; code: string; message: string }
  cancelResult?: { ok: true; accepted: true } | { ok: false; code: string; message: string }
  selectResult?:
    | { ok: true; selected: { provider: string; model: string; reasoningEffort?: string } }
    | { ok: false; code: string; message: string }
}

async function routedHarness(behavior: ChannelBehavior = {}): Promise<{
  ctx: Context
  calls: ChannelCalls
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const events: SessionEvent[] = []
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect: () => Promise.resolve({ meta, events }),
    create: () => Promise.resolve(),
    append: () => Promise.resolve(),
  } as never)
  ctx.provide('sessionSources', {
    getSession: (id: SessionId, hint?: string) => Promise.resolve(
      hint === 'federation-hub' && id === meta.id
        ? { source: { id: 'federation-hub' }, session: { header: meta, events } }
        : undefined,
    ),
  } as never)
  const calls: ChannelCalls = { sends: [], queueUpdates: [], cancels: [], selections: [] }
  if (behavior.connected !== false) {
    ctx.provide('federationClient', {
      getStatus: () => (behavior.connected === false ? 'disconnected' : 'connected'),
      sendToSession: (sessionId: SessionId, content: unknown, clientMessageId: string) => {
        calls.sends.push({ sessionId, content, clientMessageId })
        return Promise.resolve(behavior.sendResult ?? { ok: true as const, messageId: 'msg-1' })
      },
      queueUpdateSession: (sessionId: SessionId, itemId: string, action: unknown) => {
        calls.queueUpdates.push({ sessionId, itemId, action })
        return Promise.resolve(behavior.queueResult ?? { ok: true as const, accepted: true as const })
      },
      cancelSession: (sessionId: SessionId) => {
        calls.cancels.push(sessionId)
        return Promise.resolve(behavior.cancelResult ?? { ok: true as const, accepted: true as const })
      },
      selectModelSession: (sessionId: SessionId, selection: unknown) => {
        calls.selections.push({ sessionId, selection })
        return Promise.resolve(behavior.selectResult ?? {
          ok: true as const,
          selected: { provider: 'deepseek-official', model: 'deepseek-chat' },
        })
      },
    })
  }
  return { ctx, calls }
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
  cwd: '/tmp',
})

describe('routed session execution', () => {
  it('routes prompt through the federation channel with durable text content', async () => {
    const { ctx, calls } = await routedHarness()
    const proxy = api(ctx)
    const response = await proxy.sessions.prompt({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, mode: 'queue', content: [{ type: 'text', text: 'hello hub' }] },
    })
    expect(response.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(calls.sends).toHaveLength(1)
    expect(calls.sends[0]).toMatchObject({ sessionId: meta.id, clientMessageId: 't-routed' })
    await ctx.fiber.dispose()
  })

  it('fails the prompt loudly when the federation link is offline', async () => {
    const { ctx, calls } = await routedHarness({ connected: false })
    const proxy = api(ctx)
    const response = await proxy.sessions.prompt({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.code).toBe('internal')
      expect(response.result.error.message).toContain('federation link is offline')
    }
    expect(calls.sends).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('refuses steer prompts and image prompts for routed sessions without contacting the channel', async () => {
    const { ctx, calls } = await routedHarness()
    const proxy = api(ctx)
    const steer = await proxy.sessions.prompt({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, mode: 'steer', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(steer.result.ok).toBe(false)
    if (!steer.result.ok) {
      expect((steer.result.error.details as { reason?: string }).reason).toBe('REMOTE_STEER_UNSUPPORTED')
    }
    const image = await proxy.sessions.prompt({ rpcId: RpcId('t-routed'),
      payload: {
        sessionId: meta.id,
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: 'aGk=' }],
      },
    })
    expect(image.result.ok).toBe(false)
    if (!image.result.ok) {
      expect((image.result.error.details as { reason?: string }).reason).toBe('REMOTE_PROMPT_TEXT_ONLY')
    }
    expect(calls.sends).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('surfaces a channel refusal on the prompt reply', async () => {
    const { ctx } = await routedHarness({
      sendResult: { ok: false, code: 'writer-offline', message: 'no writer source is bound' },
    })
    const proxy = api(ctx)
    const response = await proxy.sessions.prompt({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) {
      expect(response.result.error.message).toContain('no writer source is bound')
    }
    await ctx.fiber.dispose()
  })

  it('routes queue updates and cancellations through the channel', async () => {
    const { ctx, calls } = await routedHarness()
    const proxy = api(ctx)
    const update = await proxy.sessions.updateQueue({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, itemId: 'm1' as MessageId, action: { kind: 'remove' } },
    })
    expect(update.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(calls.queueUpdates[0]).toMatchObject({ sessionId: meta.id, itemId: 'm1', action: { kind: 'remove' } })

    const cancel = await proxy.sessions.cancel({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id },
    })
    expect(cancel.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(calls.cancels).toEqual([meta.id])
    await ctx.fiber.dispose()
  })

  it('maps a failed cancellation onto an internal error naming the refusal', async () => {
    const { ctx } = await routedHarness({
      cancelResult: { ok: false, code: 'invalid', message: 'queued item is no longer pending' },
    })
    const proxy = api(ctx)
    const cancel = await proxy.sessions.cancel({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id },
    })
    expect(cancel.result.ok).toBe(false)
    if (!cancel.result.ok) {
      expect(cancel.result.error.message).toContain('queued item is no longer pending')
    }
    await ctx.fiber.dispose()
  })

  it('routes model selection through the channel and maps failures to model-unavailable', async () => {
    const ok = await routedHarness()
    const okProxy = api(ok.ctx)
    const selected = await okProxy.sessions.selectModel({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, provider: 'deepseek-official', model: 'deepseek-reasoner' },
    })
    expect(selected.result).toMatchObject({
      ok: true,
      value: { selected: { provider: 'deepseek-official', model: 'deepseek-chat' } },
    })
    expect(ok.calls.selections[0]).toMatchObject({ sessionId: meta.id })
    await ok.ctx.fiber.dispose()

    const failed = await routedHarness({
      selectResult: { ok: false, code: 'writer-offline', message: 'no writer source is bound on this hub' },
    })
    const failedProxy = api(failed.ctx)
    const refused = await failedProxy.sessions.selectModel({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, provider: 'p', model: 'm' },
    })
    expect(refused.result.ok).toBe(false)
    if (!refused.result.ok) {
      expect(refused.result.error.code).toBe('model-unavailable')
      expect(refused.result.error.message).toContain('no writer source is bound')
    }
    await failed.ctx.fiber.dispose()
  })

  it('refuses rename for a routed session instead of resuming a writer', async () => {
    const { ctx, calls } = await routedHarness()
    const proxy = api(ctx)
    const renamed = await proxy.sessions.rename({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, title: 'New Title' },
    })
    expect(renamed.result.ok).toBe(false)
    if (!renamed.result.ok) {
      expect(renamed.result.error.message).toContain('executes on "federation-hub"')
    }
    expect(calls.sends).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('the resolver refuses a stamped session even when a verb bypasses routing', async () => {
    const { ctx } = await routedHarness({ connected: false })
    const proxy = api(ctx)
    // goals.create is Agent-bound but has no routed path yet: it must hit the
    // resolver's routed-session fence rather than materialize + resume.
    const created = await proxy.goals.create({ rpcId: RpcId('t-routed'),
      payload: { sessionId: meta.id, objective: 'test' },
    })
    expect(created.result.ok).toBe(false)
    if (!created.result.ok) {
      expect(created.result.error.message).toContain('route operations through its owning node')
    }
    await ctx.fiber.dispose()
  })
})
