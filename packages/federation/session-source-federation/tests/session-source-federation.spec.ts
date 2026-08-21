import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSourcesService } from '@deepseek-ai/dsh-session-source'
import { oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'
import {
  FederationSessionSource,
  SESSION_CONTINUITY_NOTICE,
  apply,
  assertForkCompatible,
  rawDataToString,
} from '../src/index.ts'

describe('FederationSessionSource', () => {
  let server: http.Server
  let wss: WebSocketServer
  let port: number
  let lastReceivedMessage: Record<string, unknown> | undefined
  let serverWs: WebSocket | undefined

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    wss = new WebSocketServer({ server })

    wss.on('connection', (ws) => {
      serverWs = ws
      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(rawDataToString(data)) as Record<string, unknown>
          lastReceivedMessage = parsed

          if (parsed.type === 'federation/register') {
            ws.send(JSON.stringify({
              type: 'federation/registered',
              podId: parsed.podId,
              hubVersion: '0.1.0',
            }))
          } else if (parsed.type === 'session/list') {
            if (parsed.cwd === '/hang') return
            ws.send(JSON.stringify({
              type: 'session/list-result',
              requestId: parsed.requestId,
              sessions: parsed.cwd === '/bad-sessions'
                ? 'nope'
                : [
                  {
                    id: 'sess-remote-1',
                    title: 'Remote Session 1',
                    createdAt: 1000,
                    updatedAt: 1000,
                    cwd: '/workspace/app',
                  },
                  {
                    id: 'sess-no-title',
                    createdAt: 1000,
                    updatedAt: 1000,
                    cwd: '/workspace/app',
                  },
                ],
            }))
          } else if (parsed.type === 'session/get') {
            if (parsed.sessionId === 'hang') return
            ws.send(JSON.stringify({
              type: 'session/get-result',
              requestId: parsed.requestId,
              session: parsed.sessionId === 'sess-fork'
                ? {
                  header: { id: parsed.sessionId, version: 0, createdAt: 1000, cwd: '/workspace/app' },
                  events: oneTurnLog(),
                }
                : parsed.sessionId === 'sess-empty-fork'
                  ? {
                    header: { id: parsed.sessionId, version: 0, createdAt: 1000 },
                    events: [],
                  }
                  : parsed.sessionId === 'sess-missing'
                    ? undefined
                    : {
                      header: { id: parsed.sessionId, version: 0, createdAt: 1000 },
                      events: [{ seq: 0, type: 'session/started' }],
                    },
            }))
          } else if (parsed.type === 'session/persist') {
            ws.send(JSON.stringify({
              type: 'session/persist-result',
              requestId: parsed.requestId,
              ...parsed.sessionId === 'sess-fail-push'
                ? { error: 'rejected' }
                : parsed.sessionId === 'sess-silent-push'
                  ? {}
                  : { lastSeq: 5 },
            }))
          } else if (parsed.type === 'session/search') {
            if (parsed.query === 'hang') return
            ws.send(JSON.stringify({
              type: 'session/search-result',
              requestId: parsed.requestId,
              sessions: parsed.query === 'bad-sessions'
                ? 'nope'
                : [
                  {
                    id: 'sess-remote-1',
                    title: 'Remote Session 1',
                    createdAt: 1000,
                    updatedAt: 1000,
                    cwd: '/workspace/app',
                  },
                ],
            }))
          }
        } catch {
          // ignore
        }
      })
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    wss.clients.forEach((c) => {
      try {
        c.terminate()
      } catch {
        // ignore
      }
    })
    wss.close()
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
    })
  })

  it('reports degraded state when offline and queries cache', async () => {
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}/unused`,
      sourceId: 'test-hub',
      sourceName: 'Test Hub',
      autoReconnect: false,
    })

    expect(source.id).toBe('test-hub')
    expect(source.name).toBe('Test Hub')
    expect(source.kind).toBe('remote')
    expect(source.capabilities.canWrite).toBe(false)
    expect(source.capabilities.canFork).toBe(true)
    expect(source.capabilities.canSearch).toBe(true)
    expect(source.online).toBe(false)

    // listSessions returns empty degraded when never connected
    const list = await source.listSessions()
    expect(list).toEqual([])

    // searchSessions returns empty degraded when never connected
    const search = await source.searchSessions({ query: 'test' })
    expect(search).toEqual([])

    // getSession returns undefined when never connected
    const sess = await source.getSession('sess-1' as SessionId)
    expect(sess).toBeUndefined()

    source.dispose()
  })

  it('connects, lists sessions, inspects session, and searches sessions', async () => {
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      sourceId: 'hub-live',
      connectTimeoutMs: 1000,
    })

    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })

    // Test listSessions
    const sessions = await source.listSessions()
    expect(sessions.some(s => s.id === 'sess-remote-1')).toBe(true)
    expect(sessions.some(s => s.id === 'sess-no-title')).toBe(true)
    expect(sessions[0]?.sourceId).toBe('hub-live')
    expect(sessions[0]?.nodeKind).toBe('remote')

    // Test getSession
    const inspection = await source.getSession('sess-remote-1' as SessionId)
    expect(inspection).toBeDefined()
    expect(inspection?.header.id).toBe('sess-remote-1')

    // Test searchSessions
    const searched = await source.searchSessions({ query: 'Remote' })
    expect(searched).toHaveLength(1)
    expect(searched[0]?.id).toBe('sess-remote-1')
    expect(searched[0]?.nodeKind).toBe('remote')
    expect((await source.searchSessions({ cwd: '/workspace/app' }))[0]?.id).toBe('sess-remote-1')
    expect((await source.searchSessions({ query: 'Remote', limit: 1 }))[0]?.id).toBe('sess-remote-1')
    expect(await source.listSessions({ cwd: '/bad-sessions' })).toEqual([])
    expect(await source.searchSessions({ query: 'bad-sessions' })).toEqual([])

    source.dispose()
    expect(source.online).toBe(false)
  })

  it('subscribes to live event stream and handles events and unsubscription', async () => {
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      sourceId: 'hub-live',
    })

    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })

    const receivedEvents: unknown[] = []
    const unsubscribe = await source.subscribeEvents(
      'sess-remote-1' as SessionId,
      (event) => {
        receivedEvents.push(event)
      },
    )

    await vi.waitFor(() => {
      expect(lastReceivedMessage?.type).toBe('session/subscribe')
    })
    const subId = String(lastReceivedMessage?.subscriptionId)

    serverWs?.send(JSON.stringify({
      type: 'session/stream-event',
      subscriptionId: subId,
      sessionId: 'sess-remote-1',
      event: { seq: 1, type: 'user/message', content: 'Hi' },
    }))

    await vi.waitFor(() => {
      expect(receivedEvents).toHaveLength(1)
    })
    expect((receivedEvents[0] as { seq: number }).seq).toBe(1)

    unsubscribe()
    await vi.waitFor(() => {
      expect(lastReceivedMessage?.type).toBe('session/unsubscribe')
    })

    source.dispose()
  })

  it('registers in Cordis context via apply', async () => {
    const ctx = new Context()
    new SessionSourcesService(ctx)

    apply(ctx, {
      endpoint: `ws://127.0.0.1:${port}`,
      sourceId: 'cordis-hub',
    })

    const registeredSource = ctx.sessionSources.getSource('cordis-hub')
    expect(registeredSource).toBeDefined()
    expect(registeredSource?.id).toBe('cordis-hub')
    expect(registeredSource?.kind).toBe('remote')

    await ctx.fiber.dispose()
  })

  it('uses tokenEnv, ignores bad frames, times out hung requests, and degrades from cache', async () => {
    process.env.DSH_TEST_FED_TOKEN = 'env-token'
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      tokenEnv: 'DSH_TEST_FED_TOKEN',
      sourceId: 'hub-env',
      requestTimeoutMs: 40,
      reconnectDelayMs: 20,
    })
    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })

    await source.listSessions({ cwd: '/workspace/app', limit: 1 })
    const socket = (source as unknown as { ws?: WebSocket }).ws
    const originalSend = socket?.send.bind(socket)
    if (socket) {
      socket.send = () => {
        throw new Error('send failed')
      }
    }
    expect(await source.listSessions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ isDegraded: true })]),
    )
    if (socket && originalSend) {
      socket.send = originalSend
    }

    const unsubOffline = await source.subscribeEvents('sess-remote-1' as SessionId, () => {}, 1)

    serverWs?.send('{')
    serverWs?.send('5')
    serverWs?.send(JSON.stringify({ noType: true }))
    serverWs?.send(JSON.stringify({ type: 'unknown/type' }))
    serverWs?.send(JSON.stringify({ type: 'session/list-result', requestId: 1, sessions: 'nope' }))
    serverWs?.send(JSON.stringify({ type: 'session/get-result', requestId: 1 }))
    serverWs?.send(JSON.stringify({ type: 'session/search-result', requestId: 1, sessions: 'nope' }))
    serverWs?.send(JSON.stringify({ type: 'session/list-result', requestId: 'missing', sessions: [] }))
    serverWs?.send(JSON.stringify({ type: 'session/stream-event', subscriptionId: 1, event: { seq: 9 } }))
    serverWs?.send(JSON.stringify({ type: 'session/stream-event', subscriptionId: 'nope', event: { seq: 9 } }))
    serverWs?.send(JSON.stringify({ type: 'session/stream-event', subscriptionId: 'nope' }))

    const hungList = await source.listSessions({ cwd: '/hang' })
    expect(hungList.every(s => s.isDegraded)).toBe(true)

    expect(await source.getSession('hang' as SessionId)).toBeUndefined()
    const hungSearch = await source.searchSessions({ query: 'hang' })
    expect(hungSearch.every(s => s.isDegraded)).toBe(true)

    const inFlight = source.getSession('hang' as SessionId)
    unsubOffline()
    source.dispose()
    await inFlight
    expect(source.online).toBe(false)
    expect(await source.listSessions({ cwd: '/workspace/app', limit: 1 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'sess-remote-1', isDegraded: true })]),
    )
    expect(await source.listSessions({ cwd: '/missing', limit: 1 })).toEqual([])
    expect(await source.getSession('sess-remote-1' as SessionId)).toBeUndefined()
    expect(await source.searchSessions({ query: 'remote', cwd: '/workspace/app', limit: 1 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'sess-remote-1', isDegraded: true })]),
    )
    expect(await source.searchSessions({ query: 'sess-remote-1' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'sess-remote-1', isDegraded: true })]),
    )
    expect(await source.searchSessions({ query: 'nope', cwd: '/missing' })).toEqual([])
    delete process.env.DSH_TEST_FED_TOKEN
  })

  it('resubscribes after reconnect and clears a reconnect timer on dispose', async () => {
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      requestTimeoutMs: 200,
      reconnectDelayMs: 80,
    })
    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })

    await source.subscribeEvents('sess-remote-1' as SessionId, () => {}, 2)
    await source.subscribeEvents('sess-remote-1' as SessionId, () => {})

    lastReceivedMessage = undefined
    serverWs?.close()
    await vi.waitFor(() => {
      expect(source.online).toBe(false)
    })
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })
    await vi.waitFor(() => {
      expect(lastReceivedMessage?.type).toBe('session/subscribe')
    })

    ;(source as unknown as { ws?: WebSocket }).ws?.close()
    await new Promise(r => setTimeout(r, 5))
    source.dispose()
  })

  it('drops a stale open, skips reconnect when disabled, and fails send when the socket is not open', async () => {
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      autoReconnect: false,
    })
    source.start()
    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })

    const socket = (source as unknown as { ws?: WebSocket }).ws
    expect(socket).toBeDefined()
    let checks = 0
    Object.defineProperty(socket, 'readyState', {
      configurable: true,
      get: () => {
        checks += 1
        return checks === 1 ? 1 : 0
      },
    })
    expect(await source.listSessions()).toEqual([])

    const noReconnect = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      autoReconnect: false,
    })
    noReconnect.start()
    await vi.waitFor(() => {
      expect(noReconnect.online).toBe(true)
    })
    ;(noReconnect as unknown as { ws?: WebSocket }).ws?.close()
    await vi.waitFor(() => {
      expect(noReconnect.online).toBe(false)
    })
    const errSource = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      autoReconnect: false,
    })
    errSource.start()
    await vi.waitFor(() => {
      expect(errSource.online).toBe(true)
    })
    ;(errSource as unknown as { ws?: WebSocket }).ws?.emit('error', new Error('socket error'))
    await vi.waitFor(() => {
      expect(errSource.online).toBe(false)
    })
    errSource.dispose()
    noReconnect.dispose()
    source.dispose()
  })

  it('uses the default reconnect delay and skips a second reconnect while one is pending', async () => {
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
    })
    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })
    ;(source as unknown as { ws?: WebSocket }).ws?.close()
    await vi.waitFor(() => {
      expect(source.online).toBe(false)
    })
    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })
    ;(source as unknown as { ws?: WebSocket }).ws?.close()
    await new Promise(r => setTimeout(r, 5))
    source.dispose()
  })

  it('does not connect after dispose and ignores a thrown WebSocket constructor', () => {
    const source = new FederationSessionSource({
      endpoint: 'not-a-valid-url',
      autoReconnect: false,
    })
    source.dispose()
    source.start()
    expect(source.online).toBe(false)

    const exploding = new FederationSessionSource({
      endpoint: 'not-a-valid-url',
      token: 'x',
      autoReconnect: false,
    })
    exploding.start()
    expect(exploding.online).toBe(false)
    exploding.dispose()
  })

  it('decodes every WebSocket raw data form', () => {
    expect(rawDataToString('abc')).toBe('abc')
    expect(rawDataToString(Buffer.from('abc'))).toBe('abc')
    expect(rawDataToString([Buffer.from('a'), Buffer.from('bc')])).toBe('abc')
    expect(rawDataToString(new Uint8Array(Buffer.from('abc')).buffer as unknown as WebSocket.RawData)).toBe('abc')
  })

  it('subscribes while offline and searches the degraded cache without a query', async () => {
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}/unused`,
      autoReconnect: false,
    })
    const stop = await source.subscribeEvents('sess-offline' as SessionId, () => {}, 1)
    stop()
    expect(await source.searchSessions({})).toEqual([])
    source.dispose()
  })

  it('refuses unknown required event types on fork', () => {
    expect(() => {
      assertForkCompatible(
        [{ type: 'session/started', seq: 0, time: 1, data: {} }] as never,
        0,
      )
    }).toThrow(/unknown required event type/)
    expect(() => {
      assertForkCompatible(oneTurnLog(), 1)
    }).toThrow(/log format/)
    expect(() => {
      assertForkCompatible(
        [{ type: 'future/x', seq: 0, time: 1, data: {}, ignorable: true }] as never,
        0,
      )
    }).not.toThrow()
    expect(SESSION_CONTINUITY_NOTICE).toMatch(/not work continuity/)
  })

  it('forks a hub session into local persistence with matching derived messages', async () => {
    const created: unknown[] = []
    const appended: unknown[] = []
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', {
      create: async (header: unknown) => { created.push(header) },
      append: async (id: unknown, events: unknown) => { appended.push({ id, events }) },
      inspect: async () => ({ meta: { id: 'local-1', version: 0 }, events: oneTurnLog() }),
    })
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      autoReconnect: false,
    }, ctx)
    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })
    await expect(source.forkSession(SessionId('sess-missing'))).rejects.toThrow(/was not found/)
    await expect(source.forkSession(SessionId('sess-remote-1'))).rejects.toThrow(/unknown required event type/)
    const forkedId = await source.forkSession(SessionId('sess-fork'), '/workspace/forked')
    expect(created).toHaveLength(1)
    expect((created[0] as { cwd: string; parentSession: string }).cwd).toBe('/workspace/forked')
    expect((created[0] as { parentSession: string }).parentSession).toBe('sess-fork')
    expect(appended).toHaveLength(1)
    const hub = Session.create(SessionId('sess-fork'), oneTurnLog())
    const local = Session.create(forkedId, oneTurnLog())
    expect(local.deriveMessages()).toEqual(hub.deriveMessages())
    await source.forkSession(SessionId('sess-empty-fork'))
    source.dispose()
    await ctx.fiber.dispose()
  })

  it('pushes a local session to hub persistence and refuses missing persistence', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', {
      inspect: async (id: SessionId) => {
        if (String(id) === 'sess-fail-push') {
          return { meta: { id, version: 0, createdAt: 1 }, events: oneTurnLog() }
        }
        if (String(id) === 'sess-unknown') {
          return {
            meta: { id, version: 0, createdAt: 1 },
            events: [{ type: 'future/unknown', seq: 0, time: 1, data: {} }],
          }
        }
        if (String(id) === 'sess-silent-push') {
          return { meta: { id, version: 0, createdAt: 1 }, events: oneTurnLog() }
        }
        return { meta: { id, version: 0, createdAt: 1, cwd: '/tmp' }, events: oneTurnLog() }
      },
    })
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      autoReconnect: false,
    }, ctx)
    source.start()
    await vi.waitFor(() => {
      expect(source.online).toBe(true)
    })
    serverWs?.send(JSON.stringify({ type: 'session/persist-result', requestId: 1 }))
    serverWs?.send(JSON.stringify({ type: 'session/persist-result', requestId: 'nobody' }))
    await source.pushSession(SessionId('sess-ok'))
    await expect(source.pushSession(SessionId('sess-fail-push'))).rejects.toThrow(/rejected/)
    await expect(source.pushSession(SessionId('sess-unknown'))).rejects.toThrow(/unknown required event type/)
    await expect(source.pushSession(SessionId('sess-silent-push'))).rejects.toThrow(/session persist failed/)
    source.dispose()
    const bare = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      autoReconnect: false,
    })
    await expect(bare.forkSession(SessionId('sess-fork'))).rejects.toThrow(/SessionPersistence is not configured/)
    await expect(bare.pushSession(SessionId('sess-ok'))).rejects.toThrow(/SessionPersistence is not configured/)
    bare.dispose()
    await ctx.fiber.dispose()
  })
})
