/**
 * Federation pod client: WebSocket client lifecycle, handshake registration,
 * heartbeat loops, reconnection with exponential backoff, capability filtering,
 * and delegated task dispatch.
 *
 * @module @deepseek-ai/dsh-federation-client/client
 */

import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  type FsEditRequest,
  type FsTarget,
  type FsVersion,
  type FsWriteIntent,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSignal,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type {
  CapabilityRequestPayload,
  CapabilityResult,
  DelegatedTaskExecutor,
  FederationApprovalCancelPayload,
  FederationApprovalRequestPayload,
  FederationClientWireMessage,
  FederationQuestionCancelPayload,
  FederationQuestionRequestPayload,
  FederatedModelSelection,
  PodClientCapabilities,
  PodConnectionStatus,
  RemoteSubagentAbortPayload,
  RemoteSubagentChunkPayload,
  RemoteSubagentStartPayload,
  RemoteSubagentStopPayload,
  SessionCancelResult,
  SessionControlErrorCode,
  SessionLeaseResult,
  SessionPersistResult,
  SessionQueueUpdateResult,
  SessionSelectModelResult,
  SessionSendResult,
} from './types.ts'
import { isApprovalOutcome } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Answer a hub-forwarded approval for a session this pod commands.
     * Return an outcome to claim or call `next()`; no claim fails closed to `'unavailable'`.
     * @param req - the forwarded approval.
     * @mode waterfall
     */
    'federation/approval-request'(
      req: FederationApprovalRequestPayload,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
    /**
     * Answer a hub-forwarded user question for a session this pod commands.
     * Return an answer to claim or call `next()`; no claim fails closed.
     * @param req - the forwarded question.
     * @mode waterfall
     */
    'federation/question-request'(
      req: FederationQuestionRequestPayload,
      next: () => Promise<AskUserQuestionAnswer>,
    ): Promise<AskUserQuestionAnswer>
  }
}

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
  /** Bound (ms) on session send, persist, and lease round-trips. */
  requestTimeoutMs?: number
  /** Direct peer server port to listen for incoming direct P2P connections on overlay/LAN. */
  directPort?: number
  /** Direct peer server host to bind on (default: '0.0.0.0'). */
  directHost?: string
  /** Advertised direct WebSocket endpoint for other pods to connect to. */
  directEndpoint?: string
  /** Whether direct P2P transport optimization is enabled (default: true). */
  enableDirectTransport?: boolean
  /** Static direct endpoints for known peers (podId -> wsUrl). */
  peerDirectEndpoints?: Record<string, string>
  /** Optional custom delegated task executor. */
  executor?: DelegatedTaskExecutor
  /**
   * Optional programmatic approval answerer. When omitted, the client dispatches
   * `federation/approval-request`; no listener fails closed to `'unavailable'`.
   */
  approvalAnswerer?: (
    req: FederationApprovalRequestPayload,
    signal: AbortSignal,
  ) => Promise<ApprovalOutcome>
  /**
   * Optional programmatic question answerer. When omitted, the client dispatches
   * `federation/question-request`; no listener fails closed.
   */
  questionAnswerer?: (
    req: FederationQuestionRequestPayload,
    signal: AbortSignal,
  ) => Promise<AskUserQuestionAnswer>
}

interface ActiveTask {
  id: string
  abortController: AbortController
}

interface PendingSend {
  resolve: (result: SessionSendResult) => void
  timer: NodeJS.Timeout
}

interface PendingPersist {
  resolve: (result: SessionPersistResult) => void
  timer: NodeJS.Timeout
}

interface PendingLease {
  resolve: (result: SessionLeaseResult) => void
  timer: NodeJS.Timeout
}

interface PendingQueueUpdate {
  resolve: (result: SessionQueueUpdateResult) => void
  timer: NodeJS.Timeout
}

interface PendingCancel {
  resolve: (result: SessionCancelResult) => void
  timer: NodeJS.Timeout
}

interface PendingSelectModel {
  resolve: (result: SessionSelectModelResult) => void
  timer: NodeJS.Timeout
}

interface PendingCapability {
  resolve: (result: CapabilityResult) => void
  onStream?: ((chunk: unknown, done?: boolean) => void) | undefined
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
  private directServer: WebSocketServer | undefined
  private readonly directPeerSockets = new Map<string, WebSocket>()
  private readonly peerDirectEndpoints = new Map<string, string>()
  private readonly inFlightTasks = new Map<string, ActiveTask>()
  private readonly pendingSends = new Map<string, PendingSend>()
  private readonly pendingPersists = new Map<string, PendingPersist>()
  private readonly pendingLeases = new Map<string, PendingLease>()
  private readonly pendingQueueUpdates = new Map<string, PendingQueueUpdate>()
  private readonly pendingCancels = new Map<string, PendingCancel>()
  private readonly pendingSelectModels = new Map<string, PendingSelectModel>()
  private readonly pendingApprovals = new Map<string, AbortController>()
  private readonly pendingQuestions = new Map<string, AbortController>()
  private readonly pendingCapabilities = new Map<string, PendingCapability>()
  private readonly activeCapabilityStreams = new Map<string, (chunk: unknown, done?: boolean) => void>()
  private readonly activeCapabilityTasks = new Map<string, AbortController>()
  private readonly activeSubprocesses = new Map<string, SubprocessHandle | SubprocessTerminalHandle>()

