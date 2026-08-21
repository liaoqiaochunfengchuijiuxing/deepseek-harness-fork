/**
 * Federation Hub server: WebSocket server lifecycle, token authentication,
 * pod connection handling, subagent server endpoint, and heartbeat reaper.
 *
 * @module @deepseek-ai/dsh-federation-hub/server
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import type { FederationHubService } from './service.ts'
import type {
  FederationTokenRole,
  FederationWireMessage,
} from './types.ts'

/** Token configuration entry. */
export interface TokenConfig {
  /** Permission level granted by this token. */
  role: FederationTokenRole
  /** Optional restriction to a specific pod identifier. */
  podId?: string
}

/** Configuration for FederationHubServer. */
export interface FederationHubConfig {
  /** Listen port (0 for auto/test, default 3080). */
  port?: number
  /** Listen host (default '127.0.0.1'). */
  host?: string
  /** WebSocket path for pod connections (default '/federation/connect'). */
  path?: string
  /** WebSocket path for incoming subagent delegations (default '/federation/subagent'). */
  subagentPath?: string
  /** Heartbeat timeout in milliseconds before marking a pod offline (default 30000). */
  heartbeatTimeoutMs?: number
  /** Configured static tokens and their permission roles. */
  tokens?: Record<string, TokenConfig>
  /** Whether to allow anonymous unauthenticated connections (default false). */
  allowAnonymous?: boolean
  /** Single admin / default token for convenience. */
  token?: string
}

/**
 * Convert raw WebSocket data to string safely.
 * @param data - Raw data buffer from WebSocket.
 * @returns UTF-8 decoded string.
 */
export function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Server instance managing the WebSocket server and connection lifecycle.
 */
