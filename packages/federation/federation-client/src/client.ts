/**
 * Federation pod client: WebSocket client lifecycle, handshake registration,
 * heartbeat loops, reconnection with exponential backoff, capability filtering,
 * and delegated task dispatch.
 *
 * @module @deepseek-ai/dsh-federation-client/client
 */

import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  DelegatedTaskExecutor,
  FederationClientWireMessage,
  PodClientCapabilities,
  PodConnectionStatus,
  RemoteSubagentAbortPayload,
  RemoteSubagentChunkPayload,
  RemoteSubagentStartPayload,
  RemoteSubagentStopPayload,
  SessionSendResult,
} from './types.ts'

/** Configuration options for the federation pod client. */
export interface FederationClientConfig {
  /** WebSocket endpoint of the federation hub (e.g. `ws://hub.internal:3080/federation/connect`). */
  endpoint: string
  /** Unique identifier for this pod in the cluster. */
  podId: string
  /** Human-readable display name. */
  name: string
  /** Authentication Bearer token for connecting to the hub. */
  token?: string
  /** Environment variable name containing the authentication token. */
  tokenEnv?: string
  /** Heartbeat interval in milliseconds (default: 5000). */
  heartbeatIntervalMs?: number
  /** Initial reconnect delay in milliseconds (default: 2000). */
  reconnectDelayMs?: number
  /** Maximum reconnect delay in milliseconds (default: 30000). */
  maxReconnectDelayMs?: number
  /** Permitted workspace directories. Empty means ambient / unrestricted. */
  workspaces?: string[]
  /** Supported tool names. */
  tools?: string[]
  /** Supported sandbox modes. */
  sandboxModes?: string[]
  /** Declared role for this pod. */
  role?: 'read' | 'command' | 'manage' | 'takeover'
  /** Bound (ms) on a `session/send` round-trip. */
  requestTimeoutMs?: number
  /** Optional custom delegated task executor. */
  executor?: DelegatedTaskExecutor
}

interface ActiveTask {
  id: string
  abortController: AbortController
}

interface PendingSend {
  resolve: (result: SessionSendResult) => void
  timer: NodeJS.Timeout
}

/**
 * Safely converts WebSocket raw data into a string.
 * @param data - Raw data payload from WebSocket.
 * @returns Decoded UTF-8 string.
 */
export function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Validates if the requested working directory is allowed by the pod's declared workspaces.
 * @param requestedCwd - Requested working directory.
 * @param allowedWorkspaces - Permitted workspace prefixes.
 * @returns True if allowed, false otherwise.
 */
export function isCwdPermitted(
  requestedCwd: string | undefined,
  allowedWorkspaces: string[] | undefined,
): boolean {
  if (!allowedWorkspaces || allowedWorkspaces.length === 0) return true
  if (!requestedCwd) return true
  return allowedWorkspaces.some(ws => requestedCwd === ws || requestedCwd.startsWith(`${ws}/`))
}

/**
 * Client connection manager running on an edge pod.
 */
export class FederationPodClient {
  private socket: WebSocket | undefined
  private status: PodConnectionStatus = 'disconnected'
  private disposed = false
  private heartbeatTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private currentReconnectDelay: number
  private readonly inFlightTasks = new Map<string, ActiveTask>()
  private readonly pendingSends = new Map<string, PendingSend>()

  constructor(
    private readonly ctx: Context,
    private readonly config: FederationClientConfig,
  ) {
    this.currentReconnectDelay = config.reconnectDelayMs ?? 2000
  }

  /**
   * Get current connection status.
   * @returns Current PodConnectionStatus.
   */
  getStatus(): PodConnectionStatus {
    return this.status
  }

  /**
   * Get pod ID.
   * @returns Configured pod ID.
   */
  getPodId(): string {
    return this.config.podId
  }

  /**
   * Get active in-flight delegated task count.
   * @returns Number of running tasks.
   */
  getActiveTaskCount(): number {
    return this.inFlightTasks.size
  }

  /**
   * Start the client connection and reconnection lifecycle.
   */
  start(): void {
    if (this.disposed) return
    this.connect()
  }

