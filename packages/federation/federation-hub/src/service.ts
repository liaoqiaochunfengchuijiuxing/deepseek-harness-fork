/**
 * Federation Hub core service: manages connected pods, capability declarations,
 * heartbeat liveness tracking, and subagent delegation routing.
 *
 * @module @deepseek-ai/dsh-federation-hub/service
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type WebSocket from 'ws'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  isApprovalOutcome,
  roleAllowsCommand,
  type FederationApprovalResultMessage,
  type FederationQuestionResultMessage,
  type FederationSessionSendErrorCode,
  type FederationSessionSendMessage,
  type FederationTokenRole,
  type FederationWireMessage,
  type PodCapabilities,
  type PodInfo,
  type PodStatus,
  type RemoteSubagentAbortMessage,
  type RemoteSubagentStartMessage,
  type RemoteSubagentStopMessage,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    federationHub: FederationHubService
  }

  interface Events {
    /**
     * Emitted when a pod completes handshake and registers with the hub.
     * @mode emit
     * @param pod - Registered pod information.
     */
    'federation/pod-registered': (pod: PodInfo) => void
    /**
     * Emitted when a registered pod is marked offline due to heartbeat timeout or socket close.
     * @mode emit
     * @param podId - Identifier of the offline pod.
     */
    'federation/pod-offline': (podId: string) => void
    /**
     * Emitted when a pod is explicitly removed from the registry.
     * @mode emit
     * @param podId - Identifier of the unregistered pod.
     */
    'federation/pod-unregistered': (podId: string) => void
  }
}

import type { SessionSourcesService } from '@deepseek-ai/dsh-session-source'

interface InFlightDelegation {
  podId: string
  runId: string
  onChunk?: ((delta: string) => void) | undefined
  resolve: (res: RemoteSubagentStopMessage) => void
  reject: (err: Error) => void
}

interface InternalPodRecord {
  info: PodInfo
  socket: WebSocket
}

interface PendingApproval {
  podId: string
  settle: (outcome: ApprovalOutcome) => void
  timer: NodeJS.Timeout
  abort: AbortSignal | undefined
  onAbort: (() => void) | undefined
}

interface PendingQuestion {
  podId: string
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: UserQuestionError) => void
  timer: NodeJS.Timeout
  abort: AbortSignal | undefined
  onAbort: (() => void) | undefined
}

/** Options for {@link FederationHubService}. */
export interface FederationHubServiceOptions {
  /** Bound (ms) on an approval or question round-trip to the commanding pod. */
  interactionTimeoutMs?: number
}

/**
 * Service managing connected pods and message routing across the federation hub.
 */
export class FederationHubService extends Service {
  private readonly pods = new Map<string, InternalPodRecord>()
  private readonly delegations = new Map<string, InFlightDelegation>()
  private readonly subscriptions = new Map<string, () => void>()
  private readonly sendTails = new Map<string, Promise<void>>()
  private readonly acceptedSends = new Map<string, string>()
  private readonly commanders = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly interactionTimeoutMs: number

  /**
   * Create the hub service and bind optional approval/question bridges.
   * @param ctx - owning Cordis context.
   * @param options - interaction timeout for commanding-pod round-trips.
   */
  constructor(ctx: Context, options: FederationHubServiceOptions = {}) {
    super(ctx, 'federationHub')
    this.interactionTimeoutMs = options.interactionTimeoutMs ?? 300_000
    this.ctx.effect(() => () => {
      this.failAllPending()
    }, 'federation.hub.pending-interactions')
  }

  /**
   * Bind `approval/request` and `ctx.userQuestions.ask` so commanded sessions
   * route to the commanding pod. Call after those services are composed, or
   * from plugin apply so `inject` waits for them.
   */
  bindInteractionBridges(): void {
    this.ctx.inject(['approval'], (scope) => {
      scope.on(
        'approval/request',
        (req, next) => this.handleApprovalRequest(req, next),
        { prepend: true },
      )
    })
    this.ctx.inject(['userQuestions'], (scope) => {
      const questions = scope.userQuestions
      const originalAsk = questions.ask.bind(questions)
      scope.effect(() => {
        questions.ask = (request: AskUserQuestionRequest) =>
          this.routeQuestion(request, () => originalAsk(request))
        /* v8 ignore start -- inject fiber dispose restores the original ask */
        return () => {
          questions.ask = originalAsk
        }
        /* v8 ignore stop */
      }, 'federation.hub.routeUserQuestions')
    })
  }

