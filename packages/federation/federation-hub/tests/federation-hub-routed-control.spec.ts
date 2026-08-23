import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WebSocket } from 'ws'
import {
  FederationHubService,
} from '../src/index.ts'

function createFakeSocket(): { socket: WebSocket & { readyState: number }; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const close = vi.fn()
  const terminate = vi.fn()
  const socket = {
    readyState: 1, // OPEN
    send,
    close,
    terminate,
  } as unknown as WebSocket & { readyState: number }
  return { socket, send }
}

interface FakeQueuedMessage {
  id: string
  content: Array<{ type: string; text?: string }>
}

function createFakeAgent(overrides: Partial<Record<string, unknown>> = {}): Agent {
  return {
    status: 'idle',
    inbox: {
      nextTurn: [] as FakeQueuedMessage[],
      nextStep: [] as FakeQueuedMessage[],
      replace: vi.fn(),
      remove: vi.fn(),
    },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  } as unknown as Agent
}

function repliedRequestIds(socket: { send: ReturnType<typeof vi.fn> }): string[] {
  return socket.send.mock.calls
    .map(call => (JSON.parse(String(call[0])) as { requestId?: string }).requestId)
    .filter((id): id is string => typeof id === 'string')
}

function lastReply(send: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const raw = send.mock.lastCall?.[0] as string | undefined
  return JSON.parse(String(raw)) as Record<string, unknown>
}

