/**
 * Remote Federation Session Source implementation.
 * Proxies session operations to a remote federation hub over WebSocket.
 *
 * @module @deepseek-ai/dsh-session-source-federation/federation-source
 */

import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionInspectionResult,
  SessionSearchFilter,
  SessionSource,
  SessionSourceCapabilities,
  SessionSummary,
} from '@deepseek-ai/dsh-session-source'
import type { FederationSessionSourceConfig } from './types.ts'

/** Shown after fork-to-local: the log is copied, workspace files are not. */
export const SESSION_CONTINUITY_NOTICE =
  'Session continuity is not work continuity: workspace files are not carried by session sync.'

/**
 * Refuse a log that this build cannot reconstruct.
 * @param events - candidate events.
 * @param formatVersion - writer format version.
 */
export function assertForkCompatible(events: readonly SessionEvent[], formatVersion: number): void {
  if (formatVersion !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `federated session uses log format v${formatVersion}, this harness reads v${SESSION_FORMAT_VERSION}`,
    )
  }
  for (const event of events) {
    if (event.ignorable === true) continue
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) {
      throw new Error(`federated session contains unknown required event type ${event.type} at seq ${event.seq}`)
    }
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ActiveSubscription {
  subscriptionId: string
  sessionId: SessionId
  callback: (event: SessionEvent) => void
  lastSeq: number | undefined
}

/**
 * Convert raw WebSocket data to a UTF-8 string.
 * @param data - Raw data buffer from WebSocket.
 * @returns UTF-8 decoded string.
 */
export function rawDataToString(data: WebSocket.RawData | string): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * SessionSource provider that delegates session queries and subscriptions
 * over a persistent WebSocket connection to a central federation hub.
 */
export class FederationSessionSource implements SessionSource {
  readonly id: string
  readonly name: string
  readonly kind = 'remote' as const
  readonly capabilities: SessionSourceCapabilities = {
    canWrite: false,
    canFork: true,
    canDelete: false,
    canRename: false,
    canSearch: true,
  }

  private ws: WebSocket | undefined
  private isOnline = false
  private isDisposed = false
  private reconnectTimer: NodeJS.Timeout | undefined
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly activeSubscriptions = new Map<string, ActiveSubscription>()
  private cachedSummaries: SessionSummary[] = []

  constructor(
    private readonly config: FederationSessionSourceConfig,
    private readonly ctx?: Context,
  ) {
    this.id = config.sourceId ?? 'federation-hub'
    this.name = config.sourceName ?? 'Hub Sessions'
  }

  /**
   * Check whether the remote hub connection is currently active.
   * @returns true if connected and online.
   */
  get online(): boolean {
    return this.isOnline
  }

  /**
   * Start the outbound connection to the federation hub.
   */
  start(): void {
    this.connect()
  }