  /**
   * List all currently registered pods.
   * @returns Array of pod information records.
   */
  listPods(): PodInfo[] {
    return Array.from(this.pods.values()).map(r => ({ ...r.info }))
  }

  /**
   * Get information for a specific pod by ID.
   * @param podId - the target pod identifier.
   * @returns Pod info or undefined if not registered.
   */
  getPod(podId: string): PodInfo | undefined {
    const record = this.pods.get(podId)
    return record ? { ...record.info } : undefined
  }

  /**
   * Register or update a connected pod.
   * @param podId - unique pod identifier.
   * @param name - human-readable name.
   * @param capabilities - declared capabilities.
   * @param role - token permission role.
   * @param socket - active WebSocket connection to the pod.
   */
  registerPod(
    podId: string,
    name: string,
    capabilities: PodCapabilities,
    role: FederationTokenRole,
    socket: WebSocket,
  ): void {
    const existing = this.pods.get(podId)
    if (existing && existing.socket !== socket) {
      try {
        existing.socket.close(4000, 'Replaced by newer connection')
      } catch {
        // ignore error on stale socket close
      }
    }

    const info: PodInfo = {
      podId,
      name,
      capabilities,
      role,
      status: 'online',
      lastHeartbeat: Date.now(),
    }

    this.pods.set(podId, { info, socket })
    this.ctx.emit('federation/pod-registered', info)
  }

  /**
   * Update the heartbeat timestamp for a pod.
   * @param podId - pod identifier.
   */
  touchHeartbeat(podId: string): void {
    const record = this.pods.get(podId)
    if (record) {
      record.info.lastHeartbeat = Date.now()
      if (record.info.status !== 'online') {
        record.info.status = 'online'
      }
    }
  }

  /**
   * Set online/offline status for a pod.
   * @param podId - pod identifier.
   * @param status - new status.
   */
  setPodStatus(podId: string, status: PodStatus): void {
    if (status === 'offline') this.failPendingForPod(podId)
    const record = this.pods.get(podId)
    if (record && record.info.status !== status) {
      record.info.status = status
      if (status === 'offline') {
        this.ctx.emit('federation/pod-offline', podId)
        // Clean up all stream subscriptions for this pod
        const prefix = `${podId}:`
        for (const [key, disposer] of this.subscriptions) {
          if (key.startsWith(prefix)) {
            disposer()
            this.subscriptions.delete(key)
          }
        }
        // Cancel all pending delegations targeting this pod
        for (const [runId, delegation] of this.delegations) {
          if (delegation.podId === podId) {
            this.delegations.delete(runId)
            delegation.reject(new Error(`Pod "${podId}" went offline during execution`))
          }
        }
      }
    }
  }

  /**
   * Unregister a pod and close its connection.
   * @param podId - pod identifier.
   */
  unregisterPod(podId: string): void {
    const record = this.pods.get(podId)
    if (record) {
      this.pods.delete(podId)
      this.setPodStatus(podId, 'offline')
      this.ctx.emit('federation/pod-unregistered', podId)
    }
  }

  /**
   * Delegate a subagent run to a connected pod over WebSocket.
   * @param podId - target pod identifier.
   * @param request - subagent start message.
   * @param onChunk - optional chunk callback for streaming text.
   * @returns Subagent stop message from the pod.
   */
  async delegateToPod(
    podId: string,
    request: RemoteSubagentStartMessage,
    onChunk?: (delta: string) => void,
  ): Promise<RemoteSubagentStopMessage> {
    const record = this.pods.get(podId)
    if (!record || record.info.status !== 'online') {
      throw new Error(`Pod "${podId}" is not online`)
    }

    if (record.socket.readyState !== 1 /* WebSocket.OPEN */) {
      throw new Error(`Pod "${podId}" socket connection is not open`)
    }

    const runPromise = new Promise<RemoteSubagentStopMessage>((resolve, reject) => {
      this.delegations.set(request.id, {
        podId,
        runId: request.id,
        onChunk,
        resolve,
        reject,
      })
    })

    try {
      record.socket.send(JSON.stringify(request))
    } catch (err) {
      this.delegations.delete(request.id)
      throw err instanceof Error ? err : new Error(String(err))
    }

    return runPromise
  }

