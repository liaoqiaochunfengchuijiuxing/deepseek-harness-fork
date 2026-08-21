/**
 * Wire protocol vocabulary and data types for deepseek-harness federation hub.
 * @module @deepseek-ai/dsh-federation-hub/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspectionResult, SessionSummary } from '@deepseek-ai/dsh-session-source'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Token authorization permission level for federation. */
export type FederationTokenRole = 'read' | 'command' | 'manage' | 'takeover'

/** Declared capabilities of a connected pod. */
export interface PodCapabilities {
  /** Supported workspace root directory paths. */
  workspaces?: string[]
  /** Supported sandbox modes (e.g. 'local', 'seatbelt', 'landlock', 'bwrap'). */
  sandboxModes?: string[]
  /** Supported tool names. */
  tools?: string[]
  /** Supported tool names (alias). */
  supportedTools?: string[]
  /** Custom capability tags or environment descriptors. */
  tags?: Record<string, string>
}

/** Online state of a registered pod. */
export type PodStatus = 'online' | 'offline'

/** Information record for a registered pod. */
export interface PodInfo {
  /** Unique pod identifier. */
  podId: string
  /** Human-readable pod name. */
  name: string
  /** Declared capabilities of the pod. */
  capabilities: PodCapabilities
  /** Token permission level granted to this pod connection. */
  role: FederationTokenRole
  /** Current connection status. */
  status: PodStatus
  /** Timestamp (ms) of the last received heartbeat. */
  lastHeartbeat: number
}

/** Registration message sent by a pod upon connecting to the hub. */
export interface FederationRegisterMessage {
  /** Discriminant message tag. */
  type: 'federation/register'
  /** Unique identifier of the pod. */
  podId: string
  /** Human-readable display name of the pod. */
  name: string
  /** Declared capabilities of the pod. */
  capabilities?: PodCapabilities
}

/** Acknowledgement message sent by the hub confirming pod registration. */
export interface FederationRegisteredMessage {
  /** Discriminant message tag. */
  type: 'federation/registered'
  /** Confirmed pod identifier. */
  podId: string
  /** Hub runtime version string. */
  hubVersion: string
}

/** Heartbeat message sent by a pod to keep its registration alive. */
export interface FederationHeartbeatMessage {
  /** Discriminant message tag. */
  type: 'federation/heartbeat'
  /** Identifier of the sender pod. */
  podId: string
}

/** Heartbeat acknowledgement sent by the hub. */
export interface FederationHeartbeatAckMessage {
  /** Discriminant message tag. */
  type: 'federation/heartbeat_ack'
  /** Server timestamp of acknowledgement. */
  timestamp: number
}

/** Subagent start request message across the federation wire. */
export interface RemoteSubagentStartMessage {
  /** Discriminant message tag. */
  type: 'subagent/start'
  /** Subagent run identifier. */
  id: string
  /** Optional human-readable task label. */
  label?: string
  /** Prompt content blocks for the subagent run. */
  prompt: ContentBlock[]
  /** Workspace directory for execution. */
  cwd?: string
  /** Extra environment variables. */
  env?: Record<string, string>
}

/** Subagent cancel/abort message across the federation wire. */
export interface RemoteSubagentAbortMessage {
  /** Discriminant message tag. */
  type: 'subagent/abort'
  /** Target subagent run identifier. */
  id: string
  /** Optional cancellation reason. */
  reason?: string
}

/** Subagent streamed chunk message across the federation wire. */
export interface RemoteSubagentChunkMessage {
  /** Discriminant message tag. */
  type: 'subagent/chunk'
  /** Subagent run identifier. */
  id: string
  /** Streamed output text delta. */
  delta: string
}

/** Subagent token usage summary. */
export interface RemoteSubagentUsage {
  /** Prompt / input tokens. */
  promptTokens?: number
  /** Completion / output tokens. */
  completionTokens?: number
  /** Total tokens consumed. */
  totalTokens?: number
}

/** Subagent terminal stop message across the federation wire. */
export interface RemoteSubagentStopMessage {
  /** Discriminant message tag. */
  type: 'subagent/stop'
  /** Subagent run identifier. */
  id: string
  /** Final assembled output content blocks. */
  output: ContentBlock[]
  /** Terminal execution stop reason. */
  stopReason: SubagentStopReason
  /** Optional diagnostic message on failure. */
  diagnostic?: string
  /** Optional token usage summary. */
  usage?: RemoteSubagentUsage
}