  constructor(
    private readonly ctx: Context,
    private readonly config: FederationClientConfig,
  ) {
    this.currentReconnectDelay = config.reconnectDelayMs ?? 2000
    if (config.peerDirectEndpoints) {
      for (const [id, ep] of Object.entries(config.peerDirectEndpoints)) {
        this.peerDirectEndpoints.set(id, ep)
      }
    }
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
   * Check if a direct P2P connection to target pod is currently active.
   * @param podId - target pod identifier.
   * @returns true if directly connected.
   */
  isDirectConnected(podId: string): boolean {
    const ws = this.directPeerSockets.get(podId)
    return ws !== undefined && ws.readyState === WebSocket.OPEN
  }

  /**
   * Get known direct peer endpoints.
   * @returns Map of podId -> direct WebSocket endpoint.
   */
  getPeerDirectEndpoints(): Map<string, string> {
    return new Map(this.peerDirectEndpoints)
  }

  /**
   * Establish or retrieve an active direct WebSocket connection to a peer pod.
   * @param targetPodId - target pod identifier.
   * @param endpoint - target direct WebSocket URL.
   * @returns connected WebSocket, or undefined if failed.
   */
  async connectDirectPeer(targetPodId: string, endpoint: string): Promise<WebSocket | undefined> {
    const existing = this.directPeerSockets.get(targetPodId)
    if (existing && existing.readyState === WebSocket.OPEN) {
      return existing
    }
    try {
      const ws = new WebSocket(endpoint)
      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          try {
            ws.terminate()
          } catch {
            // ignore timeout termination
          }
          resolve(false)
        }, 2000)
        ws.once('open', () => {
          clearTimeout(timer)
          resolve(true)
        })
        ws.once('error', () => {
          clearTimeout(timer)
          resolve(false)
        })
      })
      if (!connected) return undefined
      this.directPeerSockets.set(targetPodId, ws)
      ws.send(JSON.stringify({
        type: 'peer/handshake',
        podId: this.config.podId,
        ...(this.resolveToken() ? { token: this.resolveToken() } : {}),
      }))
      ws.on('message', (data: WebSocket.RawData) => {
        void (async () => {
          try {
            const raw = rawDataToString(data)
            const parsed = JSON.parse(raw) as FederationClientWireMessage
            await this.handleMessage(parsed, ws)
          } catch (err: unknown) {
            this.ctx.logger.warn(`federation-client: direct peer message error: ${String(err)}`)
          }
        })()
      })
      ws.on('close', () => {
        if (this.directPeerSockets.get(targetPodId) === ws) {
          this.directPeerSockets.delete(targetPodId)
        }
      })
      ws.on('error', () => {
        try {
          ws.terminate()
        } catch {
          // ignore peer socket error
        }
      })
      return ws
    } catch {
      return undefined
    }
  }

  /**
   * Start the client connection and reconnection lifecycle.
   */
  start(): void {
    if (this.disposed) return
    if (this.config.directPort !== undefined && this.config.directPort > 0 && !this.directServer) {
      this.startDirectServer()
    }
    this.connect()
  }

  private startDirectServer(): void {
    try {
      this.directServer = new WebSocketServer({
        port: this.config.directPort,
        host: this.config.directHost ?? '0.0.0.0',
      })
      this.directServer.on('connection', (ws: WebSocket) => {
        let senderPodId: string | undefined
        ws.on('message', (data: WebSocket.RawData) => {
          void (async () => {
            try {
              const raw = rawDataToString(data)
              const parsed = JSON.parse(raw) as FederationClientWireMessage
              if (parsed.type === 'peer/handshake') {
                senderPodId = parsed.podId
                this.directPeerSockets.set(parsed.podId, ws)
                return
              }
              await this.handleMessage(parsed, ws)
            } catch (err: unknown) {
              this.ctx.logger.warn(`federation-client: direct peer message error: ${String(err)}`)
            }
          })()
        })
        ws.on('close', () => {
          if (senderPodId !== undefined && this.directPeerSockets.get(senderPodId) === ws) {
            this.directPeerSockets.delete(senderPodId)
          }
        })
        ws.on('error', () => {
          try {
            ws.terminate()
          } catch {
            // ignore peer socket error
          }
        })
      })
    } catch (err: unknown) {
      this.ctx.logger.warn(`federation-client: failed to start direct server: ${String(err)}`)
    }
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

    if (this.directServer) {
      try {
        this.directServer.close()
      } catch {
        // ignore server close error
      }
      this.directServer = undefined
    }
    for (const ws of this.directPeerSockets.values()) {
      try {
        ws.terminate()
      } catch {
        // ignore peer socket close error
      }
    }
    this.directPeerSockets.clear()
    this.peerDirectEndpoints.clear()

    for (const task of this.inFlightTasks.values()) {
      task.abortController.abort('federation client disposed')
    }
    this.inFlightTasks.clear()
    this.rejectPendingSends('federation client disposed')
    this.rejectPendingPersists('federation client disposed')
    this.rejectPendingLeases('federation client disposed')
    this.rejectPendingCapabilities('federation client disposed')
    this.abortPendingInteractions()

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

  /**
   * Shared RPC shape of the routed session-control verbs: one pending map
   * entry, one timeout, and one structured failure per outcome union.
   */
  private controlRpc<T>(
    pending: Map<string, { resolve: (result: T) => void; timer: NodeJS.Timeout }>,
    buildMessage: (requestId: string) => FederationClientWireMessage,
    disconnected: () => T,
    timedOut: (timeoutMs: number) => T,
  ): Promise<T> {
    if (this.status !== 'connected' || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve(disconnected())
    }
    const requestId = randomUUID()
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve(timedOut(timeoutMs))
      }, timeoutMs)
      pending.set(requestId, { resolve, timer })
      this.sendMessage(buildMessage(requestId))
    })
  }

  /** Result payload for a routed control reply that carries no success value. */
  private static controlReply(
    accepted: boolean | undefined,
    code: 'writer-offline' | 'unauthorized' | 'invalid' | undefined,
    error: string | undefined,
    fallback: string,
  ): { ok: true; accepted: true } | { ok: false; code: SessionControlErrorCode; message: string } {
    if (accepted === true && code === undefined) return { ok: true, accepted: true }
    const resolved = code === 'writer-offline' || code === 'unauthorized' || code === 'invalid'
      ? code
      : 'invalid'
    return { ok: false, code: resolved, message: error ?? fallback }
  }

  /**
   * Mutate one queued inbox item on the writer node over the hub connection.
   * @param sessionId - target session on the writer node.
   * @param itemId - queued message id to operate on.
   * @param action - drop, steer, or text-edit mutation.
   * @returns acceptance, or a structured failure.
   */
  queueUpdateSession(
    sessionId: SessionId,
    itemId: string,
    action: { kind: 'remove' } | { kind: 'steer' } | { kind: 'edit'; content: ContentBlock[] },
  ): Promise<SessionQueueUpdateResult> {
    return this.controlRpc(
      this.pendingQueueUpdates,
      requestId => ({ type: 'session/queue-update', requestId, sessionId, itemId, action }),
      () => ({ ok: false, code: 'disconnected', message: 'federation client is not connected' }),
      timeoutMs => ({ ok: false, code: 'timeout', message: `session queue update timed out after ${timeoutMs}ms` }),
    )
  }

  /**
   * Cancel the running turn of a writer-node session over the hub connection,
   * keeping its inbox.
   * @param sessionId - target session on the writer node.
   * @returns acceptance, or a structured failure.
   */
  cancelSession(sessionId: SessionId): Promise<SessionCancelResult> {
    return this.controlRpc(
      this.pendingCancels,
      requestId => ({ type: 'session/cancel', requestId, sessionId }),
      () => ({ ok: false, code: 'disconnected', message: 'federation client is not connected' }),
      timeoutMs => ({ ok: false, code: 'timeout', message: `session cancel timed out after ${timeoutMs}ms` }),
    )
  }

  /**
   * Select the model a writer-node session runs its next steps on, over the
   * hub connection.
   * @param sessionId - target session on the writer node.
   * @param selection - provider/model/effort to apply for the next request.
   * @returns applied selection, or a structured failure.
   */
  selectModelSession(
    sessionId: SessionId,
    selection: FederatedModelSelection,
  ): Promise<SessionSelectModelResult> {
    return this.controlRpc(
      this.pendingSelectModels,
      requestId => ({ type: 'session/select-model', requestId, sessionId, selection }),
      () => ({ ok: false, code: 'disconnected', message: 'federation client is not connected' }),
      timeoutMs => ({ ok: false, code: 'timeout', message: `session model selection timed out after ${timeoutMs}ms` }),
    )
  }

  /**
   * Upload a locally-spooled event batch to hub persistence.
   * @param sessionId - session whose log is being uploaded.
   * @param events - contiguous events to append.
   * @param header - session header when the hub has not materialized this session.
   * @returns last stored seq, or a structured failure.
   */
  persistSession(    sessionId: SessionId,
    events: SessionEvent[],
    header?: SessionHeader,
  ): Promise<SessionPersistResult> {
    if (this.status !== 'connected' || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        ok: false,
        code: 'disconnected',
        message: 'federation client is not connected',
      })
    }
    const requestId = randomUUID()
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000
    return new Promise<SessionPersistResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPersists.delete(requestId)
        resolve({
          ok: false,
          code: 'timeout',
          message: `session persist timed out after ${timeoutMs}ms`,
        })
      }, timeoutMs)
      this.pendingPersists.set(requestId, { resolve, timer })
      this.sendMessage({
        type: 'session/persist',
        requestId,
        sessionId,
        events,
        ...header !== undefined ? { header } : {},
      })
    })
  }

  /**
   * Acquire or release the hub writer lease for a session.
   * @param action - acquire or release.
   * @param sessionId - target session.
   * @returns holder pod id, or a structured failure.
   */
  leaseSession(
    action: 'session/lease-acquire' | 'session/lease-release',
    sessionId: SessionId,
  ): Promise<SessionLeaseResult> {
    if (this.status !== 'connected' || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        ok: false,
        code: 'disconnected',
        message: 'federation client is not connected',
      })
    }
    const requestId = randomUUID()
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000
    return new Promise<SessionLeaseResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingLeases.delete(requestId)
        resolve({
          ok: false,
          code: 'timeout',
          message: `session lease timed out after ${timeoutMs}ms`,
        })
      }, timeoutMs)
      this.pendingLeases.set(requestId, { resolve, timer })
      this.sendMessage({ type: action, requestId, sessionId })
    })
  }

  /**
   * Execute a capability RPC on the central hub or a target pod.
   * @param req - capability request details without type tag.
   * @param onStream - optional streaming chunk callback.
   * @param timeoutMs - request timeout in milliseconds.
   * @returns capability result.
   */
  async rpcCapability(
    req: Omit<CapabilityRequestPayload, 'type'>,
    onStream?: (chunk: unknown, done?: boolean) => void,
    timeoutMs?: number,
  ): Promise<CapabilityResult> {
    const timeout = timeoutMs ?? this.config.requestTimeoutMs ?? 15000
    if (onStream) {
      this.activeCapabilityStreams.set(req.requestId, onStream)
    }

    // Direct P2P transport optimization: when targetPodId is specified and direct transport is enabled
    const enableDirect = this.config.enableDirectTransport ?? true
    if (enableDirect && req.targetPodId && req.targetPodId !== this.config.podId) {
      let directSocket = this.directPeerSockets.get(req.targetPodId)
      if (!directSocket || directSocket.readyState !== WebSocket.OPEN) {
        const directEndpoint = this.peerDirectEndpoints.get(req.targetPodId)
        if (directEndpoint) {
          directSocket = await this.connectDirectPeer(req.targetPodId, directEndpoint)
        }
      }
      if (directSocket && directSocket.readyState === WebSocket.OPEN) {
        return new Promise<CapabilityResult>((resolve) => {
          const timer = setTimeout(() => {
            this.pendingCapabilities.delete(req.requestId)
            resolve({ ok: false, code: 'timeout', message: 'Capability RPC timed out' })
          }, timeout)

          this.pendingCapabilities.set(req.requestId, { resolve, onStream, timer })
          directSocket.send(JSON.stringify({
            type: 'capability/request',
            ...req,
          }))
        })
      }
    }

    // Fallback: relay through hub
    if (this.status !== 'connected' || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return { ok: false, code: 'disconnected', message: 'Client is not connected to federation hub' }
    }

    return new Promise<CapabilityResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCapabilities.delete(req.requestId)
        resolve({ ok: false, code: 'timeout', message: 'Capability RPC timed out' })
      }, timeout)

      this.pendingCapabilities.set(req.requestId, { resolve, onStream, timer })
      this.sendMessage({
        type: 'capability/request',
        ...req,
      })
    })
  }

  /**
   * Cancel an in-flight capability RPC.
   * @param requestId - request identifier.
   */
  cancelCapabilityRpc(requestId: string): void {
    this.activeCapabilityStreams.delete(requestId)
    const cancelMsg = JSON.stringify({
      type: 'capability/cancel',
      requestId,
    })
    for (const ws of this.directPeerSockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(cancelMsg)
        } catch {
          // ignore direct cancel error
        }
      }
    }
    if (this.status === 'connected' && this.socket?.readyState === WebSocket.OPEN) {
      this.sendMessage({
        type: 'capability/cancel',
        requestId,
      })
    }
    const pending = this.pendingCapabilities.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingCapabilities.delete(requestId)
      pending.resolve({ ok: false, code: 'FS_ABORTED', message: 'Operation was cancelled' })
    }
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
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
      return
    }
    this.status = 'connecting'

    const headers: Record<string, string> = {}
    const token = this.resolveToken()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    try {
      this.socket = new WebSocket(this.config.endpoint, { headers })

      this.socket.on('open', () => {
        this.onSocketOpen()
      })

      this.socket.on('message', (data: WebSocket.RawData) => {
        this.onSocketMessage(data)
      })

      this.socket.on('close', () => {
        this.onSocketClose()
      })

      this.socket.on('error', (_err: Error) => {
        // Socket error handled in onSocketClose
      })
    } catch {
      this.onSocketClose()
    }
  }

  private onSocketOpen(): void {
    this.status = 'connected'
    this.currentReconnectDelay = this.config.reconnectDelayMs ?? 2000
    this.register()
  }

  private onSocketClose(): void {
    this.status = 'disconnected'
    this.socket = undefined
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    this.rejectPendingSends('federation client is not connected')
    this.rejectPendingPersists('federation client is not connected')
    this.rejectPendingLeases('federation client is not connected')
    this.rejectPendingCapabilities('federation client is not connected')
    this.failPendingControl(this.pendingQueueUpdates, message => ({ ok: false as const, code: 'disconnected' as const, message }))
    this.failPendingControl(this.pendingCancels, message => ({ ok: false as const, code: 'disconnected' as const, message }))
    this.failPendingControl(this.pendingSelectModels, message => ({ ok: false as const, code: 'disconnected' as const, message }))
    this.abortPendingInteractions()
    this.scheduleReconnect()
  }

  private rejectPendingSends(message: string): void {
    for (const [id, pending] of this.pendingSends) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'disconnected', message })
      this.pendingSends.delete(id)
    }
  }

  private rejectPendingPersists(message: string): void {
    for (const [id, pending] of this.pendingPersists) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'disconnected', message })
      this.pendingPersists.delete(id)
    }
  }

  private rejectPendingLeases(message: string): void {
    for (const [id, pending] of this.pendingLeases) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'disconnected', message })
      this.pendingLeases.delete(id)
    }
  }

  /** Resolve every pending entry of one routed-control map with a structured failure. */
  private failPendingControl<T>(
    pending: Map<string, { resolve: (result: T) => void; timer: NodeJS.Timeout }>,
    buildFailure: (message: string) => T,
  ): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve(buildFailure('federation client is not connected'))
      pending.delete(id)
    }
  }

  private rejectPendingCapabilities(message: string): void {
    this.activeCapabilityStreams.clear()
    for (const [id, pending] of this.pendingCapabilities) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'FS_DISCONNECTED', message })
      this.pendingCapabilities.delete(id)
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
      ...(this.config.directEndpoint ? { directEndpoint: this.config.directEndpoint } : {}),
    }
    this.sendMessage({
      type: 'federation/register',
      podId: this.config.podId,
      name: this.config.name,
      capabilities,
      role: this.config.role ?? 'command',
      ...(this.config.directEndpoint ? { directEndpoint: this.config.directEndpoint } : {}),
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

  private onSocketMessage(data: WebSocket.RawData): void {
    if (this.disposed) return
    void (async () => {
      try {
        const raw = rawDataToString(data)
        const parsed = JSON.parse(raw) as FederationClientWireMessage
        await this.handleMessage(parsed)
      } catch (err: unknown) {
        this.ctx.logger.warn(`federation-client: invalid message: ${String(err)}`)
      }
    })()
  }

  private async handleMessage(
    msg: FederationClientWireMessage,
    senderSocket?: WebSocket,
  ): Promise<void> {
    switch (msg.type) {
      case 'federation/registered': {
        this.startHeartbeat()
        if (msg.peers) {
          for (const peer of msg.peers) {
            if (peer.directEndpoint && peer.status === 'online') {
              this.peerDirectEndpoints.set(peer.podId, peer.directEndpoint)
            } else if (peer.status === 'offline') {
              this.peerDirectEndpoints.delete(peer.podId)
            }
          }
        }
        break
      }
      case 'peer/update': {
        if (msg.status === 'online' && msg.directEndpoint) {
          this.peerDirectEndpoints.set(msg.podId, msg.directEndpoint)
        } else if (msg.status === 'offline') {
          this.peerDirectEndpoints.delete(msg.podId)
          const existing = this.directPeerSockets.get(msg.podId)
          if (existing) {
            try {
              existing.close()
            } catch {
              // ignore direct socket close error
            }
            this.directPeerSockets.delete(msg.podId)
          }
        }
        break
      }
      case 'federation/heartbeat-ack': {
        // Heartbeat acknowledged by hub
        break
      }
      case 'subagent/start': {
        await this.handleSubagentStart(msg, senderSocket)
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
      case 'session/queue-update-result': {
        const pending = this.pendingQueueUpdates.get(msg.requestId)
        if (pending === undefined) break
        clearTimeout(pending.timer)
        this.pendingQueueUpdates.delete(msg.requestId)
        pending.resolve(FederationPodClient.controlReply(msg.accepted, msg.code, msg.error, 'session queue update failed'))
        break
      }
      case 'session/cancel-result': {
        const pending = this.pendingCancels.get(msg.requestId)
        if (pending === undefined) break
        clearTimeout(pending.timer)
        this.pendingCancels.delete(msg.requestId)
        pending.resolve(FederationPodClient.controlReply(msg.accepted, msg.code, msg.error, 'session cancel failed'))
        break
      }
      case 'session/select-model-result': {
        const pending = this.pendingSelectModels.get(msg.requestId)
        if (pending === undefined) break
        clearTimeout(pending.timer)
        this.pendingSelectModels.delete(msg.requestId)
        if (msg.selected !== undefined && msg.code === undefined) {
          pending.resolve({ ok: true, selected: msg.selected })
          break
        }
        const selectCode = msg.code === 'writer-offline' || msg.code === 'unauthorized' || msg.code === 'invalid'
          ? msg.code
          : 'invalid'
        pending.resolve({
          ok: false,
          code: selectCode,
          message: msg.error ?? 'session model selection failed',
        })
        break
      }
      case 'approval/request': {
        await this.handleApprovalRequest(msg)
        break
      }
      case 'approval/cancel': {
        this.cancelPending(this.pendingApprovals, msg)
        break
      }
      case 'question/request': {
        await this.handleQuestionRequest(msg)
        break
      }
      case 'question/cancel': {
        this.cancelPending(this.pendingQuestions, msg)
        break
      }
      case 'session/persist-result': {
        const pending = this.pendingPersists.get(msg.requestId)
        if (pending === undefined) break
        clearTimeout(pending.timer)
        this.pendingPersists.delete(msg.requestId)
        if (typeof msg.lastSeq === 'number') {
          pending.resolve({ ok: true, lastSeq: msg.lastSeq })
          break
        }
        const persistCode = msg.code === 'unauthorized' || msg.code === 'invalid'
          || msg.code === 'stale-writer' || msg.code === 'unavailable'
          ? msg.code
          : 'invalid'
        pending.resolve({
          ok: false,
          code: persistCode,
          message: msg.error ?? 'session persist failed',
        })
        break
      }
      case 'session/lease-result': {
        const pending = this.pendingLeases.get(msg.requestId)
        if (pending === undefined) break
        clearTimeout(pending.timer)
        this.pendingLeases.delete(msg.requestId)
        if (typeof msg.holder === 'string' && msg.holder.length > 0 && msg.code === undefined) {
          pending.resolve({ ok: true, holder: msg.holder })
          break
        }
        const leaseCode = msg.code === 'unauthorized' || msg.code === 'stale-writer' || msg.code === 'invalid'
          ? msg.code
          : 'invalid'
        pending.resolve({
          ok: false,
          code: leaseCode,
          message: msg.error ?? 'session lease failed',
        })
        break
      }
      case 'capability/result': {
        const pending = this.pendingCapabilities.get(msg.requestId)
        if (pending === undefined) break
        clearTimeout(pending.timer)
        this.pendingCapabilities.delete(msg.requestId)
        if (msg.ok) {
          pending.resolve({ ok: true, value: msg.value })
        } else {
          pending.resolve({
            ok: false,
            ...msg.error?.code !== undefined ? { code: msg.error.code } : {},
            message: msg.error?.message ?? 'Capability RPC failed',
          })
        }
        break
      }
      case 'capability/stream': {
        const streamHandler = this.activeCapabilityStreams.get(msg.requestId) ?? this.pendingCapabilities.get(msg.requestId)?.onStream
        if (streamHandler !== undefined) {
          streamHandler(msg.chunk, msg.done)
          if (msg.done) {
            this.activeCapabilityStreams.delete(msg.requestId)
          }
        }
        break
      }
      case 'capability/request': {
        void this.handleCapabilityRequest(msg, senderSocket)
        break
      }
      case 'capability/cancel': {
        const controller = this.activeCapabilityTasks.get(msg.requestId)
        if (controller) {
          controller.abort('cancelled by hub')
          this.activeCapabilityTasks.delete(msg.requestId)
        }
        break
      }
      default:
        break
    }
  }

  private cancelPending(
    pending: Map<string, AbortController>,
    msg: FederationApprovalCancelPayload | FederationQuestionCancelPayload,
  ): void {
    const controller = pending.get(msg.requestId)
    if (controller === undefined) return
    controller.abort('cancelled by hub')
    pending.delete(msg.requestId)
  }

  private abortPendingInteractions(): void {
    for (const controller of this.pendingApprovals.values()) controller.abort('federation client disposed')
    this.pendingApprovals.clear()
    for (const controller of this.pendingQuestions.values()) controller.abort('federation client disposed')
    this.pendingQuestions.clear()
    for (const controller of this.activeCapabilityTasks.values()) controller.abort('federation client disposed')
    this.activeCapabilityTasks.clear()
  }

  private sendReply(payload: FederationClientWireMessage, senderSocket?: WebSocket): void {
    if (this.disposed) return
    if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
      try {
        senderSocket.send(JSON.stringify(payload))
        return
      } catch {
        // ignore socket write error
      }
    }
    this.sendMessage(payload)
  }

  private async handleCapabilityRequest(
    msg: CapabilityRequestPayload,
    senderSocket?: WebSocket,
  ): Promise<void> {
    const controller = new AbortController()
    this.activeCapabilityTasks.set(msg.requestId, controller)

    try {
      if (msg.seam === 'fs') {
        const fsService = this.ctx.fs as FileSystem | undefined
        if (!fsService) {
          throw new Error('Filesystem service (ctx.fs) is not available on this pod')
        }
        const result = await this.dispatchFsMethod(
          fsService,
          msg.method,
          msg.args,
          controller.signal,
          msg.requestId,
          (p) => {
            this.sendReply(p, senderSocket)
          },
        )
        this.sendReply({
          type: 'capability/result',
          requestId: msg.requestId,
          ok: true,
          value: result,
        }, senderSocket)
      } else {
        const subprocessService = this.ctx.subprocess as SubprocessRuntime | undefined
        if (!subprocessService) {
          throw new Error('Subprocess service (ctx.subprocess) is not available on this pod')
        }
        const result = await this.dispatchSubprocessMethod(
          subprocessService,
          msg.method,
          msg.args,
          controller.signal,
          msg.requestId,
          (p) => {
            this.sendReply(p, senderSocket)
          },
        )
        this.sendReply({
          type: 'capability/result',
          requestId: msg.requestId,
          ok: true,
          value: result,
        }, senderSocket)
      }
    } catch (err: unknown) {
      if (err instanceof FsError) {
        this.sendReply({
          type: 'capability/result',
          requestId: msg.requestId,
          ok: false,
          error: {
            code: err.code,
            message: err.message,
          },
        }, senderSocket)
      } else {
        this.sendReply({
          type: 'capability/result',
          requestId: msg.requestId,
          ok: false,
          error: {
            message: err instanceof Error ? err.message : String(err),
          },
        }, senderSocket)
      }
    } finally {
      this.activeCapabilityTasks.delete(msg.requestId)
    }
  }

  private async dispatchFsMethod(
    fs: FileSystem,
    method: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    requestId: string,
    sendChunk?: (payload: FederationClientWireMessage) => void,
  ): Promise<unknown> {
    const emit = sendChunk ?? ((p) => {
      this.sendMessage(p)
    })
    switch (method) {
      case 'resolve':
        return await fs.resolve(args.path as string, { ...(args.cwd !== undefined ? { cwd: args.cwd as string } : {}), signal })
      case 'processPath':
        return fs.processPath(args.target as FsTarget)
      case 'fileUrl':
        return fs.fileUrl(args.target as FsTarget)
      case 'contains':
        return fs.contains(args.parent as FsTarget, args.child as FsTarget)
      case 'stat':
        return await fs.stat(args.target as FsTarget, signal)
      case 'lstat':
        return await fs.lstat(args.path as string, args.cwd !== undefined ? { cwd: args.cwd as string } : undefined, signal)
      case 'readText':
        return await fs.readText(args.target as FsTarget, signal)
      case 'streamText': {
        let seq = 0
        const iterable = await fs.streamText(args.target as FsTarget, signal)
        for await (const chunk of iterable) {
          emit({
            type: 'capability/stream',
            requestId,
            seq: seq++,
            chunk,
          })
        }
        return { streamed: true }
      }
      case 'readBytes': {
        const bytes = await fs.readBytes(args.target as FsTarget, signal, args.maxBytes as number)
        return { base64: Buffer.from(bytes).toString('base64') }
      }
      case 'listDir':
        return await fs.listDir(args.target as FsTarget, signal)
      case 'writeText':
        return await fs.writeText(
          args.target as FsTarget,
          args.content as string,
          args.expected as FsWriteIntent | undefined,
          signal,
          args.sandboxPolicy as SandboxExecutionPolicy | undefined,
        )
      case 'editText':
        return await fs.editText(
          args.target as FsTarget,
          args.edit as FsEditRequest,
          args.expected as { version: FsVersion } | undefined,
          signal,
          args.sandboxPolicy as SandboxExecutionPolicy | undefined,
        )
      default:
        throw new Error(`Unknown filesystem method: "${method}"`)
    }
  }

  private async dispatchSubprocessMethod(
    subprocess: SubprocessRuntime,
    method: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    requestId: string,
    sendChunk?: (payload: FederationClientWireMessage) => void,
  ): Promise<unknown> {
    const emit = sendChunk ?? ((p) => {
      this.sendMessage(p)
    })
    switch (method) {
      case 'resolveExecutable': {
        const env = (args.options as { env?: Record<string, string> } | undefined)?.env
        return await subprocess.resolveExecutable(args.command as string, env, signal)
      }
      case 'spawn': {
        const handle = subprocess.spawn(args.request as SubprocessSpawnSpec)
        const handleId = randomUUID()
        this.activeSubprocesses.set(handleId, handle)

        if (handle.stdout) {
          handle.stdout.on('data', (data: Buffer) => {
            emit({
              type: 'capability/stream',
              requestId,
              seq: 0,
              chunk: { stream: 'stdout', data: data.toString('utf-8') },
            })
          })
        }
        if (handle.stderr) {
          handle.stderr.on('data', (data: Buffer) => {
            emit({
              type: 'capability/stream',
              requestId,
              seq: 0,
              chunk: { stream: 'stderr', data: data.toString('utf-8') },
            })
          })
        }

        void handle.done.then((outcome: SubprocessOutcome) => {
          let stdoutData: string | undefined
          let stderrData: string | undefined
          if (handle.collected.stdout) {
            stdoutData = handle.collected.stdout.readFrom(0).text
          }
          if (handle.collected.stderr) {
            stderrData = handle.collected.stderr.readFrom(0).text
          }
          if (stdoutData) {
            emit({
              type: 'capability/stream',
              requestId,
              seq: 1,
              chunk: { stream: 'stdout', data: stdoutData },
            })
          }
          if (stderrData) {
            emit({
              type: 'capability/stream',
              requestId,
              seq: 2,
              chunk: { stream: 'stderr', data: stderrData },
            })
          }
          emit({
            type: 'capability/stream',
            requestId,
            seq: 3,
            chunk: { type: 'exit', outcome },
            done: true,
          })
          this.activeSubprocesses.delete(handleId)
        })
        return { handleId, pid: handle.pid }
      }
      case 'terminate': {
        const handleId = typeof args.handleId === 'string' ? args.handleId : ''
        const handle = this.activeSubprocesses.get(handleId) as SubprocessHandle | undefined
        if (!handle) throw new Error(`Process handle "${handleId}" not found`)
        handle.terminate()
        return { ok: true }
      }
      case 'waitForExit': {
        const handleId = typeof args.handleId === 'string' ? args.handleId : ''
        const handle = this.activeSubprocesses.get(handleId) as SubprocessHandle | undefined
        if (!handle) throw new Error(`Process handle "${handleId}" not found`)
        const outcome = await handle.waitForExit()
        return { outcome }
      }
      case 'readFrom': {
        const handleId = typeof args.handleId === 'string' ? args.handleId : ''
        const handle = this.activeSubprocesses.get(handleId) as SubprocessHandle | undefined
        if (!handle) throw new Error(`Process handle "${handleId}" not found`)
        const streamName = typeof args.stream === 'string' ? args.stream : 'stdout'
        const reader = streamName === 'stderr' ? handle.collected.stderr : handle.collected.stdout
        if (!reader) throw new Error(`No collected reader for stream "${streamName}"`)
        const slice = reader.readFrom(args.offset as number)
        return { slice }
      }
      case 'writeStdin': {
        const handleId = typeof args.handleId === 'string' ? args.handleId : ''
        const handle = this.activeSubprocesses.get(handleId) as SubprocessHandle | undefined
        if (!handle) throw new Error(`Process handle "${handleId}" not found`)
        handle.stdin?.write(typeof args.data === 'string' ? args.data : '')
        return { ok: true }
      }
      case 'spawnTerminal': {
        const terminal = await subprocess.spawnTerminal(args.request as SubprocessTerminalSpawnSpec)
        const handleId = randomUUID()
        this.activeSubprocesses.set(handleId, terminal)
        void terminal.done.then(() => {
          emit({
            type: 'capability/stream',
            requestId,
            seq: 1,
            chunk: { type: 'terminal-exit' },
            done: true,
          })
          this.activeSubprocesses.delete(handleId)
        })
        return { handleId, pid: terminal.pid }
      }
      case 'writeTerminal': {
        const handleId = typeof args.handleId === 'string' ? args.handleId : ''
        const terminal = this.activeSubprocesses.get(handleId) as SubprocessTerminalHandle | undefined
        if (!terminal) throw new Error(`Terminal handle "${handleId}" not found`)
        await terminal.write(typeof args.data === 'string' ? args.data : '')
        return { ok: true }
      }
      case 'inspectForeground': {
        const handleId = typeof args.handleId === 'string' ? args.handleId : ''
        const terminal = this.activeSubprocesses.get(handleId) as SubprocessTerminalHandle | undefined
        if (!terminal) throw new Error(`Terminal handle "${handleId}" not found`)
        const info = await terminal.inspectForeground()
        return { info }
      }
      case 'signalForeground': {
        const handleId = typeof args.handleId === 'string' ? args.handleId : ''
        const terminal = this.activeSubprocesses.get(handleId) as SubprocessTerminalHandle | undefined
        if (!terminal) throw new Error(`Terminal handle "${handleId}" not found`)
        const signalName = (args.signal as SubprocessTerminalSignal | undefined) ?? 'SIGINT'
        await terminal.signalForeground(signalName)
        return { ok: true }
      }
      case 'terminateTerminal': {
        const handleId = typeof args.handleId === 'string' ? args.handleId : ''
        const terminal = this.activeSubprocesses.get(handleId) as SubprocessTerminalHandle | undefined
        if (!terminal) throw new Error(`Terminal handle "${handleId}" not found`)
        await terminal.terminate()
        return { ok: true }
      }
      default:
        throw new Error(`Unknown subprocess method: "${method}"`)
    }
  }

  private async handleApprovalRequest(msg: FederationApprovalRequestPayload): Promise<void> {
    if (this.pendingApprovals.has(msg.requestId)) return
    const controller = new AbortController()
    this.pendingApprovals.set(msg.requestId, controller)
    let outcome: ApprovalOutcome = 'unavailable'
    try {
      const raw = this.config.approvalAnswerer
        ? await this.config.approvalAnswerer(msg, controller.signal)
        : await this.ctx.waterfall(
          'federation/approval-request',
          msg,
          () => Promise.resolve<ApprovalOutcome>('unavailable'),
        )
      if (controller.signal.aborted) {
        outcome = 'cancelled'
      } else {
        outcome = isApprovalOutcome(raw) ? raw : 'unavailable'
      }
    } catch {
      outcome = controller.signal.aborted ? 'cancelled' : 'unavailable'
    } finally {
      this.pendingApprovals.delete(msg.requestId)
    }
    if (!this.disposed) {
      this.sendMessage({ type: 'approval/result', requestId: msg.requestId, outcome })
    }
  }

  private async handleQuestionRequest(msg: FederationQuestionRequestPayload): Promise<void> {
    if (this.pendingQuestions.has(msg.requestId)) return
    const controller = new AbortController()
    this.pendingQuestions.set(msg.requestId, controller)
    try {
      const answer = this.config.questionAnswerer
        ? await this.config.questionAnswerer(msg, controller.signal)
        : await this.ctx.waterfall(
          'federation/question-request',
          msg,
          () => Promise.reject(new Error('no local question answerer')),
        )
      if (this.disposed || controller.signal.aborted) return
      if (!Array.isArray(answer.answers) || answer.answers.length === 0) {
        this.sendMessage({
          type: 'question/result',
          requestId: msg.requestId,
          error: { code: 'UNAVAILABLE', message: 'local answerer returned no answers' },
        })
        return
      }
      this.sendMessage({
        type: 'question/result',
        requestId: msg.requestId,
        answers: answer.answers,
      })
    } catch (err: unknown) {
      if (this.disposed) return
      this.sendMessage({
        type: 'question/result',
        requestId: msg.requestId,
        error: {
          code: controller.signal.aborted ? 'ASK_ABORTED' : 'UNAVAILABLE',
          message: err instanceof Error ? err.message : String(err),
        },
      })
    } finally {
      this.pendingQuestions.delete(msg.requestId)
    }
  }

  private async handleSubagentStart(
    req: RemoteSubagentStartPayload,
    senderSocket?: WebSocket,
  ): Promise<void> {
    // 1. Validate capability constraints
    if (!isCwdPermitted(req.cwd, this.config.workspaces)) {
      this.sendReply({
        type: 'subagent/stop',
        id: req.id,
        output: [],
        stopReason: 'error',
        diagnostic: `requested cwd '${req.cwd ?? ''}' is outside permitted pod workspaces`,
      }, senderSocket)
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
          this.sendReply(chunkMsg, senderSocket)
        }
      }

      const result = await this.executeTask(req, onChunk, abortController.signal)
      if (!this.disposed) {
        this.sendReply(result, senderSocket)
      }
    } catch (err: unknown) {
      if (!this.disposed) {
        const isAborted = abortController.signal.aborted
        this.sendReply({
          type: 'subagent/stop',
          id: req.id,
          output: [],
          stopReason: isAborted ? 'aborted' : 'error',
          diagnostic: err instanceof Error ? err.message : String(err),
        }, senderSocket)
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
