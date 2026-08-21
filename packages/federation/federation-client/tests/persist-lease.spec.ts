import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as FederationClientPlugin from '../src/index.ts'
import { rawDataToString } from '../src/index.ts'

describe('session persist and lease wire', () => {
  let ctx: Context | undefined
  let server: http.Server | undefined
  let wss: WebSocketServer | undefined
  let port: number
  let hubSocket: WebSocket | undefined
  const sent: Array<Record<string, unknown>> = []

  afterEach(async () => {
    hubSocket = undefined
    sent.length = 0
    wss?.clients.forEach((c) => {
      c.terminate()
    })
    wss?.close()
    if (server) {
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve()
        })
      })
      server = undefined
    }
    if (ctx) {
      await ctx.fiber.dispose()
      ctx = undefined
    }
  })

  async function startHub(handler?: (msg: Record<string, unknown>, ws: WebSocket) => void): Promise<void> {
    server = http.createServer()
    wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      hubSocket = ws
      ws.on('message', (data) => {
        const parsed = JSON.parse(rawDataToString(data)) as Record<string, unknown>
        sent.push(parsed)
        if (parsed.type === 'federation/register') {
          ws.send(JSON.stringify({
            type: 'federation/registered',
            podId: parsed.podId,
            role: 'command',
          }))
          return
        }
        handler?.(parsed, ws)
      })
    })
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        port = (server!.address() as AddressInfo).port
        resolve()
      })
    })
  }

  async function mountClient(requestTimeoutMs = 10_000): Promise<void> {
    ctx = new Context()
    await ctx.plugin(FederationClientPlugin, {
      endpoint: `ws://127.0.0.1:${port}`,
      podId: 'pod-cmd',
      name: 'Command Pod',
      requestTimeoutMs,
    })
    await vi.waitFor(() => {
      expect(ctx?.federationClient.getStatus()).toBe('connected')
    })
  }

  const header: SessionHeader = {
    version: 0,
    id: SessionId('sess-p'),
    createdAt: 1,
  }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  ]

  it('returns disconnected when persist or lease is called offline', async () => {
    ctx = new Context()
    const client = new FederationClientPlugin.FederationPodClient(ctx, {
      endpoint: 'ws://127.0.0.1:1',
      podId: 'pod-x',
      name: 'X',
    })
    expect(await client.persistSession(header.id, events, header)).toMatchObject({
      ok: false,
      code: 'disconnected',
    })
    expect(await client.leaseSession('session/lease-acquire', header.id)).toMatchObject({
      ok: false,
      code: 'disconnected',
    })
  })

  it('uploads events and acquires a lease over a live socket', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/persist') {
        ws.send(JSON.stringify({
          type: 'session/persist-result',
          requestId: msg.requestId,
          lastSeq: 0,
        }))
      }
      if (msg.type === 'session/lease-acquire' || msg.type === 'session/lease-release') {
        ws.send(JSON.stringify({
          type: 'session/lease-result',
          requestId: msg.requestId,
          holder: 'pod-cmd',
        }))
      }
    })
    await mountClient()
    const persist = await ctx!.federationClient.persistSession(header.id, events, header)
    expect(persist).toEqual({ ok: true, lastSeq: 0 })
    const persistWire = sent.find(m => m.type === 'session/persist')
    expect(persistWire).toMatchObject({ sessionId: header.id, header })
    expect(JSON.stringify(persistWire)).not.toMatch(/token|Authorization|DEEPSEEK_API_KEY|apiKey/i)
    const acquired = await ctx!.federationClient.leaseSession('session/lease-acquire', header.id)
    expect(acquired).toEqual({ ok: true, holder: 'pod-cmd' })
    const released = await ctx!.federationClient.leaseSession('session/lease-release', header.id)
    expect(released).toEqual({ ok: true, holder: 'pod-cmd' })
  })

  it('maps persist and lease failures including unknown codes', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/persist') {
        const requestId = String(msg.requestId)
        if ((msg.events as SessionEvent[])[0]?.seq === 1) {
          ws.send(JSON.stringify({ type: 'session/persist-result', requestId, error: 'broken' }))
          return
        }
        if ((msg.events as SessionEvent[])[0]?.seq === 2) {
          ws.send(JSON.stringify({ type: 'session/persist-result', requestId, code: 'unavailable' }))
          return
        }
        ws.send(JSON.stringify({
          type: 'session/persist-result',
          requestId,
          code: 'stale-writer',
          error: 'leased',
        }))
      }
      if (msg.type === 'session/lease-acquire') {
        if (msg.sessionId === 'sess-default') {
          ws.send(JSON.stringify({
            type: 'session/lease-result',
            requestId: msg.requestId,
            code: 'stale-writer',
          }))
          return
        }
        ws.send(JSON.stringify({
          type: 'session/lease-result',
          requestId: msg.requestId,
          code: 'unauthorized',
          error: 'nope',
        }))
      }
      if (msg.type === 'session/lease-release') {
        ws.send(JSON.stringify({
          type: 'session/lease-result',
          requestId: msg.requestId,
          error: 'broken lease',
        }))
      }
    })
    await mountClient()
    expect(await ctx!.federationClient.persistSession(header.id, events)).toMatchObject({
      ok: false,
      code: 'stale-writer',
    })
    expect(await ctx!.federationClient.persistSession(header.id, [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    ])).toMatchObject({ ok: false, code: 'invalid', message: 'broken' })
    expect(await ctx!.federationClient.leaseSession('session/lease-acquire', header.id)).toMatchObject({
      ok: false,
      code: 'unauthorized',
    })
    expect(await ctx!.federationClient.leaseSession('session/lease-release', header.id)).toMatchObject({
      ok: false,
      code: 'invalid',
      message: 'broken lease',
    })
    expect(await ctx!.federationClient.persistSession(header.id, [
      { type: 'turn/start', seq: 2, time: 1, data: { turn: 1 } },
    ])).toMatchObject({ ok: false, code: 'unavailable', message: 'session persist failed' })
    expect(await ctx!.federationClient.leaseSession('session/lease-acquire', SessionId('sess-default'))).toMatchObject({
      ok: false,
      code: 'stale-writer',
      message: 'session lease failed',
    })
    hubSocket?.send(JSON.stringify({
      type: 'session/persist-result',
      requestId: 'unknown-p',
      lastSeq: 3,
    }))
    hubSocket?.send(JSON.stringify({
      type: 'session/lease-result',
      requestId: 'unknown-l',
      holder: 'pod-cmd',
    }))
  })

  it('times out persist and lease with no reply', async () => {
    await startHub()
    await mountClient(40)
    expect(await ctx!.federationClient.persistSession(header.id, events)).toMatchObject({
      ok: false,
      code: 'timeout',
    })
    expect(await ctx!.federationClient.leaseSession('session/lease-acquire', header.id)).toMatchObject({
      ok: false,
      code: 'timeout',
    })
  })

  it('rejects in-flight persist and lease when the socket closes', async () => {
    await startHub()
    await mountClient(5_000)
    const persist = ctx!.federationClient.persistSession(header.id, events, header)
    const lease = ctx!.federationClient.leaseSession('session/lease-acquire', header.id)
    hubSocket?.close()
    await expect(persist).resolves.toMatchObject({ ok: false, code: 'disconnected' })
    await expect(lease).resolves.toMatchObject({ ok: false, code: 'disconnected' })
  })
})
