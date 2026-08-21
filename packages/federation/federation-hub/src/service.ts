/**
 * Federation Hub core service: manages connected pods, capability declarations,
 * heartbeat liveness tracking, and subagent delegation routing.
 *
 * @module @deepseek-ai/dsh-federation-hub/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type WebSocket from 'ws'
import type {
  FederationTokenRole,
  FederationWireMessage,
  PodCapabilities,
  PodInfo,
  PodStatus,
  RemoteSubagentAbortMessage,
  RemoteSubagentStartMessage,
  RemoteSubagentStopMessage,
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

/**
 * Service managing connected pods and message routing across the federation hub.
 */
export class FederationHubService extends Service {
  private readonly pods = new Map<string, InternalPodRecord>()
  private readonly delegations = new Map<string, InFlightDelegation>()

  constructor(ctx: Context) {
    super(ctx, 'federationHub')
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
    const record = this.pods.get(podId)
    if (record && record.info.status !== status) {
      record.info.status = status
      if (status === 'offline') {
        this.ctx.emit('federation/pod-offline', podId)
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
      default:
        break
    }
  }
}
