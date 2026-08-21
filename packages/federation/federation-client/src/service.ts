/**
 * Federation Client Service: public Cordis interface on `ctx.federationClient`
 * for edge pod status inspection and control.
 *
 * @module @deepseek-ai/dsh-federation-client/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { FederationPodClient } from './client.ts'
import type { PodConnectionStatus } from './types.ts'

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
}
