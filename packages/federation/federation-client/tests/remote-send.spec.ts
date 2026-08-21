import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as FederationClientPlugin from '../src/index.ts'
import {
  parseRemoteSend,
  REMOTE_SEND_USAGE,
  rawDataToString,
} from '../src/index.ts'

describe('parseRemoteSend', () => {
  it('splits the first token as session id and the rest as message text', () => {
    expect(parseRemoteSend('  sess-1  hello there  ')).toEqual({
      sessionId: 'sess-1',
      text: 'hello there',
    })
    expect(parseRemoteSend('')).toBeUndefined()
    expect(parseRemoteSend('only-id')).toBeUndefined()
    expect(parseRemoteSend('   ')).toBeUndefined()
  })
})

describe('/remote_send command and session send wire', () => {
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
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  }

  async function mountClient(requestTimeoutMs = 10_000): Promise<void> {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
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

  function stubLocalAgent(): Agent {
    if (ctx === undefined) throw new Error('context not mounted')
    const session = ctx.sessions.create(SessionId('local-cmd'))
    const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
    let status: AgentStatus = 'idle'
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox,
      ctx: new Context(),
      get status() { return status },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject(input) { inbox.append('next-step', input) },
      cancel() { status = 'idle' },
      runMaintenance: task => task(new AbortController().signal),
      whenIdle() { return Promise.resolve() },
    }
    ctx.agents.register(agent)
    return agent
  }

  it('sends through the live hub inbox and reports success', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/send') {
        ws.send(JSON.stringify({
          type: 'session/send-result',
          requestId: msg.requestId,
          messageId: 'msg-1',
        }))
      }
    })
    await mountClient()
    const agent = stubLocalAgent()
    const execution = await ctx!.commands.execute(
      agent,
      '/remote_send hub-session hello from pod',
      [],
      new AbortController().signal,
    )
    expect(execution?.result).toEqual({ kind: 'success', text: 'Sent to hub-session' })
    const sendMsg = sent.find(m => m.type === 'session/send')
    expect(sendMsg?.sessionId).toBe('hub-session')
    expect(sendMsg?.content).toEqual([{ type: 'text', text: 'hello from pod' }])
    expect(sendMsg?.clientMessageId).toBe(execution?.commandId)
  })

  it('returns usage, writer-offline, and disconnected failures', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/send') {
        ws.send(JSON.stringify({
          type: 'session/send-result',
          requestId: msg.requestId,
          code: 'writer-offline',
          error: 'writer is offline for session missing',
        }))
      }
    })
    await mountClient()
    const agent = stubLocalAgent()

    const usage = await ctx!.commands.execute(agent, '/remote_send', [], new AbortController().signal)
    expect(usage?.result).toEqual({ kind: 'error', text: REMOTE_SEND_USAGE })

    const offline = await ctx!.commands.execute(
      agent,
      '/remote_send missing hi',
      [],
      new AbortController().signal,
    )
    expect(offline?.result.kind).toBe('error')
    expect(offline?.result.text).toMatch(/writer is offline/)
  })

  it('returns disconnected when the hub connection is down', async () => {
    await startHub()
    await mountClient()
    const agent = stubLocalAgent()
    wss?.clients.forEach((c) => {
      c.terminate()
    })
    await vi.waitFor(() => {
      expect(ctx!.federationClient.getStatus()).toBe('disconnected')
    })
    const result = await ctx!.commands.execute(
      agent,
      '/remote_send hub-session hi',
      [],
      new AbortController().signal,
    )
    expect(result?.result).toEqual({
      kind: 'error',
      text: 'federation client is not connected',
    })
  })

  it('returns disconnected when the client is not connected', async () => {
    ctx = new Context()
    const result = await new FederationClientPlugin.FederationPodClient(ctx, {
      endpoint: 'ws://127.0.0.1:1',
      podId: 'pod-x',
      name: 'X',
    }).sendToSession(SessionId('s'), [{ type: 'text', text: 't' }], 'c1')
    expect(result).toEqual({
      ok: false,
      code: 'disconnected',
      message: 'federation client is not connected',
    })
  })

  it('times out a session send with no reply', async () => {
    await startHub()
    await mountClient(40)
    const result = await ctx!.federationClient.sendToSession(
      SessionId('hub-session'),
      [{ type: 'text', text: 'late' }],
      'c-timeout',
    )
    expect(result).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('maps unauthorized and malformed send results', async () => {
    await startHub((msg, ws) => {
      if (msg.type === 'session/send') {
        const requestId = String(msg.requestId)
        if (msg.clientMessageId === 'c-unauth') {
          ws.send(JSON.stringify({
            type: 'session/send-result',
            requestId,
            code: 'unauthorized',
            error: 'session send requires a command-capable token',
          }))
          return
        }
        ws.send(JSON.stringify({
          type: 'session/send-result',
          requestId,
          error: 'broken',
        }))
      }
    })
    await mountClient()
    const unauth = await ctx!.federationClient.sendToSession(
      SessionId('hub-session'),
      [{ type: 'text', text: 'x' }],
      'c-unauth',
    )
    expect(unauth).toMatchObject({ ok: false, code: 'unauthorized' })
    const malformed = await ctx!.federationClient.sendToSession(
      SessionId('hub-session'),
      [{ type: 'text', text: 'x' }],
      'c-malformed',
    )
    expect(malformed).toMatchObject({ ok: false, code: 'invalid', message: 'broken' })
    hubSocket?.send(JSON.stringify({
      type: 'session/send-result',
      requestId: 'unknown-req',
      messageId: 'ignored',
    }))
  })

  it('rejects in-flight sends when the socket closes', async () => {
    await startHub()
    await mountClient(5_000)
    const pending = ctx!.federationClient.sendToSession(
      SessionId('hub-session'),
      [{ type: 'text', text: 'in-flight' }],
      'c-close',
    )
    hubSocket?.close()
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'disconnected' })
  })
})