  /**
   * Terminate connection and clean up resources.
   */
  dispose(): void {
    this.isDisposed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    for (const [id, req] of this.pendingRequests) {
      clearTimeout(req.timer)
      req.reject(new Error(`Session source "${this.id}" disposed`))
      this.pendingRequests.delete(id)
    }

    this.activeSubscriptions.clear()

    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore close error
      }
      this.ws = undefined
    }
    this.isOnline = false
  }

  private resolveToken(): string | undefined {
    if (this.config.token) return this.config.token
    if (this.config.tokenEnv && process.env[this.config.tokenEnv]) {
      return process.env[this.config.tokenEnv]
    }
    return undefined
  }

  private resolveOwnerPodId(): string | undefined {
    if (this.config.ownerPodId) return this.config.ownerPodId
    if (this.config.ownerPodIdEnv && process.env[this.config.ownerPodIdEnv]) {
      return process.env[this.config.ownerPodIdEnv]
    }
    return undefined
  }

  private connect(): void {
    if (this.isDisposed) return

    try {
      let endpointUrl = this.config.endpoint
      const token = this.resolveToken()
      if (token) {
        const url = new URL(endpointUrl)
        url.searchParams.set('token', token)
        endpointUrl = url.toString()
      }

      const ws = new WebSocket(endpointUrl)
      this.ws = ws

      ws.on('open', () => {
        if (this.ws !== ws) return
        // Register under a unique id (never the pod's primary id, which would
        // replace its main connection) while claiming the owning pod's
        // identity so a registry-bound token's binding check passes.
        const ownerPodId = this.resolveOwnerPodId()
        this.sendWireMessage({
          type: 'federation/register',
          podId: `session-source-${this.id}-${randomUUID()}`,
          ...ownerPodId === undefined ? {} : { ownerPodId },
          name: this.name,
          capabilities: {},
        })
      })

      ws.on('message', (data: WebSocket.RawData) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(rawDataToString(data))
        } catch {
          return
        }

        if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return
        this.handleMessage(parsed as { type: string; [key: string]: unknown })
      })

      ws.on('close', () => {
        if (this.ws !== ws) return
        this.isOnline = false
        this.ws = undefined
        this.scheduleReconnect()
      })

      ws.on('error', () => {
        if (this.ws !== ws) return
        this.isOnline = false
        try {
          ws.terminate()
        } catch {
          // ignore terminate error
        }
      })
    } catch {
      this.isOnline = false
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.isDisposed || this.config.autoReconnect === false) return
    if (this.reconnectTimer !== undefined) return

    const delay = this.config.reconnectDelayMs ?? 2000
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private sendWireMessage(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== 1 /* WebSocket.OPEN */) {
      return false
    }
    try {
      this.ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'federation/registered': {
        this.isOnline = true
        // Re-subscribe all active subscriptions with seq resumption
        for (const sub of this.activeSubscriptions.values()) {
          const fromSeq = sub.lastSeq !== undefined ? sub.lastSeq + 1 : undefined
          this.sendWireMessage({
            type: 'session/subscribe',
            subscriptionId: sub.subscriptionId,
            sessionId: sub.sessionId,
            ...fromSeq !== undefined ? { fromSeq } : {},
          })
        }
        break
      }
      case 'session/list-result': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
        const req = this.pendingRequests.get(requestId)
        if (req) {
          clearTimeout(req.timer)
          this.pendingRequests.delete(requestId)
          const sessions = Array.isArray(msg.sessions) ? msg.sessions as SessionSummary[] : []
          this.cachedSummaries = this.stampRemote(sessions)
          req.resolve(this.cachedSummaries)
        }
        break
      }
      case 'session/get-result': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
        const req = this.pendingRequests.get(requestId)
        if (req) {
          clearTimeout(req.timer)
          this.pendingRequests.delete(requestId)
          req.resolve(msg.session)
        }
        break
      }
      case 'session/search-result': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
        const req = this.pendingRequests.get(requestId)
        if (req) {
          clearTimeout(req.timer)
          this.pendingRequests.delete(requestId)
          const sessions = Array.isArray(msg.sessions) ? msg.sessions as SessionSummary[] : []
          req.resolve(this.stampRemote(sessions))
        }
        break
      }
      case 'session/persist-result': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
        const req = this.pendingRequests.get(requestId)
        if (req) {
          clearTimeout(req.timer)
          this.pendingRequests.delete(requestId)
          req.resolve(msg)
        }
        break
      }
      case 'session/stream-event': {
        const subscriptionId = typeof msg.subscriptionId === 'string' ? msg.subscriptionId : ''
        const sub = this.activeSubscriptions.get(subscriptionId)
        if (sub && msg.event && typeof msg.event === 'object') {
          const event = msg.event as SessionEvent
          sub.lastSeq = event.seq
          sub.callback(event)
        }
        break
      }
      default:
        break
    }
  }

  /** Stamp this source's identity onto hub-supplied summaries. */
  private stampRemote(sessions: SessionSummary[]): SessionSummary[] {
    return sessions.map(s => ({
      ...s,
      sourceId: this.id,
      sourceName: this.name,
      nodeKind: 'remote',
    }))
  }

  private requestWithTimeout<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const requestId = randomUUID()
    const timeoutMs = this.config.requestTimeoutMs ?? 10000

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Federation session source request "${type}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      const sent = this.sendWireMessage({
        type,
        requestId,
        ...payload,
      })

      if (!sent) {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        reject(new Error('Federation session source is not connected'))
      }
    })
  }

  /**
   * List sessions from the remote hub.
   * If offline, returns cached summaries marked as degraded.
   *
   * @param options - optional directory and limit filters.
   * @returns array of session summaries.
   */
  async listSessions(options?: SessionSearchFilter): Promise<SessionSummary[]> {
    if (!this.isOnline || !this.ws || this.ws.readyState !== 1) {
      // Degraded fallback
      let results = this.cachedSummaries.map(s => ({ ...s, isDegraded: true }))
      if (options?.cwd !== undefined) {
        results = results.filter(s => s.cwd === options.cwd)
      }
      if (options?.limit !== undefined && options.limit > 0) {
        results = results.slice(0, options.limit)
      }
      return results
    }

    try {
      const sessions = await this.requestWithTimeout<SessionSummary[]>('session/list', {
        ...options?.cwd !== undefined ? { cwd: options.cwd } : {},
        ...options?.limit !== undefined ? { limit: options.limit } : {},
      })
      return sessions
    } catch {
      // Return degraded cache on request error
      return this.cachedSummaries.map(s => ({ ...s, isDegraded: true }))
    }
  }

  /**
   * Inspect a session on the remote hub.
   * @param sessionId - target session identifier.
   * @returns Session inspection result or undefined if absent/offline.
   */
  async getSession(sessionId: SessionId): Promise<SessionInspectionResult | undefined> {
    if (!this.isOnline || !this.ws || this.ws.readyState !== 1) {
      return undefined
    }

    try {
      return await this.requestWithTimeout<SessionInspectionResult | undefined>('session/get', {
        sessionId,
      })
    } catch {
      return undefined
    }
  }

  /**
   * Search sessions on the remote hub.
   * @param options - search filter query.
   * @returns matching session summaries.
   */
  async searchSessions(options: SessionSearchFilter): Promise<SessionSummary[]> {
    if (!this.isOnline || !this.ws || this.ws.readyState !== 1) {
      let results = this.cachedSummaries.map(s => ({ ...s, isDegraded: true }))
      if (options.query) {
        const q = options.query.toLowerCase()
        results = results.filter(s => `${s.title ?? ''} ${s.id}`.toLowerCase().includes(q))
      }
      if (options.cwd !== undefined) {
        results = results.filter(s => s.cwd === options.cwd)
      }
      if (options.limit !== undefined && options.limit > 0) {
        results = results.slice(0, options.limit)
      }
      return results
    }

    try {
      return await this.requestWithTimeout<SessionSummary[]>('session/search', {
        ...options.query !== undefined ? { query: options.query } : {},
        ...options.cwd !== undefined ? { cwd: options.cwd } : {},
        ...options.limit !== undefined ? { limit: options.limit } : {},
      })
    } catch {
      return this.cachedSummaries.map(s => ({ ...s, isDegraded: true }))
    }
  }

  /**
   * Subscribe to live session stream events from the remote hub.
   * @param sessionId - target session identifier.
   * @param onEvent - callback for committed events.
   * @param fromSeq - optional start sequence number.
   * @returns disposer to cancel subscription.
   */
  subscribeEvents(
    sessionId: SessionId,
    onEvent: (event: SessionEvent) => void,
    fromSeq?: number,
  ): Promise<() => void> {
    const subscriptionId = `sub-${randomUUID()}`
    this.activeSubscriptions.set(subscriptionId, {
      subscriptionId,
      sessionId,
      callback: onEvent,
      lastSeq: fromSeq !== undefined ? fromSeq - 1 : undefined,
    })

    if (this.isOnline && this.ws && this.ws.readyState === 1) {
      this.sendWireMessage({
        type: 'session/subscribe',
        subscriptionId,
        sessionId,
        ...fromSeq !== undefined ? { fromSeq } : {},
      })
    }

    const disposer = (): void => {
      this.activeSubscriptions.delete(subscriptionId)
      if (this.isOnline && this.ws && this.ws.readyState === 1) {
        this.sendWireMessage({
          type: 'session/unsubscribe',
          subscriptionId,
        })
      }
    }

    return Promise.resolve(disposer)
  }

  /**
   * Copy a hub session into local persistence as a new child session.
   * @param id - hub session to copy.
   * @param targetCwd - optional working directory for the fork.
   * @returns the new local session id.
   */
  async forkSession(id: SessionId, targetCwd?: string): Promise<SessionId> {
    const persistence = this.ctx?.get('sessionPersistence')
    if (!persistence) {
      throw new Error('cannot fork session: SessionPersistence is not configured')
    }
    const source = await this.getSession(id)
    if (source === undefined) {
      throw new Error(`federated session "${id}" was not found`)
    }
    assertForkCompatible(source.events, source.header.version)
    const newId = SessionId(randomUUID())
    const resolvedCwd = targetCwd ?? source.header.cwd
    const newHeader: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: newId,
      createdAt: Date.now(),
      ...resolvedCwd !== undefined ? { cwd: resolvedCwd } : {},
      parentSession: id,
      delegationDepth: (source.header.delegationDepth ?? 0) + 1,
    }
    await persistence.create(newHeader)
    if (source.events.length > 0) {
      await persistence.append(newId, source.events)
    }
    return newId
  }

  /**
   * Upload a local session log to hub persistence.
   * @param id - local session to upload.
   */
  async pushSession(id: SessionId): Promise<void> {
    const persistence = this.ctx?.get('sessionPersistence')
    if (!persistence) {
      throw new Error('cannot push session: SessionPersistence is not configured')
    }
    const inspection = await persistence.inspect(id)
    assertForkCompatible(inspection.events, inspection.meta.version)
    const result = await this.requestWithTimeout<{ lastSeq?: number; error?: string; code?: string }>(
      'session/persist',
      {
        sessionId: id,
        header: inspection.meta,
        events: inspection.events,
      },
    )
    if (typeof result.lastSeq !== 'number') {
      throw new Error(result.error ?? 'session persist failed')
    }
  }
}