  /**
   * Cancel an in-flight subagent run on a pod.
   * @param podId - target pod identifier.
   * @param runId - run identifier.
   * @param reason - optional cancellation reason.
   */
  cancelPodDelegation(podId: string, runId: string, reason?: string): void {
    const record = this.pods.get(podId)
    if (record && record.socket.readyState === 1 /* WebSocket.OPEN */) {
      const abortMsg: RemoteSubagentAbortMessage = {
        type: 'subagent/abort',
        id: runId,
        ...reason !== undefined ? { reason } : {},
      }
      try {
        record.socket.send(JSON.stringify(abortMsg))
      } catch {
        // ignore send error
      }
    }

    const delegation = this.delegations.get(runId)
    if (delegation) {
      this.delegations.delete(runId)
      delegation.resolve({
        type: 'subagent/stop',
        id: runId,
        output: [],
        stopReason: 'aborted',
        ...reason !== undefined ? { diagnostic: reason } : {},
      })
    }
  }

  /**
   * Process an incoming message received from a pod socket.
   * @param podId - identifier of the sender pod.
   * @param message - parsed wire message.
   */
  handlePodMessage(podId: string, message: FederationWireMessage): void {
    this.touchHeartbeat(podId)

    switch (message.type) {
      case 'federation/heartbeat': {
        const record = this.pods.get(podId)
        if (record && record.socket.readyState === 1 /* WebSocket.OPEN */) {
          record.socket.send(JSON.stringify({
            type: 'federation/heartbeat_ack',
            timestamp: Date.now(),
          }))
        }
        break
      }
      case 'subagent/chunk': {
        const delegation = this.delegations.get(message.id)
        if (delegation && delegation.podId === podId) {
          delegation.onChunk?.(message.delta)
        }
        break
      }
      case 'subagent/stop': {
        const delegation = this.delegations.get(message.id)
        if (delegation && delegation.podId === podId) {
          this.delegations.delete(message.id)
          delegation.resolve(message)
        }
        break
      }
      case 'subagent/error': {
        const delegation = this.delegations.get(message.id)
        if (delegation && delegation.podId === podId) {
          this.delegations.delete(message.id)
          delegation.resolve({
            type: 'subagent/stop',
            id: message.id,
            output: [],
            stopReason: 'error',
            diagnostic: message.error.message,
          })
        }
        break
      }
      case 'session/list': {
        void (async () => {
          const record = this.pods.get(podId)
          if (!record || record.socket.readyState !== 1) return
          try {
            const sources = this.ctx.get('sessionSources') ??
              (this.ctx as unknown as { sessionSources?: SessionSourcesService }).sessionSources
            const sessions = sources
              ? await sources.listAllSessions({
                ...message.cwd !== undefined ? { cwd: message.cwd } : {},
                ...message.limit !== undefined ? { limit: message.limit } : {},
              })
              : []
            record.socket.send(JSON.stringify({
              type: 'session/list-result',
              requestId: message.requestId,
              sessions,
            }))
          } catch (err) {
            record.socket.send(JSON.stringify({
              type: 'session/list-result',
              requestId: message.requestId,
              sessions: [],
              error: err instanceof Error ? err.message : String(err),
            }))
          }
        })()
        break
      }
      case 'session/get': {
        void (async () => {
          const record = this.pods.get(podId)
          if (!record || record.socket.readyState !== 1) return
          try {
            const sources = this.ctx.get('sessionSources') ??
              (this.ctx as unknown as { sessionSources?: SessionSourcesService }).sessionSources
            const result = sources ? await sources.getSession(message.sessionId) : undefined
            record.socket.send(JSON.stringify({
              type: 'session/get-result',
              requestId: message.requestId,
              session: result?.session,
            }))
          } catch (err) {
            record.socket.send(JSON.stringify({
              type: 'session/get-result',
              requestId: message.requestId,
              error: err instanceof Error ? err.message : String(err),
            }))
          }
        })()
        break
      }
      case 'session/search': {
        void (async () => {
          const record = this.pods.get(podId)
          if (!record || record.socket.readyState !== 1) return
          try {
            const sources = this.ctx.get('sessionSources') ??
              (this.ctx as unknown as { sessionSources?: SessionSourcesService }).sessionSources
            const sessions = sources
              ? await sources.searchAllSessions({
                ...message.query !== undefined ? { query: message.query } : {},
                ...message.cwd !== undefined ? { cwd: message.cwd } : {},
                ...message.limit !== undefined ? { limit: message.limit } : {},
              })
              : []
            record.socket.send(JSON.stringify({
              type: 'session/search-result',
              requestId: message.requestId,
              sessions,
            }))
          } catch (err) {
            record.socket.send(JSON.stringify({
              type: 'session/search-result',
              requestId: message.requestId,
              sessions: [],
              error: err instanceof Error ? err.message : String(err),
            }))
          }
        })()
        break
      }
      case 'session/subscribe': {
        void (async () => {
          const record = this.pods.get(podId)
          if (!record || record.socket.readyState !== 1) return
          const subKey = `${podId}:${message.subscriptionId}`
          const existing = this.subscriptions.get(subKey)
          if (existing) {
            existing()
            this.subscriptions.delete(subKey)
          }

          const sources = this.ctx.get('sessionSources') ??
            (this.ctx as unknown as { sessionSources?: SessionSourcesService }).sessionSources
          if (!sources) return

          const disposer = await sources.subscribeEvents(
            message.sessionId,
            (event) => {
              const currentRecord = this.pods.get(podId)
              if (currentRecord && currentRecord.socket.readyState === 1) {
                currentRecord.socket.send(JSON.stringify({
                  type: 'session/stream-event',
                  subscriptionId: message.subscriptionId,
                  sessionId: message.sessionId,
                  event,
                }))
              }
            },
            message.fromSeq,
          )

          this.subscriptions.set(subKey, disposer)
        })()
        break
      }
      case 'session/unsubscribe': {
        const subKey = `${podId}:${message.subscriptionId}`
        const disposer = this.subscriptions.get(subKey)
        if (disposer) {
          disposer()
          this.subscriptions.delete(subKey)
        }
        break
      }
      case 'session/send': {
        void this.handleSessionSend(podId, message)
        break
      }
      case 'approval/result': {
        this.settleApprovalResult(podId, message)
        break
      }
      case 'question/result': {
        this.settleQuestionResult(podId, message)
        break
      }
      default:
        break
    }
  }

