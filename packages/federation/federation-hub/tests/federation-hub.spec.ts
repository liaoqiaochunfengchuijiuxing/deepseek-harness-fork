import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WebSocket } from 'ws'
import * as SessionSourcePlugin from '@deepseek-ai/dsh-session-source'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import * as HubPlugin from '../src/index.ts'
import {
  FederationHubService,
  FederationHubServer,
  isApprovalOutcome,
  rawDataToString,
  roleAllowsCommand,
  type FederationRegisteredMessage,
  type FederationHeartbeatAckMessage,
  type RemoteSubagentStartMessage,
  type RemoteSubagentChunkMessage,
  type RemoteSubagentStopMessage,
  type FederationWireMessage,
} from '../src/index.ts'

function createFakeSocket(): { socket: WebSocket; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const close = vi.fn()
  const terminate = vi.fn()
  const socket = {
    readyState: 1, // OPEN
    send,
    close,
    terminate,
  } as unknown as WebSocket
  return { socket, send }
}

describe('roleAllowsCommand', () => {
  it('allows command and above, rejects read', () => {
    expect(roleAllowsCommand('read')).toBe(false)
    expect(roleAllowsCommand('command')).toBe(true)
    expect(roleAllowsCommand('manage')).toBe(true)
    expect(roleAllowsCommand('takeover')).toBe(true)
  })
})

describe('isApprovalOutcome', () => {
  it('accepts the closed vocabulary and rejects anything else', () => {
    expect(isApprovalOutcome('allowed-once')).toBe(true)
    expect(isApprovalOutcome('rejected')).toBe(true)
    expect(isApprovalOutcome('cancelled')).toBe(true)
    expect(isApprovalOutcome('unavailable')).toBe(true)
    expect(isApprovalOutcome('yolo')).toBe(false)
    expect(isApprovalOutcome(1)).toBe(false)
  })
})