  /**
   * Dispose and stop all client operations, closing sockets and aborting tasks.
   */
  dispose(): void {
    this.disposed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    for (const task of this.inFlightTasks.values()) {
      task.abortController.abort('federation client disposed')
    }
    this.inFlightTasks.clear()
    this.rejectPendingSends('federation client disposed')

    if (this.socket) {
      try {
        this.socket.close(1000, 'client disposed')
      } catch {
        // ignore socket close errors during disposal
      }
      this.socket = undefined
    }
    this.status = 'disconnected'
  }

  /**
   * Send a JSON-serializable message across the WebSocket if open.
   * @param msg - Federation wire message.
   */
  sendMessage(msg: FederationClientWireMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg))
    }
  }

  /**
   * Deliver user content to a writer-node session inbox over the hub connection.
   * @param sessionId - target session on the writer node.
   * @param content - user-role content blocks.
   * @param clientMessageId - idempotency key scoped to `sessionId`.
   * @returns accepted message id, or a structured failure.
   */
  sendToSession(
    sessionId: SessionId,
    content: ContentBlock[],
    clientMessageId: string,
  ): Promise<SessionSendResult> {
    if (this.status !== 'connected' || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        ok: false,
        code: 'disconnected',
        message: 'federation client is not connected',
      })
    }
    const requestId = randomUUID()
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000
    return new Promise<SessionSendResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSends.delete(requestId)
        resolve({
          ok: false,
          code: 'timeout',
          message: `session send timed out after ${timeoutMs}ms`,
        })
      }, timeoutMs)
      this.pendingSends.set(requestId, { resolve, timer })
      this.sendMessage({
        type: 'session/send',
        requestId,
        sessionId,
        content,
        clientMessageId,
      })
    })
  }

  private resolveToken(): string | undefined {
    if (this.config.token) return this.config.token
    if (this.config.tokenEnv && this.config.tokenEnv.length > 0) {
      return process.env[this.config.tokenEnv]
    }
    return undefined
  }

  private connect(): void {
    if (this.disposed) return
    this.status = 'connecting'

    const headers: Record<string, string> = {}
    const token = this.resolveToken()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    try {
      const socket = new WebSocket(this.config.endpoint, { headers })
      this.socket = socket

      socket.on('open', () => {
        if (this.disposed || this.socket !== socket) return
        this.status = 'connected'
        this.currentReconnectDelay = this.config.reconnectDelayMs ?? 2000
        this.register()
      })

      socket.on('message', (data: WebSocket.RawData) => {
        if (this.disposed || this.socket !== socket) return
        void (async () => {
          try {
            const raw = rawDataToString(data)
            const parsed = JSON.parse(raw) as FederationClientWireMessage
            await this.handleMessage(parsed)
          } catch (err: unknown) {
            this.ctx.logger.warn(`federation-client: invalid message: ${String(err)}`)
          }
        })()
      })

      socket.on('close', () => {
        if (this.socket === socket) {
          this.handleSocketClose()
        }
      })

      socket.on('error', (err: Error) => {
        this.ctx.logger.warn(`federation-client socket error: ${err.message}`)
        if (this.socket === socket) {
          socket.terminate()
        }
      })
    } catch (err: unknown) {
      this.ctx.logger.warn(`federation-client connect failed: ${String(err)}`)
      this.scheduleReconnect()
    }
  }

  private handleSocketClose(): void {
    this.socket = undefined
    this.status = 'disconnected'
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    this.rejectPendingSends('federation client is not connected')
    this.scheduleReconnect()
  }

  private rejectPendingSends(message: string): void {
    for (const [id, pending] of this.pendingSends) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'disconnected', message })
      this.pendingSends.delete(id)
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    const delay = this.currentReconnectDelay
    const maxDelay = this.config.maxReconnectDelayMs ?? 30000
    this.currentReconnectDelay = Math.min(delay * 2, maxDelay)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private register(): void {
    const capabilities: PodClientCapabilities = {
      workspaces: this.config.workspaces,
      tools: this.config.tools,
      sandboxModes: this.config.sandboxModes,
    }
    this.sendMessage({
      type: 'federation/register',
      podId: this.config.podId,
      name: this.config.name,
      capabilities,
      role: this.config.role ?? 'command',
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    const interval = this.config.heartbeatIntervalMs ?? 5000
    this.heartbeatTimer = setInterval(() => {
      if (this.status === 'connected') {
        this.sendMessage({
          type: 'federation/heartbeat',
          podId: this.config.podId,
          timestamp: Date.now(),
        })
      }
    }, interval)
  }

  private async handleMessage(msg: FederationClientWireMessage): Promise<void> {
    switch (msg.type) {
      case 'federation/registered': {
        this.startHeartbeat()
        break
      }
      case 'federation/heartbeat-ack': {
        // Heartbeat acknowledged by hub
        break
      }
      case 'subagent/start': {
        await this.handleSubagentStart(msg)
        break
      }
      case 'subagent/abort': {
        this.handleSubagentAbort(msg)
        break
      }
      case 'session/send-result': {
        const pending = this.pendingSends.get(msg.requestId)
        if (pending === undefined) break
        clearTimeout(pending.timer)
        this.pendingSends.delete(msg.requestId)
        if (typeof msg.messageId === 'string' && msg.messageId.length > 0) {
          pending.resolve({ ok: true, messageId: msg.messageId })
          break
        }
        const code = msg.code === 'writer-offline' || msg.code === 'unauthorized' || msg.code === 'invalid'
          ? msg.code
          : 'invalid'
        pending.resolve({
          ok: false,
          code,
          message: msg.error ?? 'session send failed',
        })
        break
      }
      default:
        break
    }
  }

  private async handleSubagentStart(req: RemoteSubagentStartPayload): Promise<void> {
    // 1. Validate capability constraints
    if (!isCwdPermitted(req.cwd, this.config.workspaces)) {
      this.sendMessage({
        type: 'subagent/stop',
        id: req.id,
        output: [],
        stopReason: 'error',
        diagnostic: `requested cwd '${req.cwd ?? ''}' is outside permitted pod workspaces`,
      })
      return
    }

    const abortController = new AbortController()
    const task: ActiveTask = {
      id: req.id,
      abortController,
    }
    this.inFlightTasks.set(req.id, task)

    try {
      const onChunk = (delta: string) => {
        if (!abortController.signal.aborted) {
          const chunkMsg: RemoteSubagentChunkPayload = {
            type: 'subagent/chunk',
            id: req.id,
            delta,
          }
          this.sendMessage(chunkMsg)
        }
      }

      const result = await this.executeTask(req, onChunk, abortController.signal)
      if (!this.disposed) {
        this.sendMessage(result)
      }
    } catch (err: unknown) {
      if (!this.disposed) {
        const isAborted = abortController.signal.aborted
        this.sendMessage({
          type: 'subagent/stop',
          id: req.id,
          output: [],
          stopReason: isAborted ? 'aborted' : 'error',
          diagnostic: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      this.inFlightTasks.delete(req.id)
    }
  }

  private handleSubagentAbort(msg: RemoteSubagentAbortPayload): void {
    const task = this.inFlightTasks.get(msg.id)
    if (task) {
      task.abortController.abort(msg.reason ?? 'aborted by remote hub')
      this.inFlightTasks.delete(msg.id)
    }
  }

  private async executeTask(
    req: RemoteSubagentStartPayload,
    onChunk: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<RemoteSubagentStopPayload> {
    if (this.config.executor) {
      return this.config.executor(req, onChunk, signal)
    }

    // Default executor: formatted response with onChunk notification
    const promptText = req.prompt.map(p => (p.type === 'text' ? p.text : '')).join('')
    onChunk(`Executed on pod ${this.config.podId}: ${promptText}`)
    return {
      type: 'subagent/stop',
      id: req.id,
      output: [{ type: 'text', text: `Executed on pod ${this.config.podId}: ${promptText}` }],
      stopReason: 'completed',
    }
  }
}