  private replySessionSend(
    podId: string,
    requestId: string,
    result: { messageId: string } | { code: FederationSessionSendErrorCode; error: string },
  ): void {
    const record = this.pods.get(podId)
    if (!record || record.socket.readyState !== 1) return
    if ('messageId' in result) {
      record.socket.send(JSON.stringify({
        type: 'session/send-result',
        requestId,
        messageId: result.messageId,
      }))
      return
    }
    record.socket.send(JSON.stringify({
      type: 'session/send-result',
      requestId,
      code: result.code,
      error: result.error,
    }))
  }

  private isContentBlocks(value: unknown): value is ContentBlock[] {
    return Array.isArray(value)
      && value.length > 0
      && value.every(block => typeof block === 'object' && block !== null && 'type' in block)
  }

  /**
   * Deliver one pod `session/send` into the live writer-node inbox.
   * Sends for one session run in arrival order. A repeated `clientMessageId`
   * returns the first accepted message id.
   * @param podId - sending pod.
   * @param message - send request.
   */
  private async handleSessionSend(podId: string, message: FederationSessionSendMessage): Promise<void> {
    const record = this.pods.get(podId)
    if (!record) return
    if (!roleAllowsCommand(record.info.role)) {
      this.replySessionSend(podId, message.requestId, {
        code: 'unauthorized',
        error: 'session send requires a command-capable token',
      })
      return
    }
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0
      || typeof message.clientMessageId !== 'string' || message.clientMessageId.length === 0
      || !this.isContentBlocks(message.content)) {
      this.replySessionSend(podId, message.requestId, {
        code: 'invalid',
        error: 'session send requires sessionId, clientMessageId, and non-empty content',
      })
      return
    }

