import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionSourcesService } from '@deepseek-ai/dsh-session-source'
import {
  FederationSessionSource,
  apply,
} from '../src/index.ts'

function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

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

          if (parsed.type === 'session/list') {
            ws.send(JSON.stringify({
              type: 'session/list-result',
              requestId: parsed.requestId,
              sessions: [
                { id: 'sess-remote-1', title: 'Remote Session 1', createdAt: 1000, updatedAt: 1000 },
              ],
            }))
          } else if (parsed.type === 'session/get') {
            ws.send(JSON.stringify({
              type: 'session/get-result',
              requestId: parsed.requestId,
              session: {
                header: { id: parsed.sessionId, version: 0, createdAt: 1000 },
                events: [{ seq: 0, type: 'session/started' }],
              },
            }))
          } else if (parsed.type === 'session/search') {
            ws.send(JSON.stringify({
              type: 'session/search-result',
              requestId: parsed.requestId,
              sessions: [
                { id: 'sess-remote-1', title: 'Remote Session 1', createdAt: 1000, updatedAt: 1000 },
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

    // Wait for connection
    await new Promise((r) => { setTimeout(r, 50) })
    expect(source.online).toBe(true)

    // Test listSessions
    const sessions = await source.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.id).toBe('sess-remote-1')
    expect(sessions[0]?.sourceId).toBe('hub-live')

    // Test getSession
    const inspection = await source.getSession('sess-remote-1' as SessionId)
    expect(inspection).toBeDefined()
    expect(inspection?.header.id).toBe('sess-remote-1')

    // Test searchSessions
    const searched = await source.searchSessions({ query: 'Remote' })
    expect(searched).toHaveLength(1)
    expect(searched[0]?.id).toBe('sess-remote-1')

    source.dispose()
    expect(source.online).toBe(false)
  })

  it('subscribes to live event stream and handles events and unsubscription', async () => {
    const source = new FederationSessionSource({
      endpoint: `ws://127.0.0.1:${port}`,
      sourceId: 'hub-live',
    })

    source.start()
    await new Promise((r) => { setTimeout(r, 50) })

    const receivedEvents: unknown[] = []
    const unsubscribe = await source.subscribeEvents(
      'sess-remote-1' as SessionId,
      (event) => {
        receivedEvents.push(event)
      },
    )

    await new Promise((r) => { setTimeout(r, 50) })
    expect(lastReceivedMessage?.type).toBe('session/subscribe')
    const subId = String(lastReceivedMessage?.subscriptionId)

    // Server sends stream event
    serverWs?.send(JSON.stringify({
      type: 'session/stream-event',
      subscriptionId: subId,
      sessionId: 'sess-remote-1',
      event: { seq: 1, type: 'user/message', content: 'Hi' },
    }))

    await new Promise((r) => { setTimeout(r, 50) })
    expect(receivedEvents).toHaveLength(1)
    expect((receivedEvents[0] as { seq: number }).seq).toBe(1)

    // Unsubscribe
    unsubscribe()
    await new Promise((r) => { setTimeout(r, 50) })
    expect(lastReceivedMessage?.type).toBe('session/unsubscribe')

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
})
