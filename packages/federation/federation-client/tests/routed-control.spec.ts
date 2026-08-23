import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import * as FederationClientPlugin from '../src/index.ts'
import { rawDataToString } from '../src/index.ts'

describe('routed session control wire', () => {
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

  async function mountClient(requestTimeoutMs = 10_000): Promise<Context['federationClient']> {
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
    return ctx.federationClient
  }

  it('round-trips a queue update', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/queue-update') {
        ws.send(JSON.stringify({
          type: 'session/queue-update-result',
          requestId: msg.requestId,
          accepted: true,
        }))
      }
    })
    const client = await mountClient()
    const result = await client.queueUpdateSession(
      'sess-1' as never,
      'm1',
      { kind: 'remove' },
    )
    expect(result).toEqual({ ok: true, accepted: true })
    const request = sent.find(m => m.type === 'session/queue-update')
    expect(request).toMatchObject({ sessionId: 'sess-1', itemId: 'm1', action: { kind: 'remove' } })
  })

  it('maps queue-update failure codes and messages', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/queue-update') {
        ws.send(JSON.stringify({
          type: 'session/queue-update-result',
          requestId: msg.requestId,
          code: 'writer-offline',
          error: 'no writer for that session',
        }))
      }
    })
    const client = await mountClient()
    const result = await client.queueUpdateSession('sess-1' as never, 'm1', { kind: 'remove' })
    expect(result).toEqual({ ok: false, code: 'writer-offline', message: 'no writer for that session' })
  })

  it('round-trips a cancellation', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/cancel') {
        ws.send(JSON.stringify({
          type: 'session/cancel-result',
          requestId: msg.requestId,
          accepted: true,
        }))
      }
    })
    const client = await mountClient()
    const result = await client.cancelSession('sess-1' as never)
    expect(result).toEqual({ ok: true, accepted: true })
    expect(sent.find(m => m.type === 'session/cancel')).toMatchObject({ sessionId: 'sess-1' })
  })

  it('round-trips a model selection', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/select-model') {
        ws.send(JSON.stringify({
          type: 'session/select-model-result',
          requestId: msg.requestId,
          selected: msg.selection,
        }))
      }
    })
    const client = await mountClient()
    const selection = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }
    const result = await client.selectModelSession('sess-1' as never, selection)
    expect(result).toEqual({ ok: true, selected: selection })
    expect(sent.find(m => m.type === 'session/select-model')).toMatchObject({ sessionId: 'sess-1', selection })
  })

  it('resolves control RPCs with disconnected when the link is down', async () => {
    await startHub()
    const client = await mountClient()
    await ctx!.fiber.dispose()
    ctx = undefined
    await expect(client.queueUpdateSession('sess-1' as never, 'm1', { kind: 'remove' })).resolves.toMatchObject({ ok: false, code: 'disconnected' })
    await expect(client.cancelSession('sess-1' as never)).resolves.toMatchObject({ ok: false, code: 'disconnected' })
    await expect(client.selectModelSession('sess-1' as never, { provider: 'p', model: 'm' })).resolves.toMatchObject({ ok: false, code: 'disconnected' })
  })

  it('times out control RPCs when the hub stays silent', async () => {
    await startHub()
    const client = await mountClient(50)
    await expect(client.cancelSession('sess-1' as never)).resolves.toMatchObject({ ok: false, code: 'timeout' })
    await expect(client.selectModelSession('sess-1' as never, { provider: 'p', model: 'm' })).resolves.toMatchObject({ ok: false, code: 'timeout' })
    await expect(client.queueUpdateSession('sess-1' as never, 'm1', { kind: 'remove' })).resolves.toMatchObject({ ok: false, code: 'timeout' })
  })

  it('fails pending control RPCs with structured disconnects when the socket drops mid-flight', async () => {
    await startHub()
    const client = await mountClient(10_000)
    const pending = client.cancelSession('sess-1' as never)
    await vi.waitFor(() => {
      expect(hubSocket).toBeDefined()
    })
    hubSocket?.terminate()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'disconnected' })
  })
})
