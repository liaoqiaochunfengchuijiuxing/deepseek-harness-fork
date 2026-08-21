import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import {
  FederationPodClient,
  isApprovalOutcome,
  isCwdPermitted,
  rawDataToString,
  type FederationClientConfig,
  type FederationClientWireMessage,
  type RemoteSubagentStartPayload,
  type RemoteSubagentStopPayload,
} from '../src/index.ts'

describe('dsh-federation-client', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  describe('helpers', () => {
    it('isCwdPermitted correctly checks workspace boundaries', () => {
      expect(isCwdPermitted(undefined, ['/workspace'])).toBe(true)
      expect(isCwdPermitted('/workspace', undefined)).toBe(true)
      expect(isCwdPermitted('/workspace', [])).toBe(true)
      expect(isCwdPermitted('/workspace', ['/workspace'])).toBe(true)
      expect(isCwdPermitted('/workspace/sub', ['/workspace'])).toBe(true)
      expect(isCwdPermitted('/other/dir', ['/workspace'])).toBe(false)
      expect(isCwdPermitted('/workspace-other', ['/workspace'])).toBe(false)
    })

    it('rawDataToString converts various buffer types', () => {
      expect(rawDataToString('test' as unknown as WebSocket.RawData)).toBe('test')
      expect(rawDataToString(Buffer.from('test'))).toBe('test')
      expect(rawDataToString([Buffer.from('te'), Buffer.from('st')])).toBe('test')
      expect(rawDataToString(new Uint8Array(Buffer.from('test')) as unknown as WebSocket.RawData)).toBe('test')
    })

    it('isApprovalOutcome accepts the closed vocabulary', () => {
      expect(isApprovalOutcome('allowed-once')).toBe(true)
      expect(isApprovalOutcome('nope')).toBe(false)
    })
  })

  describe('FederationPodClient Lifecycle', () => {
    let server: http.Server
    let wss: WebSocketServer
    let serverPort: number
    let receivedAuthHeader = ''
    let serverMessages: FederationClientWireMessage[] = []
    let clientSocket: WebSocket | undefined

    beforeEach(async () => {
      serverMessages = []
      receivedAuthHeader = ''
      server = http.createServer()
      wss = new WebSocketServer({ server })

      wss.on('connection', (ws, req) => {
        clientSocket = ws
        receivedAuthHeader = req.headers.authorization ?? ''

        ws.on('message', (data) => {
          const parsed = JSON.parse(rawDataToString(data)) as FederationClientWireMessage
          serverMessages.push(parsed)

          if (parsed.type === 'federation/register') {
            ws.send(
              JSON.stringify({
                type: 'federation/registered',
                podId: parsed.podId,
                role: parsed.role,
              }),
            )
          } else if (parsed.type === 'federation/heartbeat') {
            ws.send(
              JSON.stringify({
                type: 'federation/heartbeat-ack',
                timestamp: parsed.timestamp,
              }),
            )
          }
        })
      })

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          serverPort = (server.address() as AddressInfo).port
          resolve()
        })
      })
    })

    afterEach(async () => {
      wss.close()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    })

    it('connects, registers, and exchanges heartbeats', async () => {
      const client = new FederationPodClient(ctx, {
        endpoint: `ws://127.0.0.1:${serverPort}`,
        podId: 'pod-mac-1',
        name: 'MacBook Pro',
        token: 'secret-token-123',
        heartbeatIntervalMs: 50,
        workspaces: ['/Users/test/workspace'],
        tools: ['bash', 'fs'],
      })

      expect(client.getStatus()).toBe('disconnected')
      expect(client.getPodId()).toBe('pod-mac-1')
      expect(client.getActiveTaskCount()).toBe(0)

      client.start()

      // Wait for registration message
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'federation/register')).toBe(true)
      })

      expect(receivedAuthHeader).toBe('Bearer secret-token-123')
      expect(client.getStatus()).toBe('connected')

      const regMsg = serverMessages.find(m => m.type === 'federation/register')
      expect(regMsg).toBeDefined()
      if (regMsg?.type === 'federation/register') {
        expect(regMsg.podId).toBe('pod-mac-1')
        expect(regMsg.name).toBe('MacBook Pro')
        expect(regMsg.capabilities.workspaces).toEqual(['/Users/test/workspace'])
        expect(regMsg.capabilities.tools).toEqual(['bash', 'fs'])
      }

      // Wait for at least one heartbeat
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'federation/heartbeat')).toBe(true)
      })

      client.dispose()
      expect(client.getStatus()).toBe('disconnected')
    })

    it('handles subagent execution and chunk streaming', async () => {
      const client = new FederationPodClient(ctx, {
        endpoint: `ws://127.0.0.1:${serverPort}`,
        podId: 'pod-1',
        name: 'Pod 1',
        executor: async (req, onChunk, _signal) => {
          onChunk('chunk 1')
          onChunk('chunk 2')
          return {
            type: 'subagent/stop',
            id: req.id,
            output: [{ type: 'text', text: 'final output' }],
            stopReason: 'completed',
          }
        },
      })

      client.start()

      await vi.waitFor(() => {
        expect(client.getStatus()).toBe('connected')
        expect(clientSocket).toBeDefined()
      })

      const startMsg: RemoteSubagentStartPayload = {
        type: 'subagent/start',
        id: 'run-101',
        prompt: [{ type: 'text', text: 'summarize report' }],
      }

      clientSocket!.send(JSON.stringify(startMsg))

      await vi.waitFor(() => {
        const stopMsg = serverMessages.find(
          m => m.type === 'subagent/stop' && m.id === 'run-101',
        ) as RemoteSubagentStopPayload | undefined
        expect(stopMsg).toBeDefined()
        expect(stopMsg?.stopReason).toBe('completed')
        expect(stopMsg?.output[0]).toEqual({ type: 'text', text: 'final output' })
      })

      const chunks = serverMessages.filter(m => m.type === 'subagent/chunk' && m.id === 'run-101')
      expect(chunks).toHaveLength(2)

      client.dispose()
    })

    it('rejects tasks with working directory outside allowed workspaces', async () => {
      const client = new FederationPodClient(ctx, {
        endpoint: `ws://127.0.0.1:${serverPort}`,
        podId: 'pod-1',
        name: 'Pod 1',
        workspaces: ['/allowed/path'],
      })

      client.start()

      await vi.waitFor(() => {
        expect(client.getStatus()).toBe('connected')
        expect(clientSocket).toBeDefined()
      })

      const startMsg: RemoteSubagentStartPayload = {
        type: 'subagent/start',
        id: 'run-102',
        prompt: [{ type: 'text', text: 'forbidden directory task' }],
        cwd: '/etc/forbidden',
      }

      clientSocket!.send(JSON.stringify(startMsg))

      await vi.waitFor(() => {
        const stopMsg = serverMessages.find(
          m => m.type === 'subagent/stop' && m.id === 'run-102',
        ) as RemoteSubagentStopPayload | undefined
        expect(stopMsg).toBeDefined()
        expect(stopMsg?.stopReason).toBe('error')
        expect(stopMsg?.diagnostic).toContain('outside permitted pod workspaces')
      })

      client.dispose()
    })

    it('aborts running task when subagent/abort is received', async () => {
      let aborted = false
      const client = new FederationPodClient(ctx, {
        endpoint: `ws://127.0.0.1:${serverPort}`,
        podId: 'pod-1',
        name: 'Pod 1',
        executor: async (_req, _onChunk, signal) => {
          return new Promise<RemoteSubagentStopPayload>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true
              reject(new Error('aborted'))
            })
          })
        },
      })

      client.start()

      await vi.waitFor(() => {
        expect(client.getStatus()).toBe('connected')
        expect(clientSocket).toBeDefined()
      })

      const startMsg: RemoteSubagentStartPayload = {
        type: 'subagent/start',
        id: 'run-103',
        prompt: [{ type: 'text', text: 'long task' }],
      }

      clientSocket!.send(JSON.stringify(startMsg))

      await vi.waitFor(() => {
        expect(client.getActiveTaskCount()).toBe(1)
      })

      clientSocket!.send(
        JSON.stringify({
          type: 'subagent/abort',
          id: 'run-103',
          reason: 'user requested cancellation',
        }),
      )

      await vi.waitFor(() => {
        expect(aborted).toBe(true)
        expect(client.getActiveTaskCount()).toBe(0)
        const stopMsg = serverMessages.find(
          m => m.type === 'subagent/stop' && m.id === 'run-103',
        ) as RemoteSubagentStopPayload | undefined
        expect(stopMsg).toBeDefined()
        expect(stopMsg?.stopReason).toBe('aborted')
      })

      client.dispose()
    })

    it('reconnects after server closes socket and recovers registration', async () => {
      const client = new FederationPodClient(ctx, {
        endpoint: `ws://127.0.0.1:${serverPort}`,
        podId: 'pod-reconnect',
        name: 'Pod Reconnect',
        reconnectDelayMs: 50,
      })

      client.start()

      await vi.waitFor(() => {
        expect(client.getStatus()).toBe('connected')
        expect(clientSocket).toBeDefined()
      })

      // Simulate unexpected server-side socket close
      clientSocket!.close(1001, 'server restarting')

      await vi.waitFor(() => {
        expect(client.getStatus()).toBe('disconnected')
      })

      // Client should automatically reconnect
      await vi.waitFor(() => {
        expect(client.getStatus()).toBe('connected')
        const regCount = serverMessages.filter(
          m => m.type === 'federation/register' && m.podId === 'pod-reconnect',
        ).length
        expect(regCount).toBeGreaterThanOrEqual(2)
      })

      client.dispose()
    })

    it('exposes FederationClientService on Cordis context', async () => {
      const { apply } = await import('../src/index.ts')
      apply(ctx, {
        endpoint: `ws://127.0.0.1:${serverPort}`,
        podId: 'pod-service-test',
        name: 'Service Test Pod',
      })

      expect(ctx.federationClient).toBeDefined()
      expect(ctx.federationClient.getPodId()).toBe('pod-service-test')
      expect(ctx.federationClient.getActiveTaskCount()).toBe(0)
    })

    async function connectedClient(
      extra: Pick<FederationClientConfig, 'approvalAnswerer' | 'questionAnswerer'> = {},
    ): Promise<FederationPodClient> {
      const client = new FederationPodClient(ctx, {
        endpoint: `ws://127.0.0.1:${serverPort}`,
        podId: 'pod-interact',
        name: 'Interact Pod',
        ...extra,
      })
      client.start()
      await vi.waitFor(() => {
        expect(client.getStatus()).toBe('connected')
        expect(clientSocket).toBeDefined()
      })
      return client
    }

    it('answers approval/request through the configured answerer', async () => {
      const client = await connectedClient({
        approvalAnswerer: async (req) => {
          expect(req.toolName).toBe('bash')
          return 'allowed-once'
        },
      })
      clientSocket!.send(JSON.stringify({
        type: 'approval/request',
        requestId: 'ap-1',
        sessionId: 'sess-live',
        toolName: 'bash',
        callId: 'c1',
        reason: 'needs grant',
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'approval/result' && m.requestId === 'ap-1'
          && m.type === 'approval/result' && 'outcome' in m && m.outcome === 'allowed-once')).toBe(true)
      })
      client.dispose()
    })

    it('fails closed to unavailable without an approval answerer and normalizes rogue outcomes', async () => {
      const client = await connectedClient({
        approvalAnswerer: async () => 'yolo' as never,
      })
      clientSocket!.send(JSON.stringify({
        type: 'approval/request',
        requestId: 'ap-rogue',
        sessionId: 'sess-live',
        toolName: 'bash',
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'approval/result' && m.requestId === 'ap-rogue'
          && 'outcome' in m && m.outcome === 'unavailable')).toBe(true)
      })
      client.dispose()

      const fallback = await connectedClient()
      clientSocket!.send(JSON.stringify({
        type: 'approval/request',
        requestId: 'ap-none',
        sessionId: 'sess-live',
        toolName: 'bash',
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'approval/result' && m.requestId === 'ap-none'
          && 'outcome' in m && m.outcome === 'unavailable')).toBe(true)
      })
      fallback.dispose()
    })

    it('maps a throwing approval answerer to unavailable and a cancel to cancelled', async () => {
      let signal: AbortSignal | undefined
      const client = await connectedClient({
        approvalAnswerer: (_req, s) => new Promise<never>((_resolve, reject) => {
          signal = s
          s.addEventListener('abort', () => { reject(new Error('aborted')) })
        }),
      })
      clientSocket!.send(JSON.stringify({
        type: 'approval/request',
        requestId: 'ap-throw',
        sessionId: 'sess-live',
        toolName: 'bash',
      }))
      await vi.waitFor(() => {
        expect(signal).toBeDefined()
      })
      clientSocket!.send(JSON.stringify({ type: 'approval/cancel', requestId: 'ap-throw' }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'approval/result' && m.requestId === 'ap-throw'
          && 'outcome' in m && m.outcome === 'cancelled')).toBe(true)
      })
      client.dispose()

      const throwing = await connectedClient({
        approvalAnswerer: () => Promise.reject(new Error('boom')),
      })
      clientSocket!.send(JSON.stringify({
        type: 'approval/request',
        requestId: 'ap-boom',
        sessionId: 'sess-live',
        toolName: 'bash',
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'approval/result' && m.requestId === 'ap-boom'
          && 'outcome' in m && m.outcome === 'unavailable')).toBe(true)
      })
      throwing.dispose()
    })

    it('answers question/request through the configured answerer', async () => {
      const client = await connectedClient({
        questionAnswerer: async (req) => {
          expect(req.questions).toEqual([{ id: 'q1', question: 'Continue?' }])
          return { answers: [{ id: 'q1', selected: ['yes'] }] }
        },
      })
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-1',
        sessionId: 'sess-live',
        questions: [{ id: 'q1', question: 'Continue?' }],
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-1'
          && 'answers' in m && Array.isArray(m.answers))).toBe(true)
      })
      client.dispose()
    })

    it('fails closed on missing question answerer, empty answers, and thrown errors', async () => {
      const none = await connectedClient()
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-none',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-none'
          && 'error' in m && m.error?.code === 'UNAVAILABLE')).toBe(true)
      })
      none.dispose()

      const empty = await connectedClient({
        questionAnswerer: async () => ({ answers: [] }),
      })
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-empty',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-empty'
          && 'error' in m)).toBe(true)
      })
      empty.dispose()

      const boom = await connectedClient({
        questionAnswerer: () => Promise.reject(new Error('no ui')),
      })
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-boom',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-boom'
          && 'error' in m && m.error?.message === 'no ui')).toBe(true)
      })
      boom.dispose()
    })

    it('cancels an in-flight question and ignores cancel for unknown ids', async () => {
      let signal: AbortSignal | undefined
      const client = await connectedClient({
        questionAnswerer: (_req, s) => new Promise((_resolve, reject) => {
          signal = s
          s.addEventListener('abort', () => { reject(new Error('aborted')) })
        }),
      })
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-cancel',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(signal).toBeDefined()
      })
      clientSocket!.send(JSON.stringify({ type: 'question/cancel', requestId: 'unknown' }))
      clientSocket!.send(JSON.stringify({ type: 'approval/cancel', requestId: 'unknown-ap' }))
      clientSocket!.send(JSON.stringify({ type: 'question/cancel', requestId: 'q-cancel' }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-cancel'
          && 'error' in m && m.error?.code === 'ASK_ABORTED')).toBe(true)
      })
      client.dispose()
    })

    it('does not reply after dispose, and aborting on close drops in-flight interactions', async () => {
      let released: ((value: 'allowed-once') => void) | undefined
      const client = await connectedClient({
        approvalAnswerer: () => new Promise((resolve) => {
          released = resolve
        }),
      })
      clientSocket!.send(JSON.stringify({
        type: 'approval/request',
        requestId: 'ap-dispose',
        sessionId: 'sess-live',
        toolName: 'bash',
      }))
      await vi.waitFor(() => {
        expect(released).toBeDefined()
      })
      client.dispose()
      released?.('allowed-once')
      await new Promise(r => setTimeout(r, 20))
      expect(serverMessages.some(m => m.type === 'approval/result' && m.requestId === 'ap-dispose')).toBe(false)
    })

    it('claims federation/approval-request and federation/question-request waterfalls', async () => {
      ctx.on('federation/approval-request', (req) => {
        expect(req.requestId).toBe('ap-wf')
        return Promise.resolve('rejected' as const)
      })
      ctx.on('federation/question-request', (req) => {
        expect(req.requestId).toBe('q-wf')
        return Promise.resolve({ answers: [{ id: 'q', selected: ['wf'] }] })
      })
      const client = await connectedClient()
      clientSocket!.send(JSON.stringify({
        type: 'approval/request',
        requestId: 'ap-wf',
        sessionId: 'sess-live',
        toolName: 'bash',
      }))
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-wf',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'approval/result' && m.requestId === 'ap-wf'
          && 'outcome' in m && m.outcome === 'rejected')).toBe(true)
        expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-wf'
          && 'answers' in m)).toBe(true)
      })
      client.dispose()
    })

    it('ignores unknown wire types and drops a late question answer after cancel or dispose', async () => {
      const client = await connectedClient({
        questionAnswerer: (_req, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ answers: [{ id: 'q', selected: ['late'] }] })
          })
        }),
      })
      clientSocket!.send(JSON.stringify({ type: 'pong' }))
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-late',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'federation/register')).toBe(true)
      })
      clientSocket!.send(JSON.stringify({ type: 'question/cancel', requestId: 'q-late' }))
      await new Promise(r => setTimeout(r, 30))
      expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-late')).toBe(false)
      client.dispose()

      let resolveQ: ((value: { answers: Array<{ id: string; selected: string[] }> }) => void) | undefined
      const late = await connectedClient({
        questionAnswerer: () => new Promise((resolve) => {
          resolveQ = resolve
        }),
      })
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-disp-ok',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(resolveQ).toBeDefined()
      })
      late.dispose()
      resolveQ?.({ answers: [{ id: 'q', selected: ['too-late'] }] })
      await new Promise(r => setTimeout(r, 20))
      expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-disp-ok')).toBe(false)
    })

    it('does not send a question error after dispose, and cancels a returning approval', async () => {
      let releaseQ: ((err: Error) => void) | undefined
      const qClient = await connectedClient({
        questionAnswerer: () => new Promise((_resolve, reject) => {
          releaseQ = reject
        }),
      })
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-disp',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(releaseQ).toBeDefined()
      })
      qClient.dispose()
      releaseQ?.(new Error('late'))
      await new Promise(r => setTimeout(r, 20))
      expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-disp')).toBe(false)

      let signal: AbortSignal | undefined
      const apClient = await connectedClient({
        approvalAnswerer: (_req, s) => new Promise((resolve) => {
          signal = s
          s.addEventListener('abort', () => { resolve('allowed-once') })
        }),
      })
      clientSocket!.send(JSON.stringify({
        type: 'approval/request',
        requestId: 'ap-late',
        sessionId: 'sess-live',
        toolName: 'bash',
      }))
      await vi.waitFor(() => {
        expect(signal).toBeDefined()
      })
      clientSocket!.send(JSON.stringify({ type: 'approval/cancel', requestId: 'ap-late' }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'approval/result' && m.requestId === 'ap-late'
          && 'outcome' in m && m.outcome === 'cancelled')).toBe(true)
      })
      apClient.dispose()
    })

    it('maps a non-Error question answerer throw and a non-array answers field', async () => {
      const client = await connectedClient({
        questionAnswerer: async () => {
          throw 42
        },
      })
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-42',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-42'
          && 'error' in m && m.error?.message === '42')).toBe(true)
      })
      client.dispose()

      const bad = await connectedClient({
        questionAnswerer: async () => ({ answers: undefined as never }),
      })
      clientSocket!.send(JSON.stringify({
        type: 'question/request',
        requestId: 'q-undef',
        sessionId: 'sess-live',
        questions: [{ id: 'q', question: '?' }],
      }))
      await vi.waitFor(() => {
        expect(serverMessages.some(m => m.type === 'question/result' && m.requestId === 'q-undef'
          && 'error' in m)).toBe(true)
      })
      bad.dispose()
    })
  })
})