export class FederationHubServer {
  private server: http.Server | undefined
  private wss: WebSocketServer | undefined
  private port = 0
  private reaperTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly service: FederationHubService,
    private readonly config: FederationHubConfig,
  ) {}

  /**
   * Get the listening port.
   * @returns Assigned listening port number.
   */
  getPort(): number {
    return this.port
  }

  /**
   * Start the HTTP and WebSocket server.
   */
  async start(): Promise<void> {
    const port = this.config.port ?? 3080
    const host = this.config.host ?? '127.0.0.1'
    const connectPath = this.config.path ?? '/federation/connect'
    const subagentPath = this.config.subagentPath ?? '/federation/subagent'

    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })

    const wss = new WebSocketServer({ noServer: true })
    this.server = server
    this.wss = wss

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const pathname = url.pathname

      if (pathname !== connectPath && pathname !== subagentPath) {
        socket.destroy()
        return
      }

      const authRole = this.authenticateRequest(req, url)
      if (authRole === null) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        if (pathname === connectPath) {
          this.handlePodConnection(ws, authRole)
        } else if (pathname === subagentPath) {
          this.handleSubagentConnection(ws, authRole)
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        this.port = (server.address() as AddressInfo).port
        resolve()
      })
    })

    const timeout = this.config.heartbeatTimeoutMs ?? 30000
    const checkInterval = Math.max(1000, Math.min(5000, Math.floor(timeout / 2)))

    this.reaperTimer = setInterval(() => {
      const now = Date.now()
      for (const pod of this.service.listPods()) {
        if (pod.status === 'online' && now - pod.lastHeartbeat > timeout) {
          this.service.setPodStatus(pod.podId, 'offline')
        }
      }
    }, checkInterval)
  }

  /**
   * Stop the server and clean up resources.
   */
  async stop(): Promise<void> {
    if (this.reaperTimer !== undefined) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = undefined
    }

    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.terminate()
        } catch {
          // ignore client termination error
        }
      }
      await new Promise<void>((resolve) => {
        this.wss?.close(() => { resolve() })
      })
      this.wss = undefined
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => { resolve() })
      })
      this.server = undefined
    }
  }

  private authenticateRequest(req: http.IncomingMessage, url: URL): FederationTokenRole | null {
    if (this.config.allowAnonymous) {
      return 'takeover'
    }

    let token: string | undefined

    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim()
    } else {
      token = url.searchParams.get('token') ?? undefined
    }

    if (!token) return null

    if (this.config.token && token === this.config.token) {
      return 'takeover'
    }

    const tokens = this.config.tokens
    if (tokens && tokens[token]) {
      const entry = tokens[token]
      if (entry) return entry.role
    }

    return null
  }

  private handlePodConnection(socket: WebSocket, role: FederationTokenRole): void {
    let podId: string | undefined

    socket.on('message', (data: WebSocket.RawData) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(rawDataToString(data))
      } catch {
        return
      }

      if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return
      const msg = parsed as FederationWireMessage

      if (msg.type === 'federation/register') {
        podId = msg.podId
        this.service.registerPod(
          msg.podId,
          msg.name,
          msg.capabilities ?? {},
          role,
          socket,
        )

        socket.send(JSON.stringify({
          type: 'federation/registered',
          podId: msg.podId,
          hubVersion: '0.1.0',
        }))
        return
      }

      if (podId !== undefined) {
        this.service.handlePodMessage(podId, msg)
      }
    })

    socket.on('close', () => {
      if (podId !== undefined) {
        this.service.markSocketClosed(podId, socket)
      }
    })

    socket.on('error', () => {
      socket.terminate()
    })
  }

  private handleSubagentConnection(socket: WebSocket, _role: FederationTokenRole): void {
    let inFlightRunId: string | undefined
    let targetPodId: string | undefined

    socket.on('message', (data: WebSocket.RawData) => {
      void (async () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(rawDataToString(data))
        } catch {
          return
        }

        if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return
        const msg = parsed as FederationWireMessage

        if (msg.type === 'subagent/start') {
          inFlightRunId = msg.id
          const addressed = typeof msg.targetPodId === 'string' && msg.targetPodId.length > 0
            ? msg.targetPodId
            : undefined
          const firstOnline = this.service.listPods().find(pod => pod.status === 'online')?.podId
          targetPodId = addressed ?? firstOnline
          if (targetPodId === undefined) {
            this.replySubagentStop(socket, msg.id, 'Hub has no online pods available to handle subagent delegation')
            return
          }
          await this.relaySubagentStart(socket, targetPodId, msg)
          return
        }
        if (msg.type === 'subagent/abort') {
          if (targetPodId !== undefined && inFlightRunId !== undefined) {
            this.service.cancelPodDelegation(targetPodId, inFlightRunId, msg.reason)
          }
        }
      })()
    })

    socket.on('error', () => {
      socket.terminate()
    })
  }

  /**
   * Forward one subagent start to a named pod and stream chunk/stop back to the caller.
   * @param socket - caller WebSocket on `/federation/subagent`.
   * @param podId - online pod that should execute.
   * @param msg - start message from the caller.
   */
  private async relaySubagentStart(
    socket: WebSocket,
    podId: string,
    msg: Extract<FederationWireMessage, { type: 'subagent/start' }>,
  ): Promise<void> {
    try {
      const stopMsg = await this.service.delegateToPod(
        podId,
        msg,
        (delta) => {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({
              type: 'subagent/chunk',
              id: msg.id,
              delta,
            }))
          }
        },
      )
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(stopMsg))
      }
    } catch (err) {
      this.replySubagentStop(
        socket,
        msg.id,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /**
   * Send a terminal error stop to a subagent caller when relay cannot run.
   * @param socket - caller WebSocket.
   * @param id - run identifier.
   * @param diagnostic - failure text.
   */
  private replySubagentStop(socket: WebSocket, id: string, diagnostic: string): void {
    if (socket.readyState !== 1) return
    socket.send(JSON.stringify({
      type: 'subagent/stop',
      id,
      output: [],
      stopReason: 'error',
      diagnostic,
    }))
  }
}
