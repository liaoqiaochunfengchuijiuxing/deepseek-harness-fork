/**
 * Keyless M4 e2e: persist spool upload, writer leases, fork-to-local derived
 * messages, and credentials never on the persist wire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as SessionSourcePlugin from '@deepseek-ai/dsh-session-source'
import * as LocalSessionSourcePlugin from '@deepseek-ai/dsh-session-source-local'
import { oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'
import {
  FederationHubServer,
  FederationHubService,
} from '../src/index.ts'
import * as FederationClientPlugin from '../../federation-client/src/index.ts'
import * as FederationSourcePlugin from '../../session-source-federation/src/index.ts'
import { FederationSessionSource } from '../../session-source-federation/src/index.ts'

describe('Federation M4 roaming e2e', () => {
  let hubCtx: Context | undefined
  let podCtx: Context | undefined
  let podBCtx: Context | undefined
  let hubServer: FederationHubServer | undefined
  let hubService: FederationHubService | undefined
  const token = 'm4-secret-token'
  const stored = new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()

  afterEach(async () => {
    if (podBCtx) {
      await podBCtx.fiber.dispose()
      podBCtx = undefined
    }
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
    stored.clear()
  })

  async function startHub(): Promise<number> {
    hubCtx = new Context()
    await hubCtx.plugin(SessionStore)
    await hubCtx.plugin(SessionSourcePlugin)
    await hubCtx.plugin(LocalSessionSourcePlugin)
    hubCtx.provide('sessionPersistence', {
      inspect: async (id: SessionId) => {
        const entry = stored.get(String(id))
        if (entry === undefined) throw new Error('missing')
        return { meta: entry.meta, events: entry.events }
      },
      create: async (meta: SessionHeader) => {
        stored.set(String(meta.id), { meta, events: [] })
      },
      append: async (id: SessionId, events: SessionEvent[]) => {
        const entry = stored.get(String(id))
        if (entry === undefined) throw new Error('not materialized')
        entry.events.push(...events)
      },
      list: async () => [...stored.values()].map(entry => entry.meta),
    })
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

  async function startPod(hubPort: number, podId: string): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(FederationClientPlugin, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId,
      name: podId,
      token,
      requestTimeoutMs: 2_000,
    })
    await vi.waitFor(() => {
      expect(ctx.federationClient.getStatus()).toBe('connected')
    })
    return ctx
  }

  it('uploads a spool batch without credentials and enforces a writer lease', async () => {
    const hubPort = await startHub()
    podCtx = await startPod(hubPort, 'pod-a')
    podBCtx = await startPod(hubPort, 'pod-b')
    const header: SessionHeader = {
      version: 0,
      id: SessionId('sess-m4'),
      createdAt: 1,
      cwd: '/tmp/work',
    }
    const events = oneTurnLog()
    const persist = await podCtx.federationClient.persistSession(header.id, events, header)
    expect(persist).toEqual({ ok: true, lastSeq: events[events.length - 1]?.seq })
    expect(stored.get('sess-m4')?.events).toHaveLength(events.length)
    expect(JSON.stringify({
      type: 'session/persist',
      sessionId: header.id,
      header,
      events,
    })).not.toMatch(/token|Authorization|DEEPSEEK_API_KEY|apiKey|Bearer /i)

    const acquired = await podCtx.federationClient.leaseSession('session/lease-acquire', header.id)
    expect(acquired).toEqual({ ok: true, holder: 'pod-a' })
    const blocked = await podBCtx.federationClient.leaseSession('session/lease-acquire', header.id)
    expect(blocked).toMatchObject({ ok: false, code: 'stale-writer' })
    const persistBlocked = await podBCtx.federationClient.persistSession(header.id, events, header)
    expect(persistBlocked).toMatchObject({ ok: false, code: 'stale-writer' })
    hubService!.setPodStatus('pod-a', 'offline')
    const taken = await podBCtx.federationClient.leaseSession('session/lease-acquire', header.id)
    expect(taken).toEqual({ ok: true, holder: 'pod-b' })
  })

  it('forks a hub session to local persistence with identical derived messages', async () => {
    const hubPort = await startHub()
    const header: SessionHeader = {
      version: 0,
      id: SessionId('sess-fork-m4'),
      createdAt: 1,
      cwd: '/tmp/work',
    }
    stored.set('sess-fork-m4', { meta: header, events: oneTurnLog() })
    podCtx = new Context()
    await podCtx.plugin(SessionStore)
    await podCtx.plugin(SessionSourcePlugin)
    const created: SessionHeader[] = []
    const appended: SessionEvent[][] = []
    podCtx.provide('sessionPersistence', {
      create: async (meta: SessionHeader) => { created.push(meta) },
      append: async (_id: SessionId, events: SessionEvent[]) => { appended.push([...events]) },
    })
    await podCtx.plugin(FederationSourcePlugin, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      token,
      sourceId: 'federation-hub',
      autoReconnect: false,
    })
    const remote = podCtx.sessionSources.getSource('federation-hub') as FederationSessionSource
    await vi.waitFor(() => {
      expect(remote.online).toBe(true)
    })
    const forkedId = await remote.forkSession(header.id, '/tmp/forked')
    expect(created[0]?.parentSession).toBe(header.id)
    expect(created[0]?.cwd).toBe('/tmp/forked')
    expect(appended[0]).toHaveLength(oneTurnLog().length)
    const copied = appended[0]
    expect(copied).toBeDefined()
    if (copied === undefined) return
    const hub = Session.create(header.id, oneTurnLog())
    const local = Session.create(forkedId, copied)
    expect(local.deriveMessages()).toEqual(hub.deriveMessages())
  })
})
