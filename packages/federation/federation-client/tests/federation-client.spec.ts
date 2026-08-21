import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import {
  FederationPodClient,
  isCwdPermitted,
  rawDataToString,
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
  })
})
