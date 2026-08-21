import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import {
  FederationPodClient,
  rawDataToString,
  type FederationClientWireMessage,
} from '../src/index.ts'

describe('FederationPodClient Direct Transport (T5.3)', () => {
  let ctx: Context
  let hubServer: http.Server
  let hubWss: WebSocketServer
  let hubPort: number
  let hubMessages: FederationClientWireMessage[] = []
  let hubPodSocket: WebSocket | undefined

  beforeEach(async () => {
    ctx = new Context()
    hubMessages = []
    hubServer = http.createServer()
    hubWss = new WebSocketServer({ server: hubServer })

    hubWss.on('connection', (ws) => {
      hubPodSocket = ws
      ws.on('message', (data) => {
        const parsed = JSON.parse(rawDataToString(data)) as FederationClientWireMessage
        hubMessages.push(parsed)
        if (parsed.type === 'federation/register') {
          ws.send(JSON.stringify({
            type: 'federation/registered',
            podId: parsed.podId,
            role: parsed.role,
            peers: [
              { podId: 'pod-peer-1', directEndpoint: 'ws://127.0.0.1:9999', status: 'online' },
              { podId: 'pod-peer-offline', directEndpoint: 'ws://127.0.0.1:9998', status: 'offline' },
            ],
          }))
        }
      })
    })

    await new Promise<void>((resolve) => {
      hubServer.listen(0, '127.0.0.1', () => {
        hubPort = (hubServer.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    hubWss.close()
    hubServer.close()
    await ctx.fiber.dispose()
  })

  it('starts direct server, registers directEndpoint, and processes peer updates', async () => {
    const dummyServer = http.createServer()
    await new Promise<void>((resolve) => {
      dummyServer.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const directPort = (dummyServer.address() as AddressInfo).port
    await new Promise<void>((resolve) => {
      dummyServer.close(() => {
        resolve()
      })
    })

    const client = new FederationPodClient(ctx, {
      endpoint: `ws://127.0.0.1:${hubPort}`,
      podId: 'pod-1',
      name: 'Pod One',
      directPort,
      directEndpoint: `ws://127.0.0.1:${directPort}`,
    })

    client.start()
    await vi.waitFor(() => {
      expect(client.getStatus()).toBe('connected')
    })

    const registerMsg = hubMessages.find(m => m.type === 'federation/register')
    expect(registerMsg).toBeDefined()
    if (registerMsg && registerMsg.type === 'federation/register') {
      expect(registerMsg.directEndpoint).toBe(`ws://127.0.0.1:${directPort}`)
      expect(registerMsg.capabilities?.directEndpoint).toBe(`ws://127.0.0.1:${directPort}`)
    }

    const endpoints = client.getPeerDirectEndpoints()
    expect(endpoints.get('pod-peer-1')).toBe('ws://127.0.0.1:9999')
    expect(endpoints.has('pod-peer-offline')).toBe(false)

    hubPodSocket?.send(JSON.stringify({
      type: 'peer/update',
      podId: 'pod-peer-2',
      status: 'online',
      directEndpoint: 'ws://127.0.0.1:8888',
    }))

    await vi.waitFor(() => {
      expect(client.getPeerDirectEndpoints().get('pod-peer-2')).toBe('ws://127.0.0.1:8888')
    })

    hubPodSocket?.send(JSON.stringify({
      type: 'peer/update',
      podId: 'pod-peer-2',
      status: 'offline',
    }))

    await vi.waitFor(() => {
      expect(client.getPeerDirectEndpoints().has('pod-peer-2')).toBe(false)
    })

    client.dispose()
  })

  it('receives direct peer connections and handles direct capability requests', async () => {
    const dummyServer = http.createServer()
    await new Promise<void>((resolve) => {
      dummyServer.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const directPort = (dummyServer.address() as AddressInfo).port
    await new Promise<void>((resolve) => {
      dummyServer.close(() => {
        resolve()
      })
    })

    ctx.provide('fs')
    ctx.set('fs', {
      resolve: vi.fn().mockResolvedValue({ path: '/app/file.txt', exists: true }),
      readText: vi.fn().mockResolvedValue('direct fs text content'),
    } as never)

    const pod = new FederationPodClient(ctx, {
      endpoint: `ws://127.0.0.1:${hubPort}`,
      podId: 'pod-target',
      name: 'Target Pod',
      directPort,
      directEndpoint: `ws://127.0.0.1:${directPort}`,
    })

    pod.start()
    await vi.waitFor(() => {
      expect(pod.getStatus()).toBe('connected')
    })

    const peerWs = new WebSocket(`ws://127.0.0.1:${directPort}`)
    await new Promise<void>((resolve) => {
      peerWs.on('open', () => {
        resolve()
      })
    })

    peerWs.send(JSON.stringify({
      type: 'peer/handshake',
      podId: 'pod-source',
    }))

    const receivedDirectMessages: FederationClientWireMessage[] = []
    peerWs.on('message', (data) => {
      receivedDirectMessages.push(JSON.parse(rawDataToString(data)) as FederationClientWireMessage)
    })

    peerWs.send(JSON.stringify({
      type: 'capability/request',
      requestId: 'req-direct-1',
      seam: 'fs',
      method: 'readText',
      args: { target: { path: '/app/file.txt' } },
    }))

    await vi.waitFor(() => {
      expect(receivedDirectMessages.length).toBeGreaterThan(0)
    })

    const resultMsg = receivedDirectMessages.find(m => m.type === 'capability/result')
    expect(resultMsg).toBeDefined()
    if (resultMsg && resultMsg.type === 'capability/result') {
      expect(resultMsg.ok).toBe(true)
      expect(resultMsg.value).toBe('direct fs text content')
    }

    peerWs.close()
    pod.dispose()
  })

  it('performs direct rpcCapability when peer endpoint is available and falls back to hub if failed', async () => {
    const peerDirectServer = http.createServer()
    const peerDirectWss = new WebSocketServer({ server: peerDirectServer })
    let peerPort = 0

    peerDirectWss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(rawDataToString(data)) as FederationClientWireMessage
        if (parsed.type === 'capability/request') {
          ws.send(JSON.stringify({
            type: 'capability/result',
            requestId: parsed.requestId,
            ok: true,
            value: { direct: true, echoedMethod: parsed.method },
          }))
        }
      })
    })

    await new Promise<void>((resolve) => {
      peerDirectServer.listen(0, '127.0.0.1', () => {
        peerPort = (peerDirectServer.address() as AddressInfo).port
        resolve()
      })
    })

    const client = new FederationPodClient(ctx, {
      endpoint: `ws://127.0.0.1:${hubPort}`,
      podId: 'pod-caller',
      name: 'Caller Pod',
      peerDirectEndpoints: {
        'pod-peer-direct': `ws://127.0.0.1:${peerPort}`,
      },
    })

    client.start()
    await vi.waitFor(() => {
      expect(client.getStatus()).toBe('connected')
    })

    const result = await client.rpcCapability({
      requestId: 'rpc-1',
      seam: 'fs',
      method: 'stat',
      args: { target: { path: '/tmp' } },
      targetPodId: 'pod-peer-direct',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ direct: true, echoedMethod: 'stat' })
    }
    expect(client.isDirectConnected('pod-peer-direct')).toBe(true)

    peerDirectWss.close()
    peerDirectServer.close()
    client.dispose()
  })

  it('transparently falls back to hub relay if direct endpoint fails connection', async () => {
    const client = new FederationPodClient(ctx, {
      endpoint: `ws://127.0.0.1:${hubPort}`,
      podId: 'pod-caller',
      name: 'Caller Pod',
      peerDirectEndpoints: {
        'pod-unreachable': 'ws://127.0.0.1:59999',
      },
    })

    client.start()
    await vi.waitFor(() => {
      expect(client.getStatus()).toBe('connected')
    })

    hubPodSocket?.on('message', (data) => {
      const parsed = JSON.parse(rawDataToString(data)) as FederationClientWireMessage
      if (parsed.type === 'capability/request' && parsed.requestId === 'rpc-fallback') {
        hubPodSocket?.send(JSON.stringify({
          type: 'capability/result',
          requestId: 'rpc-fallback',
          ok: true,
          value: { relayedViaHub: true },
        }))
      }
    })

    const result = await client.rpcCapability({
      requestId: 'rpc-fallback',
      seam: 'subprocess',
      method: 'resolveExecutable',
      args: { command: 'node' },
      targetPodId: 'pod-unreachable',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ relayedViaHub: true })
    }

    client.dispose()
  })

  it('cancels direct RPC via cancelCapabilityRpc', async () => {
    const peerDirectServer = http.createServer()
    const peerDirectWss = new WebSocketServer({ server: peerDirectServer })
    let peerPort = 0
    const peerReceivedMessages: FederationClientWireMessage[] = []

    peerDirectWss.on('connection', (ws) => {
      ws.on('message', (data) => {
        peerReceivedMessages.push(JSON.parse(rawDataToString(data)) as FederationClientWireMessage)
      })
    })

    await new Promise<void>((resolve) => {
      peerDirectServer.listen(0, '127.0.0.1', () => {
        peerPort = (peerDirectServer.address() as AddressInfo).port
        resolve()
      })
    })

    const client = new FederationPodClient(ctx, {
      endpoint: `ws://127.0.0.1:${hubPort}`,
      podId: 'pod-caller',
      name: 'Caller Pod',
      peerDirectEndpoints: {
        'pod-cancel-peer': `ws://127.0.0.1:${peerPort}`,
      },
    })

    client.start()
    await vi.waitFor(() => {
      expect(client.getStatus()).toBe('connected')
    })

    const promise = client.rpcCapability({
      requestId: 'rpc-cancel-1',
      seam: 'fs',
      method: 'readText',
      args: {},
      targetPodId: 'pod-cancel-peer',
    })

    await vi.waitFor(() => {
      expect(client.isDirectConnected('pod-cancel-peer')).toBe(true)
    })

    client.cancelCapabilityRpc('rpc-cancel-1')
    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('FS_ABORTED')
    }

    await vi.waitFor(() => {
      const cancelMsg = peerReceivedMessages.find(m => m.type === 'capability/cancel')
      expect(cancelMsg).toBeDefined()
    })

    peerDirectWss.close()
    peerDirectServer.close()
    client.dispose()
  })
})
