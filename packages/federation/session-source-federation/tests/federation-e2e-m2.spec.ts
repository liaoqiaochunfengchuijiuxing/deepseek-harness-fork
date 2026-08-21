/**
 * Keyless M2 e2e: a real hub process and a pod session-source client over
 * WebSocket. Covers list/inspect/search/live stream, degraded disconnect,
 * and reconnect recovery. No model, no key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as SessionSourcePlugin from '@deepseek-ai/dsh-session-source'
import * as LocalSessionSourcePlugin from '@deepseek-ai/dsh-session-source-local'
import { FederationHubService, FederationHubServer } from '@deepseek-ai/dsh-federation-hub'
import * as FederationSourcePlugin from '../src/index.ts'
import { FederationSessionSource } from '../src/index.ts'

describe('Federation M2 read-only native experience e2e', () => {
  let hubCtx: Context | undefined
  let podCtx: Context | undefined
  let hubServer: FederationHubServer | undefined
  let hubService: FederationHubService | undefined
  const token = 'm2-secret-token'

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

  async function startHub(port = 0): Promise<number> {
    hubCtx = new Context()
    await hubCtx.plugin(SessionStore)
    await hubCtx.plugin(SessionSourcePlugin)
    await hubCtx.plugin(LocalSessionSourcePlugin)

    const hubSession = hubCtx.sessions.create(SessionId('hub-session-alpha'), {
      meta: { cwd: process.cwd() },
    })
    hubSession.append('turn/start', { turn: 1 })

    hubService = new FederationHubService(hubCtx)
    hubServer = new FederationHubServer(hubService, {
      port,
      host: '127.0.0.1',
      token,
      allowAnonymous: false,
    })
    await hubServer.start()
    return hubServer.getPort()
  }

  async function startPod(hubPort: number): Promise<FederationSessionSource> {
    podCtx = new Context()
    await podCtx.plugin(SessionSourcePlugin)
    await podCtx.plugin(FederationSourcePlugin, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      token,
      sourceId: 'federation-hub',
      sourceName: 'Hub Sessions',
      reconnectDelayMs: 50,
    })
    const source = podCtx.sessionSources.getSource('federation-hub')
    expect(source).toBeDefined()
    const remote = source as FederationSessionSource
    await vi.waitFor(() => {
      expect(remote.online).toBe(true)
    })
    return remote
  }

  it('lists, inspects, searches, streams, degrades on disconnect, and recovers on reconnect', async () => {
    const hubPort = await startHub()
    const remote = await startPod(hubPort)

    const allSessions = await podCtx!.sessionSources.listAllSessions()
    const remoteSession = allSessions.find(s => s.id === SessionId('hub-session-alpha'))
    expect(remoteSession).toBeDefined()
    expect(remoteSession?.sourceId).toBe('federation-hub')
    expect(remoteSession?.sourceName).toBe('Hub Sessions')
    expect(remoteSession?.nodeKind).toBe('remote')
    expect(remoteSession?.cwd).toBe(process.cwd())
    expect(remoteSession?.isDegraded).toBeUndefined()

    const inspection = await podCtx!.sessionSources.getSession(SessionId('hub-session-alpha'))
    expect(inspection?.session.header.id).toBe(SessionId('hub-session-alpha'))
    expect(inspection?.session.events.length).toBeGreaterThanOrEqual(1)

    const searched = await podCtx!.sessionSources.searchAllSessions({ cwd: process.cwd() })
    expect(searched.some(s => s.id === SessionId('hub-session-alpha'))).toBe(true)

    const streamedEvents: SessionEvent[] = []
    const unsubscribe = await podCtx!.sessionSources.subscribeEvents(
      SessionId('hub-session-alpha'),
      (event) => {
        streamedEvents.push(event)
      },
      0,
    )

    await vi.waitFor(() => {
      expect(streamedEvents.some(e => e.type === 'turn/start')).toBe(true)
    })

    const live = hubCtx!.sessions.get(SessionId('hub-session-alpha'))
    expect(live).toBeDefined()
    live!.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(streamedEvents.some(e => e.type === 'turn/end')).toBe(true)
    })
    unsubscribe()

    await hubServer!.stop()
    hubServer = undefined
    await vi.waitFor(() => {
      expect(remote.online).toBe(false)
    })

    const degradedList = await podCtx!.sessionSources.listAllSessions()
    const degradedSession = degradedList.find(s => s.id === SessionId('hub-session-alpha'))
    expect(degradedSession?.isDegraded).toBe(true)

    hubServer = new FederationHubServer(hubService!, {
      port: hubPort,
      host: '127.0.0.1',
      token,
      allowAnonymous: false,
    })
    await hubServer.start()

    await vi.waitFor(() => {
      expect(remote.online).toBe(true)
    })

    const recovered = await podCtx!.sessionSources.listAllSessions()
    const recoveredSession = recovered.find(s => s.id === SessionId('hub-session-alpha'))
    expect(recoveredSession).toBeDefined()
    expect(recoveredSession?.isDegraded).toBeUndefined()
    expect(recoveredSession?.sourceId).toBe('federation-hub')
  })
})