    const sessionKey = String(message.sessionId)
    const idempotencyKey = `${sessionKey}:${message.clientMessageId}`
    const run = (): void => {
      try {
        const accepted = this.acceptedSends.get(idempotencyKey)
        if (accepted !== undefined) {
          this.replySessionSend(podId, message.requestId, { messageId: accepted })
          return
        }
        const agents = this.ctx.get('agents') as { get(id: SessionId): Agent | undefined } | undefined
        const agent = agents?.get(SessionId(message.sessionId))
        if (agent === undefined) {
          this.replySessionSend(podId, message.requestId, {
            code: 'writer-offline',
            error: `writer is offline for session ${message.sessionId}`,
          })
          return
        }
        const userMessage = createUserMessage({
          content: message.content,
          source: { kind: 'user' },
        })
        agent.followup(userMessage)
        this.acceptedSends.set(idempotencyKey, userMessage.id)
        this.commanders.set(sessionKey, podId)
        this.replySessionSend(podId, message.requestId, { messageId: userMessage.id })
      } catch (err: unknown) {
        this.replySessionSend(podId, message.requestId, {
          code: 'invalid',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const prev = this.sendTails.get(sessionKey) ?? Promise.resolve()
    const next = prev.then(() => {
      run()
    })
    this.sendTails.set(sessionKey, next)
    await next
  }

  /**
   * Forward an approval to the commanding pod, or `next()` when this hub does
   * not own the decision. A recorded commander that cannot answer fails closed
   * to `'unavailable'` and does not fall through to other answerers.
   * @param req - pending decision from `approval/request`.
   * @param next - remaining waterfall.
   * @returns claimed outcome, or the rest of the chain.
   */
  handleApprovalRequest(
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const podId = this.commanders.get(String(req.agent.session.id))
    if (podId === undefined) return next()
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')
    if (!this.canForwardTo(podId)) return Promise.resolve('unavailable')
    return this.forwardApproval(podId, req)
  }

  /**
   * Forward a user question to the commanding pod. Without a commander, call
   * `fallback` (the registered local provider) when provided.
   * @param request - questions plus optional calling agent.
   * @param fallback - local `ctx.userQuestions.ask` when this hub does not own the ask.
   * @returns the human's answer.
   */
  routeQuestion(
    request: AskUserQuestionRequest,
    fallback?: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const sessionId = request.agent?.session.id
    const podId = sessionId === undefined ? undefined : this.commanders.get(String(sessionId))
    if (sessionId === undefined || podId === undefined) {
      return fallback ? fallback() : Promise.reject(new UserQuestionError(
        'no user-questions provider is registered',
        'NO_PROVIDER',
      ))
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(new UserQuestionError(
        'ask_user_question was aborted before the user answered',
        'ASK_ABORTED',
      ))
    }
    if (!this.canForwardTo(podId)) {
      return Promise.reject(new UserQuestionError(
        'commanding pod is unavailable',
        'COMMANDER_UNAVAILABLE',
      ))
    }
    return this.forwardQuestion(podId, sessionId, request)
  }

  private canForwardTo(podId: string): boolean {
    const record = this.pods.get(podId)
    return record !== undefined
      && record.info.status === 'online'
      && roleAllowsCommand(record.info.role)
      && record.socket.readyState === 1
  }

  private sendToPod(podId: string, message: FederationWireMessage): boolean {
    const record = this.pods.get(podId)
    if (!record || record.socket.readyState !== 1) return false
    try {
      record.socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private forwardApproval(podId: string, req: ApprovalRequest): Promise<ApprovalOutcome> {
    const requestId = randomUUID()
    return new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        const pending = this.pendingApprovals.get(requestId)
        /* v8 ignore next -- abort and timeout can both fire after the first settle */
        if (pending === undefined) return
        this.pendingApprovals.delete(requestId)
        clearTimeout(pending.timer)
        if (pending.abort !== undefined && pending.onAbort !== undefined) {
          pending.abort.removeEventListener('abort', pending.onAbort)
        }
        resolve(outcome)
      }
      const onAbort = (): void => {
        this.sendToPod(podId, { type: 'approval/cancel', requestId })
        settle('cancelled')
      }
      const timer = setTimeout(() => {
        this.sendToPod(podId, { type: 'approval/cancel', requestId })
        settle('unavailable')
      }, this.interactionTimeoutMs)
      this.pendingApprovals.set(requestId, {
        podId,
        settle,
        timer,
        abort: req.signal,
        onAbort,
      })
      req.signal?.addEventListener('abort', onAbort, { once: true })
      const sent = this.sendToPod(podId, {
        type: 'approval/request',
        requestId,
        sessionId: req.agent.session.id,
        toolName: req.toolName,
        ...req.callId !== undefined ? { callId: String(req.callId) } : {},
        ...req.reason !== undefined ? { reason: req.reason } : {},
      })
      if (!sent) settle('unavailable')
    })
  }

  private forwardQuestion(
    podId: string,
    sessionId: string,
    request: AskUserQuestionRequest,
  ): Promise<AskUserQuestionAnswer> {
    const requestId = randomUUID()
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const finish = (action: () => void): void => {
        const pending = this.pendingQuestions.get(requestId)
        /* v8 ignore next -- abort and timeout can both fire after the first settle */
        if (pending === undefined) return
        this.pendingQuestions.delete(requestId)
        clearTimeout(pending.timer)
        if (pending.abort !== undefined && pending.onAbort !== undefined) {
          pending.abort.removeEventListener('abort', pending.onAbort)
        }
        action()
      }
      const onAbort = (): void => {
        this.sendToPod(podId, { type: 'question/cancel', requestId })
        finish(() => {
          reject(new UserQuestionError(
            'ask_user_question was aborted before the user answered',
            'ASK_ABORTED',
          ))
        })
      }
      const timer = setTimeout(() => {
        this.sendToPod(podId, { type: 'question/cancel', requestId })
        finish(() => {
          reject(new UserQuestionError(
            'commanding pod did not answer in time',
            'COMMANDER_UNAVAILABLE',
          ))
        })
      }, this.interactionTimeoutMs)
      this.pendingQuestions.set(requestId, {
        podId,
        resolve: (answer) => { finish(() => { resolve(answer) }) },
        reject: (error) => { finish(() => { reject(error) }) },
        timer,
        abort: request.signal,
        onAbort,
      })
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const sent = this.sendToPod(podId, {
        type: 'question/request',
        requestId,
        sessionId: SessionId(sessionId),
        questions: request.questions,
      })
      if (!sent) {
        this.pendingQuestions.get(requestId)?.reject(new UserQuestionError(
          'commanding pod is unavailable',
          'COMMANDER_UNAVAILABLE',
        ))
      }
    })
  }

