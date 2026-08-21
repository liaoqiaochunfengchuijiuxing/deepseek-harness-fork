/**
 * Federation Client Service: public Cordis interface on `ctx.federationClient`
 * for edge pod status inspection and control.
 *
 * @module @deepseek-ai/dsh-federation-client/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { FederationPodClient } from './client.ts'
import type { PodConnectionStatus, SessionLeaseResult, SessionPersistResult, SessionSendResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    federationClient: FederationClientService
  }
}

/**
 * Service exposing the edge pod's federation connection and task status.
 */
export class FederationClientService extends Service {
  constructor(
    ctx: Context,
    private readonly client: FederationPodClient,
  ) {
    super(ctx, 'federationClient')
  }

  /**
   * Get the current connection lifecycle status.
   * @returns Current PodConnectionStatus ('connected' | 'connecting' | 'disconnected').
   */
  getStatus(): PodConnectionStatus {
    return this.client.getStatus()
  }

  /**
   * Get the pod ID configured on this edge client.
   * @returns Configured pod ID string.
   */
  getPodId(): string {
    return this.client.getPodId()
  }

  /**
   * Get the count of currently in-flight delegated subagent tasks.
   * @returns Number of running tasks.
   */
  getActiveTaskCount(): number {
    return this.client.getActiveTaskCount()
  }

  /**
   * Deliver user content to a writer-node session inbox.
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
    return this.client.sendToSession(sessionId, content, clientMessageId)
  }

  /**
   * Upload a locally-spooled event batch to hub persistence.
   * @param sessionId - session whose log is being uploaded.
   * @param events - contiguous events to append.
   * @param header - session header when the hub has not materialized this session.
   * @returns last stored seq, or a structured failure.
   */
  persistSession(
    sessionId: SessionId,
    events: SessionEvent[],
    header?: SessionHeader,
  ): Promise<SessionPersistResult> {
    return this.client.persistSession(sessionId, events, header)
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
    return this.client.leaseSession(action, sessionId)
  }
}
