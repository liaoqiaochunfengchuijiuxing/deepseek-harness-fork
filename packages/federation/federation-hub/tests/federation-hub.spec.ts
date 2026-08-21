import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebSocket } from 'ws'
import {
  FederationHubService,
  FederationHubServer,
  rawDataToString,
  type FederationRegisteredMessage,
  type FederationHeartbeatAckMessage,
  type RemoteSubagentStartMessage,
  type RemoteSubagentChunkMessage,
  type RemoteSubagentStopMessage,
  type FederationWireMessage,
} from '../src/index.ts'

function createFakeSocket(): { socket: WebSocket; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const close = vi.fn()
  const terminate = vi.fn()
  const socket = {
    readyState: 1, // OPEN
    send,
    close,
    terminate,
  } as unknown as WebSocket
  return { socket, send }
}

describe('FederationHubService', () => {
  let ctx: Context
  let service: FederationHubService

  beforeEach(() => {
    ctx = new Context()
    service = new FederationHubService(ctx)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('registers and lists pods', () => {
    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', { workspaces: ['/tmp'] }, 'command', socket)

    const pods = service.listPods()
    expect(pods).toHaveLength(1)
    const [pod] = pods
    expect(pod).toBeDefined()
    expect(pod?.podId).toBe('pod-1')
    expect(pod?.name).toBe('Pod 1')
    expect(pod?.status).toBe('online')
    expect(pod?.role).toBe('command')

    const found = service.getPod('pod-1')
    expect(found?.podId).toBe('pod-1')
  })

  it('updates heartbeat timestamp and unregisters pod', () => {
    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'read', socket)

    const initialHb = service.getPod('pod-1')!.lastHeartbeat
    service.touchHeartbeat('pod-1')
    expect(service.getPod('pod-1')!.lastHeartbeat).toBeGreaterThanOrEqual(initialHb)

    service.unregisterPod('pod-1')
    expect(service.getPod('pod-1')).toBeUndefined()
    expect(service.listPods()).toHaveLength(0)
  })

  it('sets pod status to offline and cleans up active delegations', async () => {
    const { socket, send } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)

    const req: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'run-1',
      prompt: [{ type: 'text', text: 'hello' }],
    }

    const delegationPromise = service.delegateToPod('pod-1', req)
    expect(send).toHaveBeenCalled()

    service.setPodStatus('pod-1', 'offline')
    await expect(delegationPromise).rejects.toThrow(/went offline/)
  })

  it('handles delegation chunk, stop, and cancellation', async () => {
    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)

    const chunks: string[] = []
    const req: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'run-2',
      prompt: [{ type: 'text', text: 'do work' }],
    }

    const delegationPromise = service.delegateToPod('pod-1', req, (delta) => {
      chunks.push(delta)
    })

    service.handlePodMessage('pod-1', {
      type: 'subagent/chunk',
      id: 'run-2',
      delta: 'chunk 1',
    })

    const stopMsg: RemoteSubagentStopMessage = {
      type: 'subagent/stop',
      id: 'run-2',
      output: [{ type: 'text', text: 'completed result' }],
      stopReason: 'completed',
    }
    service.handlePodMessage('pod-1', stopMsg)

    const res = await delegationPromise
    expect(chunks).toEqual(['chunk 1'])
    expect(res.stopReason).toBe('completed')
    expect(res.output[0]).toEqual({ type: 'text', text: 'completed result' })
  })

  it('cancels pod delegation explicitly', async () => {
    const { socket } = createFakeSocket()
    service.registerPod('pod-1', 'Pod 1', {}, 'command', socket)

    const req: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'run-3',
      prompt: [{ type: 'text', text: 'work' }],
    }

    const delegationPromise = service.delegateToPod('pod-1', req)
    service.cancelPodDelegation('pod-1', 'run-3', 'user abort')

    const res = await delegationPromise
    expect(res.stopReason).toBe('aborted')
    expect(res.diagnostic).toBe('user abort')
  })
})