/** Subagent error message across the federation wire. */
export interface RemoteSubagentErrorMessage {
  /** Discriminant message tag. */
  type: 'subagent/error'
  /** Subagent run identifier. */
  id: string
  /** Error detail. */
  error: {
    /** Failure message. */
    message: string
    /** Optional failure code. */
    code?: string
  }
}

/** Ping message for WebSocket keepalive. */
export interface FederationPingMessage {
  /** Discriminant message tag. */
  type: 'ping'
}

/** Pong message for WebSocket keepalive. */
export interface FederationPongMessage {
  /** Discriminant message tag. */
  type: 'pong'
}

/** Request session list across hub-accessible sources. */
export interface FederationSessionListMessage {
  /** Discriminant message tag. */
  type: 'session/list'
  /** Correlating request identifier. */
  requestId: string
  /** Optional directory filter. */
  cwd?: string
  /** Optional limit. */
  limit?: number
}

/** Result of session list request. */
export interface FederationSessionListResultMessage {
  /** Discriminant message tag. */
  type: 'session/list-result'
  /** Correlating request identifier. */
  requestId: string
  /** Returned session summaries. */
  sessions: SessionSummary[]
  /** Optional error message. */
  error?: string
}

/** Request single session inspection from hub. */
export interface FederationSessionGetMessage {
  /** Discriminant message tag. */
  type: 'session/get'
  /** Correlating request identifier. */
  requestId: string
  /** Target session identifier. */
  sessionId: SessionId
}

/** Result of session inspection request. */
export interface FederationSessionGetResultMessage {
  /** Discriminant message tag. */
  type: 'session/get-result'
  /** Correlating request identifier. */
  requestId: string
  /** Resolved session inspection result if found. */
  session?: SessionInspectionResult
  /** Optional error message. */
  error?: string
}

/** Search sessions on hub. */
export interface FederationSessionSearchMessage {
  /** Discriminant message tag. */
  type: 'session/search'
  /** Correlating request identifier. */
  requestId: string
  /** Search query text. */
  query?: string
  /** Optional working directory filter. */
  cwd?: string
  /** Optional limit. */
  limit?: number
}

/** Result of session search request. */
export interface FederationSessionSearchResultMessage {
  /** Discriminant message tag. */
  type: 'session/search-result'
  /** Correlating request identifier. */
  requestId: string
  /** Returned matching session summaries. */
  sessions: SessionSummary[]
  /** Optional error message. */
  error?: string
}

/** Subscribe to live session stream on hub. */
export interface FederationSessionSubscribeMessage {
  /** Discriminant message tag. */
  type: 'session/subscribe'
  /** Subscription handle identifier. */
  subscriptionId: string
  /** Target session identifier. */
  sessionId: SessionId
  /** Optional start seq number. */
  fromSeq?: number
}

/** Live streaming event from hub session. */
export interface FederationSessionStreamEventMessage {
  /** Discriminant message tag. */
  type: 'session/stream-event'
  /** Subscription handle identifier. */
  subscriptionId: string
  /** Target session identifier. */
  sessionId: SessionId
  /** Committed session event. */
  event: SessionEvent
}

/** Cancel live stream subscription. */
export interface FederationSessionUnsubscribeMessage {
  /** Discriminant message tag. */
  type: 'session/unsubscribe'
  /** Subscription handle identifier. */
  subscriptionId: string
}

/** Union of all messages sent over the federation WebSocket connection. */
export type FederationWireMessage =
  | FederationRegisterMessage
  | FederationRegisteredMessage
  | FederationHeartbeatMessage
  | FederationHeartbeatAckMessage
  | RemoteSubagentStartMessage
  | RemoteSubagentAbortMessage
  | RemoteSubagentChunkMessage
  | RemoteSubagentStopMessage
  | RemoteSubagentErrorMessage
  | FederationPingMessage
  | FederationPongMessage
  | FederationSessionListMessage
  | FederationSessionListResultMessage
  | FederationSessionGetMessage
  | FederationSessionGetResultMessage
  | FederationSessionSearchMessage
  | FederationSessionSearchResultMessage
  | FederationSessionSubscribeMessage
  | FederationSessionStreamEventMessage
  | FederationSessionUnsubscribeMessage