  private settleApprovalResult(podId: string, message: FederationApprovalResultMessage): void {
    const pending = this.pendingApprovals.get(message.requestId)
    if (pending === undefined || pending.podId !== podId) return
    pending.settle(isApprovalOutcome(message.outcome) ? message.outcome : 'unavailable')
  }

  private settleQuestionResult(podId: string, message: FederationQuestionResultMessage): void {
    const pending = this.pendingQuestions.get(message.requestId)
    if (pending === undefined || pending.podId !== podId) return
    if (this.isAnswerItems(message.answers)) {
      pending.resolve({ answers: message.answers })
      return
    }
    const error = message.error
    pending.reject(new UserQuestionError(
      typeof error?.message === 'string' && error.message.length > 0
        ? error.message
        : 'commanding pod returned an invalid answer',
      typeof error?.code === 'string' && error.code.length > 0
        ? error.code
        : 'COMMANDER_UNAVAILABLE',
    ))
  }

  private isAnswerItems(value: unknown): value is AskUserQuestionAnswerItem[] {
    return Array.isArray(value) && value.length > 0 && value.every((item) => {
      if (typeof item !== 'object' || item === null) return false
      const record = item as { id?: unknown; selected?: unknown }
      return typeof record.id === 'string'
        && Array.isArray(record.selected)
        && record.selected.every(entry => typeof entry === 'string')
    })
  }

  private failPendingForPod(podId: string): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.podId === podId) pending.settle('unavailable')
    }
    for (const pending of [...this.pendingQuestions.values()]) {
      if (pending.podId === podId) {
        pending.reject(new UserQuestionError(
          'commanding pod went offline',
          'COMMANDER_UNAVAILABLE',
        ))
      }
    }
  }

  private failAllPending(): void {
    for (const pending of [...this.pendingApprovals.values()]) pending.settle('unavailable')
    for (const pending of [...this.pendingQuestions.values()]) {
      pending.reject(new UserQuestionError(
        'federation hub disposed',
        'COMMANDER_UNAVAILABLE',
      ))
    }
  }
}