describe('FederationHubService', () => {
  let ctx: Context
  let service: FederationHubService

  beforeEach(() => {
    ctx = new Context()
    service = new FederationHubService(ctx, { interactionTimeoutMs: 80 })
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('registers and lists pods', () => {
    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', { workspaces: ['/tmp'] }, 'command', socket)

    const pods = service.listPods()
    expect(pods).toHaveLength(1)
    const [pod] = pods
    expect(pod).toBeDefined()
    expect(pod?.podId).toBe('pod-1')
    expect(pod?.name).toBe('Pod 1')
    expect(pod?.status).toBe('online')
    expect(pod?.role).toBe('command')

    const found = service.getPod('pod-1')
    expect(found?.podId).toBe('pod-1')
  })

  it('updates heartbeat timestamp and unregisters pod', () => {
    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'read', socket)

    const initialHb = service.getPod('pod-1')!.lastHeartbeat
    service.touchHeartbeat('pod-1')
    expect(service.getPod('pod-1')!.lastHeartbeat).toBeGreaterThanOrEqual(initialHb)

    service.unregisterPod('pod-1')
    expect(service.getPod('pod-1')).toBeUndefined()
    expect(service.listPods()).toHaveLength(0)
  })

  it('sets pod status to offline and cleans up active delegations', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)

    const req: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'run-1',
      prompt: [{ type: 'text', text: 'hello' }],
    }

    const delegationPromise = service.delegateToPod('pod-1', req)
    expect(send).toHaveBeenCalled()

    service.setPodStatus('pod-1', 'offline')
    await expect(delegationPromise).rejects.toThrow(/went offline/)
  })

  it('handles delegation chunk, stop, and cancellation', async () => {
    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)

    const chunks: string[] = []
    const req: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'run-2',
      prompt: [{ type: 'text', text: 'do work' }],
    }

    const delegationPromise = service.delegateToPod('pod-1', req, (delta) => {
      chunks.push(delta)
    })

    service.handlePodMessage('pod-1', {
      type: 'subagent/chunk',
      id: 'run-2',
      delta: 'chunk 1',
    })

    const stopMsg: RemoteSubagentStopMessage = {
      type: 'subagent/stop',
      id: 'run-2',
      output: [{ type: 'text', text: 'completed result' }],
      stopReason: 'completed',
    }
    service.handlePodMessage('pod-1', stopMsg)

    const res = await delegationPromise
    expect(chunks).toEqual(['chunk 1'])
    expect(res.stopReason).toBe('completed')
    expect(res.output[0]).toEqual({ type: 'text', text: 'completed result' })
  })

  it('cancels pod delegation explicitly', async () => {
    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)

    const req: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'run-3',
      prompt: [{ type: 'text', text: 'work' }],
    }

    const delegationPromise = service.delegateToPod('pod-1', req)
    service.cancelPodDelegation('pod-1', 'run-3', 'user abort')

    const res = await delegationPromise
    expect(res.stopReason).toBe('aborted')
    expect(res.diagnostic).toBe('user abort')
  })

  it('rejects session/send without a command-capable token', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-read', 'Read Pod', {}, 'read', socket)
    service.handlePodMessage('pod-read', {
      type: 'session/send',
      requestId: 'r1',
      sessionId: 'sess-1' as never,
      content: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'c1',
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const payload = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    expect(payload).toMatchObject({ type: 'session/send-result', requestId: 'r1', code: 'unauthorized' })
  })

  it('rejects session/send when the writer agent is not live', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r2',
      sessionId: 'sess-missing' as never,
      content: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'c2',
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const payload = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    expect(payload).toMatchObject({ type: 'session/send-result', code: 'writer-offline' })
  })

  it('rejects session/send payloads with non-content blocks', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-blocks',
      sessionId: 'sess-1' as never,
      content: [{}] as never,
      clientMessageId: 'c-blocks',
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const payload = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    expect(payload).toMatchObject({ type: 'session/send-result', code: 'invalid' })
  })

  it('rejects invalid session/send payloads', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-invalid',
      sessionId: '' as never,
      content: [],
      clientMessageId: '',
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const payload = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    expect(payload).toMatchObject({ type: 'session/send-result', code: 'invalid' })
  })

  it('delivers session/send to the live writer inbox in order and is idempotent', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    const delivered: string[] = []
    const followup = vi.fn((message: { id: string; content: Array<{ text?: string }> }) => {
      const text = message.content[0]?.text ?? ''
      delivered.push(text)
    })
    ctx.provide('agents', {
      get: (id: string) => id === 'sess-live'
        ? { followup }
        : undefined,
    })

    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-a',
      sessionId: 'sess-live' as never,
      content: [{ type: 'text', text: 'first' }],
      clientMessageId: 'idemp-a',
    })
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-b',
      sessionId: 'sess-live' as never,
      content: [{ type: 'text', text: 'second' }],
      clientMessageId: 'idemp-b',
    })
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-a-dup',
      sessionId: 'sess-live' as never,
      content: [{ type: 'text', text: 'first-again' }],
      clientMessageId: 'idemp-a',
    })

    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBe(3)
    })
    expect(delivered).toEqual(['first', 'second'])
    const replies = send.mock.calls.map(call => JSON.parse(String(call[0])) as {
      requestId: string
      messageId?: string
    })
    const first = replies.find(r => r.requestId === 'r-a')
    const dup = replies.find(r => r.requestId === 'r-a-dup')
    expect(first?.messageId).toBeDefined()
    expect(dup?.messageId).toBe(first?.messageId)
    expect(followup).toHaveBeenCalledTimes(2)
  })

  it('maps a followup throw to an invalid session send', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    ctx.provide('agents', {
      get: () => ({
        followup: () => {
          throw new Error('inbox closed')
        },
      }),
    })
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-throw',
      sessionId: 'sess-live' as never,
      content: [{ type: 'text', text: 'x' }],
      clientMessageId: 'c-throw',
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const payload = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    expect(payload).toMatchObject({ type: 'session/send-result', code: 'invalid' })
  })

  it('stringifies a non-Error followup throw', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)
    ctx.provide('agents', {
      get: () => ({
        followup: () => {
          throw 42
        },
      }),
    })
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-throw-42',
      sessionId: 'sess-live' as never,
      content: [{ type: 'text', text: 'x' }],
      clientMessageId: 'c-throw-42',
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const payload = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    expect(payload).toMatchObject({ type: 'session/send-result', code: 'invalid', error: '42' })
  })

  it('does not reply to session/send when the pod socket is not open', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'read', socket)
    ;(socket as { readyState: number }).readyState = 0
    service.handlePodMessage('pod-1', {
      type: 'session/send',
      requestId: 'r-closed',
      sessionId: 'sess-1' as never,
      content: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'c-closed',
    })
    await new Promise(r => setTimeout(r, 20))
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores session/send from an unknown pod', async () => {
    service.handlePodMessage('missing-pod', {
      type: 'session/send',
      requestId: 'r-missing',
      sessionId: 'sess-1' as never,
      content: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'c-missing',
    })
  })

  async function commandSession(
    podId = 'pod-1',
    sessionId = 'sess-live',
  ): Promise<{ send: ReturnType<typeof vi.fn> }> {
    const { socket, send } = createFakeSocket()
    service.registerPod(podId, 'Pod 1', {}, 'command', socket)
    ctx.provide('agents', {
      get: (id: string) => id === sessionId ? { followup: vi.fn() } : undefined,
    })
    service.handlePodMessage(podId, {
      type: 'session/send',
      requestId: 'r-cmd',
      sessionId: sessionId as never,
      content: [{ type: 'text', text: 'hi' }],
      clientMessageId: 'c-cmd',
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.some((call) => {
        const parsed = JSON.parse(String(call[0])) as { type?: string }
        return parsed.type === 'session/send-result'
      })).toBe(true)
    })
    return { send }
  }

  function approvalReq(sessionId: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
      agent: { session: { id: sessionId } } as Agent,
      toolName: 'bash',
      ...overrides,
    }
  }

  it('does not steal commander on an idempotent session/send replay', async () => {
    const { send: sendA } = await commandSession('pod-a')
    const { socket, send: sendB } = createFakeSocket()
    service.registerPod('pod-b', 'Pod B', {}, 'command', socket)
    service.handlePodMessage('pod-b', {
      type: 'session/send',
      requestId: 'r-replay',
      sessionId: 'sess-live' as never,
      content: [{ type: 'text', text: 'hi-again' }],
      clientMessageId: 'c-cmd',
    })
    await vi.waitFor(() => {
      expect(sendB).toHaveBeenCalled()
    })
    const next = vi.fn(() => Promise.resolve('rejected' as const))
    const forwarded = service.handleApprovalRequest(approvalReq('sess-live'), next)
    await vi.waitFor(() => {
      expect(sendA.mock.calls.some((call) => {
        const parsed = JSON.parse(String(call[0])) as { type?: string }
        return parsed.type === 'approval/request'
      })).toBe(true)
    })
    const request = JSON.parse(String(sendA.mock.calls.find((call) => {
      const parsed = JSON.parse(String(call[0])) as { type?: string }
      return parsed.type === 'approval/request'
    })?.[0])) as FederationWireMessage
    expect(request).toMatchObject({ type: 'approval/request', sessionId: 'sess-live', toolName: 'bash' })
    if (request.type !== 'approval/request') throw new Error('expected approval/request')
    service.handlePodMessage('pod-a', {
      type: 'approval/result',
      requestId: request.requestId,
      outcome: 'allowed-once',
    })
    await expect(forwarded).resolves.toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
  })

  it('delegates approval/request when no pod commands the session', async () => {
    const next = vi.fn(() => Promise.resolve('rejected' as const))
    await expect(service.handleApprovalRequest(approvalReq('sess-none'), next)).resolves.toBe('rejected')
    expect(next).toHaveBeenCalled()
  })

  it('fails closed when the commander is offline, read-only, or missing', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const next = vi.fn(() => Promise.resolve('rejected' as const))

    service.setPodStatus('pod-1', 'offline')
    await expect(service.handleApprovalRequest(approvalReq('sess-live'), next)).resolves.toBe('unavailable')

    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'read', socket)
    await expect(service.handleApprovalRequest(approvalReq('sess-live'), next)).resolves.toBe('unavailable')

    service.unregisterPod('pod-1')
    await expect(service.handleApprovalRequest(approvalReq('sess-live'), next)).resolves.toBe('unavailable')
    expect(next).not.toHaveBeenCalled()
  })

  it('fails closed when the commander socket is not open', async () => {
    await commandSession()
    const record = (service as unknown as { pods: Map<string, { socket: { readyState: number } }> }).pods.get('pod-1')
    if (record) record.socket.readyState = 0
    const next = vi.fn(() => Promise.resolve('rejected' as const))
    await expect(service.handleApprovalRequest(approvalReq('sess-live'), next)).resolves.toBe('unavailable')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns cancelled when the approval signal is already aborted', async () => {
    await commandSession()
    const abort = new AbortController()
    abort.abort()
    const next = vi.fn(() => Promise.resolve('rejected' as const))
    await expect(service.handleApprovalRequest(
      approvalReq('sess-live', { signal: abort.signal }),
      next,
    )).resolves.toBe('cancelled')
    expect(next).not.toHaveBeenCalled()
  })

  it('forwards approval to the commanding pod and claims the outcome', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const abort = new AbortController()
    const pending = service.handleApprovalRequest(
      approvalReq('sess-live', { callId: 'call-1' as never, reason: 'needs grant', signal: abort.signal }),
      () => Promise.resolve('rejected'),
    )
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const request = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    expect(request).toMatchObject({
      type: 'approval/request',
      sessionId: 'sess-live',
      toolName: 'bash',
      callId: 'call-1',
      reason: 'needs grant',
    })
    if (request.type !== 'approval/request') throw new Error('expected approval/request')
    service.handlePodMessage('pod-1', {
      type: 'approval/result',
      requestId: request.requestId,
      outcome: 'allowed-once',
    })
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('normalizes a rogue approval outcome and ignores a result from another pod', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const pending = service.handleApprovalRequest(approvalReq('sess-live'), () => Promise.resolve('rejected'))
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const request = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    if (request.type !== 'approval/request') throw new Error('expected approval/request')
    service.handlePodMessage('other-pod', {
      type: 'approval/result',
      requestId: request.requestId,
      outcome: 'allowed-once',
    })
    service.handlePodMessage('pod-1', {
      type: 'approval/result',
      requestId: 'unknown-id',
      outcome: 'allowed-once',
    })
    service.handlePodMessage('pod-1', {
      type: 'approval/result',
      requestId: request.requestId,
    })
    await expect(pending).resolves.toBe('unavailable')
  })

  it('sends cancel as a no-op when the commander socket has already closed', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const pendingClosed = service.handleApprovalRequest(approvalReq('sess-live'), () => Promise.resolve('rejected'))
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const record = (service as unknown as { pods: Map<string, { socket: { readyState: number } }> }).pods.get('pod-1')
    if (record) record.socket.readyState = 0
    await expect(pendingClosed).resolves.toBe('unavailable')

    send.mockClear()
    if (record) record.socket.readyState = 1
    const pendingMissing = service.handleApprovalRequest(approvalReq('sess-live'), () => Promise.resolve('rejected'))
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    ;(service as unknown as { pods: Map<string, unknown> }).pods.delete('pod-1')
    await expect(pendingMissing).resolves.toBe('unavailable')
  })

  it('skips in-flight interactions that belong to a different pod on offline', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const { socket } = createFakeSocket()
    service.registerPod('pod-other', 'Other', {}, 'command', socket)
    const pending = service.handleApprovalRequest(approvalReq('sess-live'), () => Promise.resolve('rejected'))
    const question = service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    service.setPodStatus('pod-other', 'offline')
    const approvalReqMsg = send.mock.calls
      .map(call => JSON.parse(String(call[0])) as FederationWireMessage)
      .find(msg => msg.type === 'approval/request')
    const questionReqMsg = send.mock.calls
      .map(call => JSON.parse(String(call[0])) as FederationWireMessage)
      .find(msg => msg.type === 'question/request')
    if (approvalReqMsg?.type !== 'approval/request' || questionReqMsg?.type !== 'question/request') {
      throw new Error('expected approval/request and question/request')
    }
    service.handlePodMessage('pod-1', {
      type: 'approval/result',
      requestId: approvalReqMsg.requestId,
      outcome: 'rejected',
    })
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: questionReqMsg.requestId,
      answers: [{ id: 'q', selected: ['ok'] }],
    })
    await expect(pending).resolves.toBe('rejected')
    await expect(question).resolves.toEqual({ answers: [{ id: 'q', selected: ['ok'] }] })
  })

  it('times out an unanswered approval and sends cancel', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const pending = service.handleApprovalRequest(approvalReq('sess-live'), () => Promise.resolve('rejected'))
    await expect(pending).resolves.toBe('unavailable')
    const types = send.mock.calls.map(call => (JSON.parse(String(call[0])) as { type: string }).type)
    expect(types).toContain('approval/request')
    expect(types).toContain('approval/cancel')
  })

  it('settles cancelled and sends cancel when the approval signal aborts', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const abort = new AbortController()
    const pending = service.handleApprovalRequest(
      approvalReq('sess-live', { signal: abort.signal }),
      () => Promise.resolve('rejected'),
    )
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    abort.abort()
    await expect(pending).resolves.toBe('cancelled')
    const types = send.mock.calls.map(call => (JSON.parse(String(call[0])) as { type: string }).type)
    expect(types).toContain('approval/cancel')
  })

  it('fails closed when sending the approval request throws', async () => {
    const { send } = await commandSession()
    send.mockImplementation(() => {
      throw new Error('socket exploded')
    })
    await expect(service.handleApprovalRequest(
      approvalReq('sess-live'),
      () => Promise.resolve('rejected'),
    )).resolves.toBe('unavailable')
  })

  it('routes a commanded question to the pod and returns answers', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const agent = { session: { id: 'sess-live' } } as Agent
    const pending = service.routeQuestion({
      questions: [{ id: 'q1', question: 'Continue?' }],
      agent,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const request = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    expect(request).toMatchObject({ type: 'question/request', sessionId: 'sess-live' })
    if (request.type !== 'question/request') throw new Error('expected question/request')
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: request.requestId,
      answers: [{ id: 'q1', selected: ['yes'] }],
    })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] })
  })

  it('falls back when no pod commands the question session', async () => {
    const fallback = vi.fn(() => Promise.resolve({ answers: [{ id: 'q', selected: ['local'] }] }))
    await expect(service.routeQuestion({ questions: [{ id: 'q', question: '?' }] }, fallback))
      .resolves.toEqual({ answers: [{ id: 'q', selected: ['local'] }] })
    await expect(service.routeQuestion({ questions: [{ id: 'q', question: '?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('rejects a commanded question when the pod is unavailable or the signal is aborted', async () => {
    await commandSession()
    const abort = new AbortController()
    abort.abort()
    await expect(service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
      signal: abort.signal,
    })).rejects.toMatchObject({ code: 'ASK_ABORTED' })

    service.setPodStatus('pod-1', 'offline')
    await expect(service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })
  })

  it('rejects invalid question answers, foreign results, and pod error payloads', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const pendingInvalid = service.routeQuestion({
      questions: [{ id: 'q1', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const first = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    if (first.type !== 'question/request') throw new Error('expected question/request')
    service.handlePodMessage('other', {
      type: 'question/result',
      requestId: first.requestId,
      answers: [{ id: 'q1', selected: ['stolen'] }],
    })
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: 'unknown-q',
      answers: [{ id: 'q1', selected: ['nope'] }],
    })
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: first.requestId,
      answers: [{ id: 1, selected: ['x'] } as never],
    })
    await expect(pendingInvalid).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })

    send.mockClear()
    const pendingError = service.routeQuestion({
      questions: [{ id: 'q2', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const second = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    if (second.type !== 'question/request') throw new Error('expected question/request')
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: second.requestId,
      error: { code: 'ASK_ABORTED', message: 'user walked away' },
    })
    await expect(pendingError).rejects.toBeInstanceOf(UserQuestionError)
    await expect(pendingError).rejects.toMatchObject({ code: 'ASK_ABORTED', message: 'user walked away' })
  })

  it('times out an unanswered question and aborts a live question signal', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const timedOut = service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await expect(timedOut).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })
    expect(send.mock.calls.map(call => (JSON.parse(String(call[0])) as { type: string }).type))
      .toContain('question/cancel')

    send.mockClear()
    const abort = new AbortController()
    const aborted = service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
      signal: abort.signal,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    abort.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('rejects a question when sending the request throws', async () => {
    const { send } = await commandSession()
    send.mockImplementation(() => {
      throw new Error('socket exploded')
    })
    await expect(service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })
  })

  it('settles in-flight approvals and questions when the commander goes offline', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const approval = service.handleApprovalRequest(
      approvalReq('sess-live'),
      () => Promise.resolve('rejected'),
    )
    const question = service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    service.setPodStatus('pod-1', 'offline')
    await expect(approval).resolves.toBe('unavailable')
    await expect(question).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })
  })

  it('settles in-flight interactions when the hub context is disposed', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const approval = service.handleApprovalRequest(
      approvalReq('sess-live'),
      () => Promise.resolve('rejected'),
    )
    const question = service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    await ctx.fiber.dispose()
    await expect(approval).resolves.toBe('unavailable')
    await expect(question).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })
    ctx = new Context()
    service = new FederationHubService(ctx, { interactionTimeoutMs: 80 })
  })

  it('binds the approval waterfall and user-questions ask intercept', async () => {
    await ctx.plugin(ApprovalService)
    await ctx.plugin(UserQuestionService)
    service.bindInteractionBridges()
    const localAsk = vi.fn(() => Promise.resolve({ answers: [{ id: 'q', selected: ['local'] }] }))
    ctx.userQuestions.registerProvider({ ask: localAsk })
    await expect(ctx.userQuestions.ask({ questions: [{ id: 'q', question: '?' }] }))
      .resolves.toEqual({ answers: [{ id: 'q', selected: ['local'] }] })

    const { send } = await commandSession()
    send.mockClear()
    const events: Array<{ type: string }> = [{ type: 'turn/start' }]
    const agent = {
      session: {
        id: 'sess-live',
        events,
        append: (type: string, data: Record<string, unknown>) => {
          events.push({ type })
          return { type, data }
        },
      },
    } as unknown as Agent
    const outcomeP = ctx.approval.request({ agent, toolName: 'bash' })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const request = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    if (request.type !== 'approval/request') throw new Error('expected approval/request')
    service.handlePodMessage('pod-1', {
      type: 'approval/result',
      requestId: request.requestId,
      outcome: 'allowed-once',
    })
    await expect(outcomeP).resolves.toBe('allowed-once')

    send.mockClear()
    localAsk.mockClear()
    const asked = ctx.userQuestions.ask({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const qreq = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    if (qreq.type !== 'question/request') throw new Error('expected question/request')
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: qreq.requestId,
      answers: [{ id: 'q', selected: ['remote'] }],
    })
    await expect(asked).resolves.toEqual({ answers: [{ id: 'q', selected: ['remote'] }] })
    expect(localAsk).not.toHaveBeenCalled()
  })

  it('rejects empty or malformed question answer items', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const pending = service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const request = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    if (request.type !== 'question/request') throw new Error('expected question/request')
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: request.requestId,
      answers: [],
    })
    await expect(pending).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })

    send.mockClear()
    const pendingNull = service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const second = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    if (second.type !== 'question/request') throw new Error('expected question/request')
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: second.requestId,
      answers: [null as never, { id: 'q', selected: [1 as never] }, { id: 'q', selected: 'yes' as never }],
    })
    await expect(pendingNull).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })
  })

  it('maps an empty error payload on question/result to COMMANDER_UNAVAILABLE', async () => {
    const { send } = await commandSession()
    send.mockClear()
    const pending = service.routeQuestion({
      questions: [{ id: 'q', question: '?' }],
      agent: { session: { id: 'sess-live' } } as Agent,
    })
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled()
    })
    const request = JSON.parse(String(send.mock.calls.at(-1)?.[0])) as FederationWireMessage
    if (request.type !== 'question/request') throw new Error('expected question/request')
    service.handlePodMessage('pod-1', {
      type: 'question/result',
      requestId: request.requestId,
      error: { code: '', message: '' },
    })
    await expect(pending).rejects.toMatchObject({ code: 'COMMANDER_UNAVAILABLE' })
  })
})

