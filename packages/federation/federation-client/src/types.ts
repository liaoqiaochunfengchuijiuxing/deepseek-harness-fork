/**
 * Federation client types: configuration schemas, connection statuses,
 * capability specifications, and delegation runtime interfaces.
 *
 * @module @deepseek-ai/dsh-federation-client/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Pod client connection lifecycle status. */
export type PodConnectionStatus = 'disconnected' | 'connecting' | 'connected'

/** Capabilities advertised by this pod to the hub. */
export interface PodClientCapabilities {
  /** Allowed or primary workspace directory paths on the pod. */
  workspaces?: string[] | undefined
  /** Supported tool names. */
  tools?: string[] | undefined
  /** Supported sandbox modes. */
  sandboxModes?: string[] | undefined
}

/** Token usage summary returned in delegation result. */
export interface TokenUsageSummary {
  /** Number of prompt tokens processed. */
  promptTokens: number
  /** Number of completion tokens generated. */
  completionTokens: number
  /** Total tokens consumed. */
  totalTokens: number
}

/** Registration payload sent to the hub on connection. */
export interface FederationRegisterPayload {
  /** Discriminant message type tag. */
  type: 'federation/register'
  /** Unique pod identifier. */
  podId: string
  /** Human-readable display name. */
  name: string
  /** Declared capabilities. */
  capabilities: PodClientCapabilities
  /** Declared permission role. */
  role: 'read' | 'command' | 'manage' | 'takeover'
}

/** Task delegation start message received from hub. */
export interface RemoteSubagentStartPayload {
  /** Discriminant message type tag. */
  type: 'subagent/start'
  /** Delegation run identifier. */
  id: string
  /** Prompt content blocks for the task. */
  prompt: ContentBlock[]
  /** Optional human-readable task label. */
  label?: string | undefined
  /** Optional working directory override. */
  cwd?: string | undefined
}

/** Task streaming chunk payload sent back to hub. */
export interface RemoteSubagentChunkPayload {
  /** Discriminant message type tag. */
  type: 'subagent/chunk'
  /** Delegation run identifier. */
  id: string
  /** Text delta produced by the running task. */
  delta: string
}

/** Task terminal stop payload sent back to hub. */
export interface RemoteSubagentStopPayload {
  /** Discriminant message type tag. */
  type: 'subagent/stop'
  /** Delegation run identifier. */
  id: string
  /** Final assistant output blocks. */
  output: ContentBlock[]
  /** Terminal stop reason. */
  stopReason: SubagentStopReason
  /** Diagnostic failure reason if failed. */
  diagnostic?: string | undefined
  /** Optional token usage measurements. */
  usage?: TokenUsageSummary | undefined
}

/** Task abort signal received from hub. */
export interface RemoteSubagentAbortPayload {
  /** Discriminant message type tag. */
  type: 'subagent/abort'
  /** Delegation run identifier to abort. */
  id: string
  /** Optional cancellation reason. */
  reason?: string | undefined
}

/** Heartbeat message sent to hub. */
export interface FederationHeartbeatPayload {
  /** Discriminant message type tag. */
  type: 'federation/heartbeat'
  /** Pod identifier. */
  podId: string
  /** Client timestamp when heartbeat was sent. */
  timestamp: number
}

/** Heartbeat ack received from hub. */
export interface FederationHeartbeatAckPayload {
  /** Discriminant message type tag. */
  type: 'federation/heartbeat-ack'
  /** Timestamp from client heartbeat. */
  timestamp: number
}

/** Registered ack received from hub. */
export interface FederationRegisteredPayload {
  /** Discriminant message type tag. */
  type: 'federation/registered'
  /** Confirmed pod identifier. */
  podId: string
  /** Granted permission role. */
  role: 'read' | 'command' | 'manage' | 'takeover'
}

/** Deliver a user message into a writer-node session inbox. */
export interface FederationSessionSendPayload {
  /** Discriminant message type tag. */
  type: 'session/send'
  /** Correlating request identifier. */
  requestId: string
  /** Target session on the writer node. */
  sessionId: SessionId
  /** User-role content delivered to the session inbox. */
  content: ContentBlock[]
  /** Idempotency key scoped to `sessionId`. */
  clientMessageId: string
}

/** Result of a {@link FederationSessionSendPayload}. */
export interface FederationSessionSendResultPayload {
  /** Discriminant message type tag. */
  type: 'session/send-result'
  /** Correlating request identifier. */
  requestId: string
  /** Accepted inbox message id when the send succeeded. */
  messageId?: string
  /** Failure code when the send did not enqueue. */
  code?: 'writer-offline' | 'unauthorized' | 'invalid'
  /** Failure message when the send did not enqueue. */
  error?: string
}

/** Outcome of {@link FederationClientService.sendToSession}. */
export type SessionSendResult =
  | { ok: true; messageId: string }
  | { ok: false; code: 'disconnected' | 'timeout' | 'writer-offline' | 'unauthorized' | 'invalid'; message: string }

/** Incoming or outgoing wire message union on client side. */
export type FederationClientWireMessage =
  | FederationRegisterPayload
  | FederationRegisteredPayload
  | FederationHeartbeatPayload
  | FederationHeartbeatAckPayload
  | RemoteSubagentStartPayload
  | RemoteSubagentChunkPayload
  | RemoteSubagentStopPayload
  | RemoteSubagentAbortPayload
  | FederationSessionSendPayload
  | FederationSessionSendResultPayload

/** Custom execution handler signature for executing delegated tasks. */
export type DelegatedTaskExecutor = (
  req: RemoteSubagentStartPayload,
  onChunk: (delta: string) => void,
  signal: AbortSignal,
) => Promise<RemoteSubagentStopPayload>