describe('routed session control', () => {
  let ctx: Context
  let service: FederationHubService

  beforeEach(() => {
    ctx = new Context()
    service = new FederationHubService(ctx, { interactionTimeoutMs: 80 })
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('cold-starts the writer through the bound source when no agent is live', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    const followup = vi.fn()
    const resolveWriter = vi.fn(async () => ({ agent: { followup } as unknown as Agent }))
    service.bindWriterSource({ resolveWriter, applySelection: async () => ({ ok: false, message: 'unused' }) })

    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-cold',
      sessionId: 'sess-cold' as never,
      content: [{ type: 'text', text: 'wake up' }],
      clientMessageId: 'c-cold-1',
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    expect(resolveWriter).toHaveBeenCalledWith('sess-cold')
    expect(followup).toHaveBeenCalledTimes(1)
    expect(lastReply(send)).toMatchObject({ type: 'session/send-result', requestId: 'r-cold' })
    expect(lastReply(send).messageId).toBeDefined()
  })

  it('maps an unknown cold session to invalid and a resume failure to writer-offline', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    service.bindWriterSource({
      resolveWriter: async (sessionId) => {
        if (sessionId === 'sess-missing') {
          return { error: { code: 'session-not-found', message: `session "${sessionId}" not found` } }
        }
        return { error: { code: 'internal', message: 'resume exploded' } }
      },
      applySelection: async () => ({ ok: false, message: 'unused' }),
    })

    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-missing',
      sessionId: 'sess-missing' as never,
      content: [{ type: 'text', text: 'x' }],
      clientMessageId: 'c-missing',
    })
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-boom',
      sessionId: 'sess-boom' as never,
      content: [{ type: 'text', text: 'x' }],
      clientMessageId: 'c-boom',
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBe(2)
    })
    const replies = send.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
    expect(replies.find(r => r.requestId === 'r-missing')).toMatchObject({ code: 'invalid' })
    expect(replies.find(r => r.requestId === 'r-boom')).toMatchObject({ code: 'writer-offline', error: 'resume exploded' })
  })

  it('answers writer-offline for a cold send when no writer source is bound', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-nosource',
      sessionId: 'sess-any' as never,
      content: [{ type: 'text', text: 'x' }],
      clientMessageId: 'c-nosource',
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    expect(lastReply(send)).toMatchObject({ code: 'writer-offline' })
  })

  it('applies queue remove, edit, and steer to the live writer inbox', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    const queued: FakeQueuedMessage = { id: 'm1', content: [{ type: 'text', text: 'queued' }] }
    const replace = vi.fn()
    const remove = vi.fn()
    const steer = vi.fn()
    const nextTurn: FakeQueuedMessage[] = [queued]
    ctx.provide('agents', {
      get: (id: string) => id !== 'sess-live'
        ? undefined
        : {
          status: 'running',
          inbox: { nextTurn, nextStep: [], replace, remove },
          steer,
        },
    })

    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-remove',
      sessionId: SessionId('sess-live'),
      itemId: 'm1',
      action: { kind: 'remove' },
    })
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith('m1')
    })
    expect(lastReply(send)).toMatchObject({ type: 'session/queue-update-result', requestId: 'q-remove', accepted: true })

    // A fresh queued copy for the edit path.
    nextTurn.push({ ...queued })
    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-edit',
      sessionId: SessionId('sess-live'),
      itemId: 'm1',
      action: { kind: 'edit', content: [{ type: 'text', text: 'edited' }] },
    })
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalled()
    })
    expect(replace.mock.calls[0]?.[0]).toBe('m1')

    // Steering re-delivers the item through agent.steer.
    nextTurn.push({ ...queued })
    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-steer',
      sessionId: SessionId('sess-live'),
      itemId: 'm1',
      action: { kind: 'steer' },
    })
    await vi.waitFor(() => {
      expect(steer).toHaveBeenCalled()
    })
    expect((steer.mock.calls[0]?.[0] as FakeQueuedMessage).id).toBe('m1')
  })

  it('rejects queue updates for missing items and steering without a running turn', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    ctx.provide('agents', {
      get: (id: string) => id !== 'sess-idle'
        ? undefined
        : {
          status: 'idle',
          inbox: { nextTurn: [{ id: 'm9', content: [] }], nextStep: [], replace: vi.fn(), remove: vi.fn() },
          steer: vi.fn(),
        },
    })

    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-gone',
      sessionId: 'sess-idle' as never,
      itemId: 'nope',
      action: { kind: 'remove' },
    })
    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-steer-idle',
      sessionId: 'sess-idle' as never,
      itemId: 'm9',
      action: { kind: 'steer' },
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBe(2)
    })
    const replies = send.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
    expect(replies.find(r => r.requestId === 'q-gone')).toMatchObject({ code: 'invalid', error: 'queued item is no longer pending' })
    expect(replies.find(r => r.requestId === 'q-steer-idle')).toMatchObject({ code: 'invalid', error: 'current turn no longer accepts steering' })
  })

  it('rejects queue updates without a command-capable token or valid payload', async () => {
    const read = createFakeSocket()
    service.registerPod('pod-read', 'Read Pod', {}, 'read', read.socket)
    service.handlePodMessage('pod-read', {
      type: 'session/queue-update',
      requestId: 'q-unauth',
      sessionId: 'sess-1' as never,
      itemId: 'm1',
      action: { kind: 'remove' },
    })
    const command = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', command.socket)
    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-bad',
      sessionId: 'sess-1' as never,
      itemId: '',
      action: { kind: 'remove' },
    })
    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-bad-edit',
      sessionId: 'sess-1' as never,
      itemId: 'm1',
      action: { kind: 'edit', content: [] as never },
    })
    await vi.waitFor(() => {
      expect(read.send).toHaveBeenCalled()
      expect(command.send.mock.calls.length).toBe(2)
    })
    expect(JSON.parse(String(read.send.mock.calls[0]?.[0]))).toMatchObject({ code: 'unauthorized' })
    const replies = command.send.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
    expect(replies[0]).toMatchObject({ requestId: 'q-bad', code: 'invalid' })
    expect(replies[1]).toMatchObject({ requestId: 'q-bad-edit', code: 'invalid' })
  })

  it('cancels the live writer turn and keeps its inbox', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    const cancel = vi.fn()
    ctx.provide('agents', {
      get: (id: string) => id !== 'sess-live' ? undefined : { cancel },
    })
    service.handlePodMessage('pod-1', {
      type: 'session/cancel',
      requestId: 'x-ok',
      sessionId: 'sess-live' as never,
    })
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalled()
    })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(lastReply(send)).toMatchObject({ type: 'session/cancel-result', requestId: 'x-ok', accepted: true })
  })

  it('rejects a cancellation when the writer cannot be attached and without a command role', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    service.handlePodMessage('pod-1', {
      type: 'session/cancel',
      requestId: 'x-cold',
      sessionId: 'sess-none' as never,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    expect(lastReply(send)).toMatchObject({ code: 'writer-offline' })

    const read = createFakeSocket()
    service.registerPod('pod-read', 'Read Pod', {}, 'read', read.socket)
    service.handlePodMessage('pod-read', {
      type: 'session/cancel',
      requestId: 'x-unauth',
      sessionId: 'sess-none' as never,
    })
    await vi.waitFor(() => {
      expect(read.send).toHaveBeenCalled()
    })
    expect(JSON.parse(String(read.send.mock.calls[0]?.[0]))).toMatchObject({ code: 'unauthorized' })
  })

  it('routes model selection through the writer source', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    const applySelection = vi.fn(async () => ({
      ok: true as const,
      selected: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    }))
    service.bindWriterSource({
      resolveWriter: async () => ({ agent: createFakeAgent() }),
      applySelection,
    })

    service.handlePodMessage('pod-1', {
      type: 'session/select-model',
      requestId: 'sel-1',
      sessionId: 'sess-live' as never,
      selection: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    expect(applySelection).toHaveBeenCalledWith('sess-live', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
    expect(lastReply(send)).toMatchObject({
      type: 'session/select-model-result',
      requestId: 'sel-1',
      selected: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    })
  })

  it('answers select-model with writer-offline when no writer source is bound or the switch fails', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)

    service.handlePodMessage('pod-1', {
      type: 'session/select-model',
      requestId: 'sel-nosource',
      sessionId: 'sess-live' as never,
      selection: { provider: 'p', model: 'm' },
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    expect(lastReply(send)).toMatchObject({ code: 'writer-offline', error: 'no writer source is bound on this hub' })

    service.bindWriterSource({
      resolveWriter: async () => ({ agent: createFakeAgent() }),
      applySelection: async () => ({ ok: false, message: 'model "m" is unavailable' }),
    })
    service.handlePodMessage('pod-1', {
      type: 'session/select-model',
      requestId: 'sel-fail',
      sessionId: 'sess-live' as never,
      selection: { provider: 'p', model: 'm' },
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBe(2)
    })
    expect(lastReply(send)).toMatchObject({ code: 'writer-offline', error: 'model "m" is unavailable' })
  })

  it('rejects malformed select-model payloads', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    service.handlePodMessage('pod-1', {
      type: 'session/select-model',
      requestId: 'sel-bad',
      sessionId: '' as never,
      selection: undefined as never,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    expect(lastReply(send)).toMatchObject({ code: 'invalid' })
  })

  it('ignores routed control from an unregistered pod and stays silent on a closed socket', async () => {
    // Unregistered pod id: handlePodMessage drops the message without a reply.
    service.handlePodMessage('pod-ghost', {
      type: 'session/cancel',
      requestId: 'x-ghost',
      sessionId: 'sess-1' as never,
    })
    service.handlePodMessage('pod-ghost', {
      type: 'session/send',
      requestId: 's-ghost',
      sessionId: 'sess-1' as never,
      content: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'c-ghost',
    })
    service.handlePodMessage('pod-ghost', {
      type: 'session/queue-update',
      requestId: 'q-ghost',
      sessionId: 'sess-1' as never,
      itemId: 'm1',
      action: { kind: 'remove' },
    })
    service.handlePodMessage('pod-ghost', {
      type: 'session/select-model',
      requestId: 'sel-ghost',
      sessionId: 'sess-1' as never,
      selection: { provider: 'p', model: 'm' },
    })
    const closed = createFakeSocket()
    service.registerPod('pod-closed', 'Closed Pod', {}, 'command', closed.socket)
    ;(closed.socket as { readyState: number }).readyState = 0
    for (const requestId of ['q-closed', 'x-closed', 'sel-closed']) {
      service.handlePodMessage('pod-closed', {
        type: requestId.startsWith('q')
          ? 'session/queue-update'
          : requestId.startsWith('x')
            ? 'session/cancel'
            : 'session/select-model',
        requestId,
        sessionId: 'sess-1' as never,
        ...(requestId.startsWith('q') ? { itemId: 'm1', action: { kind: 'remove' } } : {}),
        ...(requestId.startsWith('sel') ? { selection: { provider: 'p', model: 'm' } } : {}),
      } as never)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closed.send).not.toHaveBeenCalled()
  })

  it('rejects a queue update whose action is not one of the three mutations', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-shape',
      sessionId: 'sess-1' as never,
      itemId: 'm1',
      action: { kind: 'purge' } as never,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    expect(lastReply(send)).toMatchObject({ code: 'invalid', error: 'queue update requires sessionId, itemId, and a valid action' })

    // A non-object action fails the same validation.
    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-null-action',
      sessionId: 'sess-1' as never,
      itemId: 'm1',
      action: null as never,
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBe(2)
    })
    expect(lastReply(send)).toMatchObject({ code: 'invalid' })
  })

  it('removes a next-step queued item and reports inbox failures as invalid', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    const queued: FakeQueuedMessage = { id: 's1', content: [{ type: 'text', text: 'step input' }] }
    const remove = vi.fn()
    // Read on every lookup so the failing-inbox phase below can swap it.
    let inbox: Record<string, unknown> = {
      nextTurn: [],
      nextStep: [queued],
      replace: vi.fn(),
      remove,
    }
    ctx.provide('agents', {
      get: () => ({ status: 'running', inbox }),
    })

    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-step-remove',
      sessionId: 'sess-live' as never,
      itemId: 's1',
      action: { kind: 'remove' },
    })
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith('s1')
    })
    expect(lastReply(send)).toMatchObject({ requestId: 'q-step-remove', accepted: true })

    // The next writer's inbox access throws inside the handler's try: the
    // failure lands in the reply, not in an unhandled rejection.
    inbox = {
      get nextTurn(): never {
        throw new Error('inbox vanished')
      },
      nextStep: [],
      replace: vi.fn(),
      remove: vi.fn(),
    }
    service.handlePodMessage('pod-1', {
      type: 'session/queue-update',
      requestId: 'q-boom',
      sessionId: 'sess-live' as never,
      itemId: 'boom',
      action: { kind: 'remove' },
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    expect(lastReply(send)).toMatchObject({ code: 'invalid', error: 'inbox vanished' })
  })

  it('maps cancel and select-model failures and guards onto structured replies', async () => {
    const command = createFakeSocket()
    service.registerPod('pod-cmd', 'Command Pod', {}, 'command', command.socket)
    const read = createFakeSocket()
    service.registerPod('pod-read', 'Read Pod', {}, 'read', read.socket)

    // Invalid cancel payload.
    service.handlePodMessage('pod-cmd', {
      type: 'session/cancel',
      requestId: 'x-empty',
      sessionId: '' as never,
    })
    // Cancel whose writer probe throws.
    ctx.provide('agents', {
      get(): never {
        throw new Error('registry exploded')
      },
    })
    service.handlePodMessage('pod-cmd', {
      type: 'session/cancel',
      requestId: 'x-boom',
      sessionId: 'sess-any' as never,
    })
    // Select-model without a command role.
    service.handlePodMessage('pod-read', {
      type: 'session/select-model',
      requestId: 'sel-unauth',
      sessionId: 'sess-any' as never,
      selection: { provider: 'p', model: 'm' },
    })
    // Select-model whose source rejects.
    service.bindWriterSource({
      resolveWriter: async () => ({ agent: createFakeAgent() }),
      applySelection: async () => {
        throw new Error('selection seat jammed')
      },
    })
    service.handlePodMessage('pod-cmd', {
      type: 'session/select-model',
      requestId: 'sel-boom',
      sessionId: 'sess-any' as never,
      selection: { provider: 'p', model: 'm' },
    })
    await vi.waitFor(() => {
      // pod-read's registration also broadcasts a peer/update to pod-cmd; the
      // assertions below match on requestId so that frame stays irrelevant.
      expect(read.send).toHaveBeenCalledTimes(1)
      expect(repliedRequestIds(command)).toEqual(expect.arrayContaining(['x-empty', 'x-boom', 'sel-boom']))
    })
    const replies = [...command.send.mock.calls, ...read.send.mock.calls]
      .map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
    expect(replies.find(r => r.requestId === 'x-empty')).toMatchObject({ code: 'invalid' })
    expect(replies.find(r => r.requestId === 'x-boom')).toMatchObject({ code: 'invalid', error: 'registry exploded' })
    expect(replies.find(r => r.requestId === 'sel-unauth')).toMatchObject({ code: 'unauthorized' })
    expect(replies.find(r => r.requestId === 'sel-boom')).toMatchObject({ code: 'invalid', error: 'selection seat jammed' })
  })

  it('serializes routed control behind a pending send on the same session', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    let releaseSend: (() => void) | undefined
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    const order: string[] = []
    ctx.provide('agents', {
      get: () => ({
        followup: vi.fn(async () => {
          order.push('send-start')
          await sendGate
        }),
        cancel: vi.fn(() => {
          order.push('cancel')
        }),
        inbox: { nextTurn: [], nextStep: [], replace: vi.fn(), remove: vi.fn() },
      }),
    })

    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 's-slow',
      sessionId: 'sess-order' as never,
      content: [{ type: 'text', text: 'slow' }],
      clientMessageId: 'c-slow',
    })
    service.handlePodMessage('pod-1', {
      type: 'session/cancel',
      requestId: 'x-after',
      sessionId: 'sess-order' as never,
    })
    await vi.waitFor(() => {
      expect(order).toContain('send-start')
    })
    releaseSend?.()
    await vi.waitFor(() => {
      expect(order).toContain('cancel')
    })
    expect(order.indexOf('send-start')).toBeLessThan(order.indexOf('cancel'))
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBe(2)
    })
  })
})