describe('FederationHubServer integration', () => {
  let ctx: Context
  let service: FederationHubService
  let server: FederationHubServer
  let port: number
  const secretToken = 'test-secret-token-123'

  beforeEach(async () => {
    ctx = new Context()
    service = new FederationHubService(ctx)
    server = new FederationHubServer(service, {
      port: 0,
      host: '127.0.0.1',
      token: secretToken,
      heartbeatTimeoutMs: 500,
    })
    await server.start()
    port = server.getPort()
  })

  afterEach(async () => {
    await server.stop()
    await ctx.fiber.dispose()
  })

  it('rejects connection without token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/federation/connect`)
    const errorPromise = new Promise<Error>((resolve) => {
      ws.on('error', (err) => { resolve(err) })
    })

    const err = await errorPromise
    expect(err.message).toMatch(/401|Unexpected server response/)
  })

  it('authenticates and registers a pod via WebSocket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/federation/connect?token=${secretToken}`)

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => { resolve() })
      ws.on('error', reject)
    })

    const regMsg = {
      type: 'federation/register',
      podId: 'pod-mac-1',
      name: 'Mac Pod',
      capabilities: { workspaces: ['/Users/test/workspace'] },
    }
    ws.send(JSON.stringify(regMsg))

    const ackPromise = new Promise<FederationRegisteredMessage>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
        if (msg.type === 'federation/registered') {
          resolve(msg)
        }
      })
    })

    const ack = await ackPromise
    expect(ack.type).toBe('federation/registered')
    expect(ack.podId).toBe('pod-mac-1')

    const registered = service.getPod('pod-mac-1')
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('Mac Pod')
    expect(registered?.status).toBe('online')

    // Heartbeat
    ws.send(JSON.stringify({ type: 'federation/heartbeat', podId: 'pod-mac-1' }))
    const hbAckPromise = new Promise<FederationHeartbeatAckMessage>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
        if (msg.type === 'federation/heartbeat_ack') {
          resolve(msg)
        }
      })
    })

    const hbAck = await hbAckPromise
    expect(hbAck.type).toBe('federation/heartbeat_ack')

    ws.close()
  })

  it('marks pod offline when heartbeats stop', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/federation/connect?token=${secretToken}`)

    await new Promise<void>((resolve) => {
      ws.on('open', () => { resolve() })
    })

    ws.send(JSON.stringify({
      type: 'federation/register',
      podId: 'pod-mac-2',
      name: 'Mac Pod 2',
    }))

    await new Promise<void>((resolve) => {
      ws.on('message', () => { resolve() })
    })

    expect(service.getPod('pod-mac-2')?.status).toBe('online')

    // Wait for reaper to run past heartbeatTimeoutMs (500ms)
    await new Promise<void>((res) => { setTimeout(() => { res() }, 1200) })

    expect(service.getPod('pod-mac-2')?.status).toBe('offline')
    ws.close()
  })

  it('routes delegation between client and connected pod', async () => {
    // 1. Connect Pod
    const podWs = new WebSocket(`ws://127.0.0.1:${port}/federation/connect?token=${secretToken}`)
    await new Promise<void>((res) => { podWs.on('open', () => { res() }) })

    podWs.send(JSON.stringify({
      type: 'federation/register',
      podId: 'worker-pod-1',
      name: 'Worker Pod 1',
    }))

    await new Promise<void>((res) => { podWs.once('message', () => { res() }) })

    // Listen on Pod for incoming subagent/start
    podWs.on('message', (data) => {
      const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
      if (msg.type === 'subagent/start') {
        const chunk: RemoteSubagentChunkMessage = {
          type: 'subagent/chunk',
          id: msg.id,
          delta: 'Pod generated output chunk',
        }
        podWs.send(JSON.stringify(chunk))

        const stop: RemoteSubagentStopMessage = {
          type: 'subagent/stop',
          id: msg.id,
          output: [{ type: 'text', text: 'Final result from pod' }],
          stopReason: 'completed',
          usage: { totalTokens: 42 },
        }
        podWs.send(JSON.stringify(stop))
      }
    })

    // 2. Connect Client to /federation/subagent
    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/federation/subagent?token=${secretToken}`)
    await new Promise<void>((res) => { clientWs.on('open', () => { res() }) })

    const startMsg: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'delegation-run-1',
      prompt: [{ type: 'text', text: 'Solve problem' }],
      env: { FEDERATION_TARGET_POD: 'worker-pod-1' },
    }
    clientWs.send(JSON.stringify(startMsg))

    const receivedChunks: string[] = []
    const finalStop = await new Promise<RemoteSubagentStopMessage>((resolve) => {
      clientWs.on('message', (data) => {
        const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
        if (msg.type === 'subagent/chunk') {
          receivedChunks.push(msg.delta)
        } else if (msg.type === 'subagent/stop') {
          resolve(msg)
        }
      })
    })

    expect(receivedChunks).toContain('Pod generated output chunk')
    expect(finalStop.stopReason).toBe('completed')
    expect(finalStop.output[0]).toEqual({ type: 'text', text: 'Final result from pod' })
    expect(finalStop.usage?.totalTokens).toBe(42)

    podWs.close()
    clientWs.close()
  })

  it('answers error when no pods are available for delegation', async () => {
    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/federation/subagent?token=${secretToken}`)
    await new Promise<void>((res) => { clientWs.on('open', () => { res() }) })

    const startMsg: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'delegation-run-no-pod',
      prompt: [{ type: 'text', text: 'Solve problem' }],
    }
    clientWs.send(JSON.stringify(startMsg))

    const stopMsg = await new Promise<RemoteSubagentStopMessage>((resolve) => {
      clientWs.on('message', (data) => {
        const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
        if (msg.type === 'subagent/stop') {
          resolve(msg)
        }
      })
    })

    expect(stopMsg.stopReason).toBe('error')
    expect(stopMsg.diagnostic).toMatch(/no online pods/)
    clientWs.close()
  })

  it('exposes read session operations (list, get, search, subscribe)', async () => {
    let streamCallback: ((event: { seq: number; type: string; content: string }) => void) | undefined
    const mockSources = {
      listAllSessions: vi.fn().mockResolvedValue([
        { id: 'session-123', title: 'Test Session', createdAt: 1000, sourceId: 'local', updatedAt: 1000 },
      ]),
      getSession: vi.fn().mockResolvedValue({
        sourceId: 'local',
        session: {
          header: { id: 'session-123', version: 0, createdAt: 1000 },
          events: [{ seq: 0, type: 'session/started' }],
        },
      }),
      searchAllSessions: vi.fn().mockResolvedValue([
        { id: 'session-123', title: 'Test Session', createdAt: 1000, sourceId: 'local', updatedAt: 1000 },
      ]),
      subscribeEvents: vi.fn().mockImplementation(
        (_sessionId: string, cb: (event: { seq: number; type: string; content: string }) => void) => {
          streamCallback = cb
          return () => { streamCallback = undefined }
        },
      ),
    }
    // Assign to ctx
    ctx.provide('sessionSources')
    ;(ctx as unknown as { sessionSources: unknown }).sessionSources = mockSources

    const podWs = new WebSocket(`ws://127.0.0.1:${port}/federation/connect?token=${secretToken}`)
    await new Promise<void>((res) => { podWs.on('open', () => { res() }) })

    // Register pod
    podWs.send(JSON.stringify({
      type: 'federation/register',
      podId: 'session-client-pod',
      name: 'Session Client Pod',
    }))

    await new Promise<void>((res) => {
      podWs.once('message', () => { res() })
    })

    // Test session/list
    podWs.send(JSON.stringify({
      type: 'session/list',
      requestId: 'req-list-1',
    }))

    const listResult = await new Promise<{
      type: string
      requestId: string
      sessions: Array<{ id: string }>
    }>((resolve) => {
      podWs.once('message', (data) => {
        resolve(JSON.parse(rawDataToString(data)) as {
          type: string
          requestId: string
          sessions: Array<{ id: string }>
        })
      })
    })

    expect(listResult.type).toBe('session/list-result')
    expect(listResult.requestId).toBe('req-list-1')
    expect(listResult.sessions).toHaveLength(1)
    expect(listResult.sessions[0]?.id).toBe('session-123')

    // Test session/get
    podWs.send(JSON.stringify({
      type: 'session/get',
      requestId: 'req-get-1',
      sessionId: 'session-123',
    }))

    const getResult = await new Promise<{
      type: string
      requestId: string
      session?: { header: { id: string } }
    }>((resolve) => {
      podWs.once('message', (data) => {
        resolve(JSON.parse(rawDataToString(data)) as {
          type: string
          requestId: string
          session?: { header: { id: string } }
        })
      })
    })

    expect(getResult.type).toBe('session/get-result')
    expect(getResult.requestId).toBe('req-get-1')
    expect(getResult.session?.header.id).toBe('session-123')

    // Test session/search
    podWs.send(JSON.stringify({
      type: 'session/search',
      requestId: 'req-search-1',
      query: 'Test',
    }))

    const searchResult = await new Promise<{
      type: string
      requestId: string
      sessions: Array<{ id: string }>
    }>((resolve) => {
      podWs.once('message', (data) => {
        resolve(JSON.parse(rawDataToString(data)) as {
          type: string
          requestId: string
          sessions: Array<{ id: string }>
        })
      })
    })

    expect(searchResult.type).toBe('session/search-result')
    expect(searchResult.requestId).toBe('req-search-1')
    expect(searchResult.sessions).toHaveLength(1)

    // Test session/subscribe & stream event
    podWs.send(JSON.stringify({
      type: 'session/subscribe',
      subscriptionId: 'sub-1',
      sessionId: 'session-123',
    }))

    // Wait a tick for subscribe handler to execute
    await new Promise(r => setTimeout(r, 50))
    expect(streamCallback).toBeDefined()

    // Trigger an event from the stream
    streamCallback!({ seq: 1, type: 'user/message', content: 'Hello' })

    const streamMsg = await new Promise<{
      type: string
      subscriptionId: string
      sessionId: string
      event: { type: string }
    }>((resolve) => {
      podWs.once('message', (data) => {
        resolve(JSON.parse(rawDataToString(data)) as {
          type: string
          subscriptionId: string
          sessionId: string
          event: { type: string }
        })
      })
    })

    expect(streamMsg.type).toBe('session/stream-event')
    expect(streamMsg.subscriptionId).toBe('sub-1')
    expect(streamMsg.sessionId).toBe('session-123')
    expect(streamMsg.event.type).toBe('user/message')

    // Test session/unsubscribe
    podWs.send(JSON.stringify({
      type: 'session/unsubscribe',
      subscriptionId: 'sub-1',
    }))
    await new Promise(r => setTimeout(r, 50))
    expect(streamCallback).toBeUndefined()

    podWs.close()
  })
})

