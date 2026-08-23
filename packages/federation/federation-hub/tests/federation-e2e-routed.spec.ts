/**
 * Keyless routed-execution e2e (proposal phase 2): a commanding pod drives a
 * hub session whose writer is attached lazily through the bound writer
 * source. Covers send cold-start, queue/cancel/model routing, and structured
 * failures while the link is down — execution stays on the hub, never
 * materializes on the pod.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  FederationHubServer,
  FederationHubService,
} from '../src/index.ts'
import * as FederationClientPlugin from '../../federation-client/src/index.ts'

describe('Federation routed-execution e2e', () => {
  let hubCtx: Context | undefined
  let podCtx: Context | undefined
  let hubServer: FederationHubServer | undefined
  let hubService: FederationHubService | undefined
  const token = 'routed-secret-token'

  afterEach(async () => {
    if (podCtx) {
      await podCtx.fiber.dispose()
      podCtx = undefined
    }
    if (hubServer) {
      await hubServer.stop()
      hubServer = undefined
    }
    if (hubCtx) {
      await hubCtx.fiber.dispose()
      hubCtx = undefined
    }
    hubService = undefined
  })

  interface WriterSpy {
    followup: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    inbox: { nextTurn: { id: string }[]; nextStep: { id: string }[]; replace: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
    steer: ReturnType<typeof vi.fn>
  }

  /** Install the writer source as the host gateway would: lazy per-session attach. */
  function bindLazyWriter(resolved: Map<string, WriterSpy>): void {
    hubService!.bindWriterSource({
      resolveWriter: async (sessionId) => {
        const existing = resolved.get(sessionId)
        if (existing !== undefined) return { agent: existing as unknown as Agent }
        const spy: WriterSpy = {
          followup: vi.fn(),
          cancel: vi.fn(),
          inbox: { nextTurn: [], nextStep: [], replace: vi.fn(), remove: vi.fn() },
          steer: vi.fn(),
        }
        resolved.set(sessionId, spy)
        return { agent: spy as unknown as Agent }
      },
      applySelection: async (_sessionId, selection) => ({ ok: true, selected: { ...selection } }),
    })
  }

  async function startHub(): Promise<number> {
    hubCtx = new Context()
    hubService = new FederationHubService(hubCtx)
    hubServer = new FederationHubServer(hubService, {
      port: 0,
      host: '127.0.0.1',
      token,
      heartbeatTimeoutMs: 5_000,
    })
    await hubServer.start()
    return hubServer.getPort()
  }

  async function startPod(hubPort: number): Promise<void> {
    podCtx = new Context()
    await podCtx.plugin(FederationClientPlugin, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId: 'pod-cmd',
      name: 'Command Pod',
      token,
      reconnectDelayMs: 50,
      maxReconnectDelayMs: 200,
      requestTimeoutMs: 2_000,
    })
    await vi.waitFor(() => {
      expect(podCtx!.federationClient.getStatus()).toBe('connected')
    })
  }

  it('cold-starts the writer on send and routes queue, cancel, and model selection to it', async () => {
    const hubPort = await startHub()
    const resolved = new Map<string, WriterSpy>()
    bindLazyWriter(resolved)
    await startPod(hubPort)

    // Cold session: no live agent exists before the first send.
    expect(resolved.size).toBe(0)
    const sent = await podCtx!.federationClient.sendToSession(
      SessionId('sess-routed'),
      [{ type: 'text', text: 'wake up' }],
      'c-wake',
    )
    expect(sent).toMatchObject({ ok: true })
    const writer = resolved.get('sess-routed')
    expect(writer?.followup).toHaveBeenCalledTimes(1)

    // Queue mutation rides the same channel to the same writer.
    writer!.inbox.nextTurn.push({ id: 'm1' })
    const removed = await podCtx!.federationClient.queueUpdateSession(
      SessionId('sess-routed'),
      'm1',
      { kind: 'remove' },
    )
    expect(removed).toEqual({ ok: true, accepted: true })
    expect(writer!.inbox.remove).toHaveBeenCalledWith('m1')

    // Cancellation reaches the hub writer with its inbox intact.
    const cancelled = await podCtx!.federationClient.cancelSession(SessionId('sess-routed'))
    expect(cancelled).toEqual({ ok: true, accepted: true })
    expect(writer!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })

    // Model selection applies through the writer source seat.
    const selected = await podCtx!.federationClient.selectModelSession(
      SessionId('sess-routed'),
      { provider: 'deepseek-official', model: 'deepseek-reasoner' },
    )
    expect(selected).toEqual({
      ok: true,
      selected: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
    })

    // Idempotent resend still answers with the original message id.
    const replay = await podCtx!.federationClient.sendToSession(
      SessionId('sess-routed'),
      [{ type: 'text', text: 'wake up' }],
      'c-wake',
    )
    expect(replay).toMatchObject({ ok: true })
    expect((replay as { messageId?: string }).messageId)
      .toBe((sent as { messageId?: string }).messageId)
    expect(writer!.followup).toHaveBeenCalledTimes(1)
  })

  it('reports an unknown cold session and keeps execution off the pod', async () => {
    const hubPort = await startHub()
    hubService!.bindWriterSource({
      resolveWriter: async () => ({
        error: { code: 'session-not-found', message: 'session "sess-ghost" not found' },
      }),
      applySelection: async () => ({ ok: false, message: 'unused' }),
    })
    await startPod(hubPort)
    const sent = await podCtx!.federationClient.sendToSession(
      SessionId('sess-ghost'),
      [{ type: 'text', text: 'hi' }],
      'c-ghost',
    )
    expect(sent).toEqual({
      ok: false,
      code: 'invalid',
      message: 'session "sess-ghost" not found',
    })
  })

  it('fails control verbs with structured disconnects while the link is down', async () => {
    const hubPort = await startHub()
    const resolved = new Map<string, WriterSpy>()
    bindLazyWriter(resolved)
    await startPod(hubPort)
    await hubServer!.stop()

    const sent = await podCtx!.federationClient.sendToSession(
      SessionId('sess-routed'),
      [{ type: 'text', text: 'hi' }],
      'c-down',
    )
    expect(sent).toMatchObject({ ok: false, code: 'disconnected' })
    const cancelled = await podCtx!.federationClient.cancelSession(SessionId('sess-routed'))
    expect(cancelled).toMatchObject({ ok: false, code: 'disconnected' })
    // Nothing attached locally: execution never migrated to the pod.
    expect(resolved.size).toBe(0)
  })
})
