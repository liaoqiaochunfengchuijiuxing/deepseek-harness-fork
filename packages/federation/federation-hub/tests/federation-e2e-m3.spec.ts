/**
 * Keyless M3 e2e: a real hub writer and a commanding pod over WebSocket.
 * Covers inbox delivery, fail-closed approval on the commander, in-flight
 * disconnect, idempotent resend after reconnect, and no silent auto-grant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type WebSocket from 'ws'
import {
  FederationHubServer,
  FederationHubService,
} from '../src/index.ts'
import * as FederationClientPlugin from '../../federation-client/src/index.ts'

describe('Federation M3 command-level e2e', () => {
  let hubCtx: Context | undefined
  let podCtx: Context | undefined
  let hubServer: FederationHubServer | undefined
  let hubService: FederationHubService | undefined
  const token = 'm3-secret-token'
  const sessionId = 'sess-m3'

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

  function writerFollowup(): ReturnType<typeof vi.fn> {
    const followup = vi.fn()
    hubCtx!.provide('agents', {
      get: (id: string) => id === sessionId
        ? { followup, session: { id: sessionId } }
        : undefined,
    })
    return followup
  }

  function approvalAgent(): Agent {
    const events: Array<{ type: string }> = [{ type: 'turn/start' }]
    return {
      session: {
        id: sessionId,
        events,
        append: (type: string, data: Record<string, unknown>) => {
          events.push({ type })
          return { type, data }
        },
      },
    } as unknown as Agent
  }

  function podSocket(podId: string): WebSocket | undefined {
    return (hubService as unknown as {
      pods: Map<string, { socket: WebSocket }>
    }).pods.get(podId)?.socket
  }

  async function waitForLiveCommander(previous?: WebSocket): Promise<void> {
    await vi.waitFor(() => {
      const current = podSocket('pod-cmd')
      expect(current).toBeDefined()
      if (previous !== undefined) expect(current).not.toBe(previous)
      expect(current?.readyState).toBe(1)
      expect(hubService!.getPod('pod-cmd')?.status).toBe('online')
      expect(podCtx!.federationClient.getStatus()).toBe('connected')
    })
  }

  async function startHub(): Promise<number> {
    hubCtx = new Context()
    await hubCtx.plugin(ApprovalService)
    hubService = new FederationHubService(hubCtx, { interactionTimeoutMs: 800 })
    hubService.bindInteractionBridges()
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

  it('delivers session/send to the writer inbox and routes approval to the commander', async () => {
    const hubPort = await startHub()
    const followup = writerFollowup()
    const seen: string[] = []
    await startPod(hubPort)
    podCtx!.on('federation/approval-request', (req) => {
      seen.push(req.toolName)
      return Promise.resolve('rejected' as const)
    })

    const sent = await podCtx!.federationClient.sendToSession(
      SessionId(sessionId),
      [{ type: 'text', text: 'hello from pod' }],
      'c-hello',
    )
    expect(sent).toMatchObject({ ok: true })
    expect(followup).toHaveBeenCalledTimes(1)

    const outcome = await hubCtx!.approval.request({
      agent: approvalAgent(),
      toolName: 'bash',
      reason: 'needs grant',
    })
    expect(outcome).toBe('rejected')
    expect(seen).toEqual(['bash'])
  })

  it('rejects an in-flight send on disconnect and resends idempotently after reconnect', async () => {
    const hubPort = await startHub()
    const followup = vi.fn(() => {
      if (followup.mock.calls.length === 1) podSocket('pod-cmd')?.close()
    })
    hubCtx!.provide('agents', {
      get: (id: string) => id === sessionId
        ? { followup, session: { id: sessionId } }
        : undefined,
    })
    await startPod(hubPort)

    const first = await podCtx!.federationClient.sendToSession(
      SessionId(sessionId),
      [{ type: 'text', text: 'in-flight' }],
      'c-idemp',
    )
    if (!first.ok) expect(first.code).toBe('disconnected')
    expect(followup).toHaveBeenCalledTimes(1)

    await waitForLiveCommander()

    const replay = await podCtx!.federationClient.sendToSession(
      SessionId(sessionId),
      [{ type: 'text', text: 'in-flight-again' }],
      'c-idemp',
    )
    expect(replay).toMatchObject({ ok: true })
    expect(followup).toHaveBeenCalledTimes(1)
    const fresh = await podCtx!.federationClient.sendToSession(
      SessionId(sessionId),
      [{ type: 'text', text: 'second' }],
      'c-next',
    )
    expect(fresh).toMatchObject({ ok: true })
    expect(followup).toHaveBeenCalledTimes(2)
  })

  it('fails a pending approval closed on disconnect and never auto-grants', async () => {
    const hubPort = await startHub()
    const followup = writerFollowup()
    let invoked = false
    await startPod(hubPort)
    podCtx!.on('federation/approval-request', () => {
      invoked = true
      return new Promise(() => {})
    })
    const sent = await podCtx!.federationClient.sendToSession(
      SessionId(sessionId),
      [{ type: 'text', text: 'command' }],
      'c-cmd',
    )
    expect(sent.ok).toBe(true)
    expect(followup).toHaveBeenCalledTimes(1)

    const pending = hubCtx!.approval.request({
      agent: approvalAgent(),
      toolName: 'bash',
    })
    await vi.waitFor(() => {
      expect(invoked).toBe(true)
    })
    podSocket('pod-cmd')?.close()
    await expect(pending).resolves.toBe('unavailable')
  })

  it('routes a new approval to the same commander after reconnect', async () => {
    const hubPort = await startHub()
    writerFollowup()
    const seen: string[] = []
    await startPod(hubPort)
    podCtx!.on('federation/approval-request', (req) => {
      seen.push(req.requestId)
      return Promise.resolve('rejected' as const)
    })
    await podCtx!.federationClient.sendToSession(
      SessionId(sessionId),
      [{ type: 'text', text: 'command' }],
      'c-cmd',
    )
    const previous = podSocket('pod-cmd')
    previous?.close()
    await waitForLiveCommander(previous)
    const outcome = await hubCtx!.approval.request({
      agent: approvalAgent(),
      toolName: 'bash',
    })
    expect(outcome).toBe('rejected')
    expect(seen.length).toBe(1)
  })
})