describe('federation-hub apply', () => {
  it('starts the server as an effect and stops it on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionSourcePlugin)
    await ctx.plugin(HubPlugin, {
      port: 0,
      host: '127.0.0.1',
      token: 'apply-token',
      interactionTimeoutMs: 50,
    })
    await ctx.fiber.dispose()
  })

  it('apply uses the default interaction timeout when the field is omitted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionSourcePlugin)
    HubPlugin.apply(ctx, {
      port: 0,
      host: '127.0.0.1',
      token: 'apply-token',
    })
    await ctx.fiber.dispose()
  })

  it('does not log a start failure after dispose', async () => {
    const start = vi.spyOn(FederationHubServer.prototype, 'start').mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 30))
      throw new Error('listen failed')
    })
    const ctx = new Context()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    await ctx.plugin(SessionSourcePlugin)
    await ctx.plugin(HubPlugin, {
      port: 0,
      host: '127.0.0.1',
      token: 'apply-token',
    })
    await ctx.fiber.dispose()
    await new Promise(r => setTimeout(r, 50))
    expect(error).not.toHaveBeenCalled()
    start.mockRestore()
  })

  it('logs when the listening server fails to start', async () => {
    const holder = new Context()
    const occupied = new FederationHubServer(new FederationHubService(holder), {
      port: 0,
      host: '127.0.0.1',
      token: 'occupied',
    })
    await occupied.start()
    const ctx = new Context()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    await ctx.plugin(SessionSourcePlugin)
    await ctx.plugin(HubPlugin, {
      port: occupied.getPort(),
      host: '127.0.0.1',
      token: 'apply-token',
    })
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalled()
    })
    await ctx.fiber.dispose()
    await occupied.stop()
    await holder.fiber.dispose()
  })
})