describe('FederationHubServer integration', () => {
  let ctx: Context
  let service: FederationHubService
  let server: FederationHubServer
  let port: number
  const secretToken = 'test-secret-token-123'

  beforeEach(async () => {
    ctx = new Context()
    service = new FederationHubService(ctx)
    server = new FederationHubServer(service, {
      port: 0,
      host: '127.0.0.1',
      token: secretToken,
      heartbeatTimeoutMs: 500,
    })
    await server.start()
    port = server.getPort()
  })

  afterEach(async () => {
    await server.stop()
    await ctx.fiber.dispose()
  })

  it('rejects connection without token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/federation/connect`)
    const errorPromise = new Promise<Error>((resolve) => {
      ws.on('error', (err) => { resolve(err) })
    })

    const err = await errorPromise
    expect(err.message).toMatch(/401|Unexpected server response/)
  })

  it('authenticates and registers a pod via WebSocket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/federation/connect?token=${secretToken}`)

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => { resolve() })
      ws.on('error', reject)
    })

    const regMsg = {
      type: 'federation/register',
      podId: 'pod-mac-1',
      name: 'Mac Pod',
      capabilities: { workspaces: ['/Users/test/workspace'] },
    }
    ws.send(JSON.stringify(regMsg))

    const ackPromise = new Promise<FederationRegisteredMessage>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
        if (msg.type === 'federation/registered') {
          resolve(msg)
        }
      })
    })

    const ack = await ackPromise
    expect(ack.type).toBe('federation/registered')
    expect(ack.podId).toBe('pod-mac-1')

    const registered = service.getPod('pod-mac-1')
    expect(registered).toBeDefined()
    expect(registered?.name).toBe('Mac Pod')
    expect(registered?.status).toBe('online')

    // Heartbeat
    ws.send(JSON.stringify({ type: 'federation/heartbeat', podId: 'pod-mac-1' }))
    const hbAckPromise = new Promise<FederationHeartbeatAckMessage>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
        if (msg.type === 'federation/heartbeat_ack') {
          resolve(msg)
        }
      })
    })

    const hbAck = await hbAckPromise
    expect(hbAck.type).toBe('federation/heartbeat_ack')

    ws.close()
  })

  it('marks pod offline when heartbeats stop', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/federation/connect?token=${secretToken}`)

    await new Promise<void>((resolve) => {
      ws.on('open', () => { resolve() })
    })

    ws.send(JSON.stringify({
      type: 'federation/register',
      podId: 'pod-mac-2',
      name: 'Mac Pod 2',
    }))

    await new Promise<void>((resolve) => {
      ws.on('message', () => { resolve() })
    })

    expect(service.getPod('pod-mac-2')?.status).toBe('online')

    // Wait for reaper to run past heartbeatTimeoutMs (500ms)
    await new Promise<void>((res) => { setTimeout(() => { res() }, 1200) })

    expect(service.getPod('pod-mac-2')?.status).toBe('offline')
    ws.close()
  })

  it('routes delegation between client and connected pod', async () => {
    // 1. Connect Pod
    const podWs = new WebSocket(`ws://127.0.0.1:${port}/federation/connect?token=${secretToken}`)
    await new Promise<void>((res) => { podWs.on('open', () => { res() }) })

    podWs.send(JSON.stringify({
      type: 'federation/register',
      podId: 'worker-pod-1',
      name: 'Worker Pod 1',
    }))

    await new Promise<void>((res) => { podWs.once('message', () => { res() }) })

    // Listen on Pod for incoming subagent/start
    podWs.on('message', (data) => {
      const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
      if (msg.type === 'subagent/start') {
        const chunk: RemoteSubagentChunkMessage = {
          type: 'subagent/chunk',
          id: msg.id,
          delta: 'Pod generated output chunk',
        }
        podWs.send(JSON.stringify(chunk))

        const stop: RemoteSubagentStopMessage = {
          type: 'subagent/stop',
          id: msg.id,
          output: [{ type: 'text', text: 'Final result from pod' }],
          stopReason: 'completed',
          usage: { totalTokens: 42 },
        }
        podWs.send(JSON.stringify(stop))
      }
    })

    // 2. Connect Client to /federation/subagent
    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/federation/subagent?token=${secretToken}`)
    await new Promise<void>((res) => { clientWs.on('open', () => { res() }) })

    const startMsg: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'delegation-run-1',
      prompt: [{ type: 'text', text: 'Solve problem' }],
      env: { FEDERATION_TARGET_POD: 'worker-pod-1' },
    }
    clientWs.send(JSON.stringify(startMsg))

    const receivedChunks: string[] = []
    const finalStop = await new Promise<RemoteSubagentStopMessage>((resolve) => {
      clientWs.on('message', (data) => {
        const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
        if (msg.type === 'subagent/chunk') {
          receivedChunks.push(msg.delta)
        } else if (msg.type === 'subagent/stop') {
          resolve(msg)
        }
      })
    })

    expect(receivedChunks).toContain('Pod generated output chunk')
    expect(finalStop.stopReason).toBe('completed')
    expect(finalStop.output[0]).toEqual({ type: 'text', text: 'Final result from pod' })
    expect(finalStop.usage?.totalTokens).toBe(42)

    podWs.close()
    clientWs.close()
  })

  it('answers error when no pods are available for delegation', async () => {
    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/federation/subagent?token=${secretToken}`)
    await new Promise<void>((res) => { clientWs.on('open', () => { res() }) })

    const startMsg: RemoteSubagentStartMessage = {
      type: 'subagent/start',
      id: 'delegation-run-no-pod',
      prompt: [{ type: 'text', text: 'Solve problem' }],
    }
    clientWs.send(JSON.stringify(startMsg))

    const stopMsg = await new Promise<RemoteSubagentStopMessage>((resolve) => {
      clientWs.on('message', (data) => {
        const msg = JSON.parse(rawDataToString(data)) as FederationWireMessage
        if (msg.type === 'subagent/stop') {
          resolve(msg)
        }
      })
    })

    expect(stopMsg.stopReason).toBe('error')
    expect(stopMsg.diagnostic).toMatch(/no online pods/)
    clientWs.close()
  })

  it('exposes read session operations (list, get, search, subscribe)', async () => {
    let streamCallback: ((event: { seq: number; type: string; content: string }) => void) | undefined
    const mockSources = {
      listAllSessions: vi.fn().mockResolvedValue([
        { id: 'session-123', title: 'Test Session', createdAt: 1000, sourceId: 'local', updatedAt: 1000 },
      ]),
      getSession: vi.fn().mockResolvedValue({
        sourceId: 'local',
        session: {
          header: { id: 'session-123', version: 0, createdAt: 1000 },
          events: [{ seq: 0, type: 'session/started' }],
        },
      }),
      searchAllSessions: vi.fn().mockResolvedValue([
        { id: 'session-123', title: 'Test Session', createdAt: 1000, sourceId: 'local', updatedAt: 1000 },
      ]),
      subscribeEvents: vi.fn().mockImplementation(
        (_sessionId: string, cb: (event: { seq: number; type: string; content: string }) => void) => {
          streamCallback = cb
          return () => { streamCallback = undefined }
        },
      ),
    }
    // Assign to ctx
    ctx.provide('sessionSources')
    ;(ctx as unknown as { sessionSources: unknown }).sessionSources = mockSources

    const podWs = new WebSocket(`ws://127.0.0.1:${port}/federation/connect?token=${secretToken}`)
    await new Promise<void>((res) => { podWs.on('open', () => { res() }) })

    // Register pod
    podWs.send(JSON.stringify({
      type: 'federation/register',
      podId: 'session-client-pod',
      name: 'Session Client Pod',
    }))

    await new Promise<void>((res) => {
      podWs.once('message', () => { res() })
    })

    // Test session/list
    podWs.send(JSON.stringify({
      type: 'session/list',
      requestId: 'req-list-1',
    }))

    const listResult = await new Promise<{
      type: string
      requestId: string
      sessions: Array<{ id: string }>
    }>((resolve) => {
      podWs.once('message', (data) => {
        resolve(JSON.parse(rawDataToString(data)) as {
          type: string
          requestId: string
          sessions: Array<{ id: string }>
        })
      })
    })

    expect(listResult.type).toBe('session/list-result')
    expect(listResult.requestId).toBe('req-list-1')
    expect(listResult.sessions).toHaveLength(1)
    expect(listResult.sessions[0]?.id).toBe('session-123')

    // Test session/get
    podWs.send(JSON.stringify({
      type: 'session/get',
      requestId: 'req-get-1',
      sessionId: 'session-123',
    }))

    const getResult = await new Promise<{
      type: string
      requestId: string
      session?: { header: { id: string } }
    }>((resolve) => {
      podWs.once('message', (data) => {
        resolve(JSON.parse(rawDataToString(data)) as {
          type: string
          requestId: string
          session?: { header: { id: string } }
        })
      })
    })

    expect(getResult.type).toBe('session/get-result')
    expect(getResult.requestId).toBe('req-get-1')
    expect(getResult.session?.header.id).toBe('session-123')

    // Test session/search
    podWs.send(JSON.stringify({
      type: 'session/search',
      requestId: 'req-search-1',
      query: 'Test',
    }))

    const searchResult = await new Promise<{
      type: string
      requestId: string
      sessions: Array<{ id: string }>
    }>((resolve) => {
      podWs.once('message', (data) => {
        resolve(JSON.parse(rawDataToString(data)) as {
          type: string
          requestId: string
          sessions: Array<{ id: string }>
        })
      })
    })

    expect(searchResult.type).toBe('session/search-result')
    expect(searchResult.requestId).toBe('req-search-1')
    expect(searchResult.sessions).toHaveLength(1)

    // Test session/subscribe & stream event
    podWs.send(JSON.stringify({
      type: 'session/subscribe',
      subscriptionId: 'sub-1',
      sessionId: 'session-123',
    }))

    // Wait a tick for subscribe handler to execute
    await new Promise(r => setTimeout(r, 50))
    expect(streamCallback).toBeDefined()

    // Trigger an event from the stream
    streamCallback!({ seq: 1, type: 'user/message', content: 'Hello' })

    const streamMsg = await new Promise<{
      type: string
      subscriptionId: string
      sessionId: string
      event: { type: string }
    }>((resolve) => {
      podWs.once('message', (data) => {
        resolve(JSON.parse(rawDataToString(data)) as {
          type: string
          subscriptionId: string
          sessionId: string
          event: { type: string }
        })
      })
    })

    expect(streamMsg.type).toBe('session/stream-event')
    expect(streamMsg.subscriptionId).toBe('sub-1')
    expect(streamMsg.sessionId).toBe('session-123')
    expect(streamMsg.event.type).toBe('user/message')

    // Test session/unsubscribe
    podWs.send(JSON.stringify({
      type: 'session/unsubscribe',
      subscriptionId: 'sub-1',
    }))
    await new Promise(r => setTimeout(r, 50))
    expect(streamCallback).toBeUndefined()

    podWs.close()
  })
})
