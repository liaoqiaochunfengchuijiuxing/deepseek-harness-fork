/**
 * Wire protocol vocabulary and data types for deepseek-harness federation hub.
 * @module @deepseek-ai/dsh-federation-hub/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspectionResult, SessionSummary } from '@deepseek-ai/dsh-session-source'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

export type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'

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

/**
 * Whether `role` may send to a writer-node inbox (`command` and above).
 * @param role - token role granted to the pod connection.
 * @returns true when the role is `command`, `manage`, or `takeover`.
 */
export function roleAllowsCommand(role: FederationTokenRole): boolean {
  switch (role) {
    case 'command':
    case 'manage':
    case 'takeover':
      return true
    case 'read':
      return false
  }
}

/** Failure codes for {@link FederationSessionSendResultMessage}. */
export type FederationSessionSendErrorCode = 'writer-offline' | 'unauthorized' | 'invalid'

/** Deliver a user message into a live writer-node session inbox. */
export interface FederationSessionSendMessage {
  /** Discriminant message tag. */
  type: 'session/send'
  /** Correlating request identifier. */
  requestId: string
  /** Target session on the writer node. */
  sessionId: SessionId
  /** User-role content delivered to the session inbox. */
  content: ContentBlock[]
  /**
   * Idempotency key scoped to `sessionId`. A later send with the same key
   * returns the first accepted message id and does not enqueue again.
   */
  clientMessageId: string
}

/** Result of a {@link FederationSessionSendMessage}. */
export interface FederationSessionSendResultMessage {
  /** Discriminant message tag. */
  type: 'session/send-result'
  /** Correlating request identifier. */
  requestId: string
  /** Accepted inbox message id when the send succeeded. */
  messageId?: string
  /** Failure code when the send did not enqueue. */
  code?: FederationSessionSendErrorCode
  /** Failure message when the send did not enqueue. */
  error?: string
}

/** Closed approval outcomes accepted on the federation wire. */
const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/**
 * Whether `value` is a closed {@link ApprovalOutcome}.
 * @param value - untrusted wire payload.
 * @returns true when the value is one of the four outcomes.
 */
export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && (APPROVAL_OUTCOMES as readonly string[]).includes(value)
}

/** Forward one approval question to the commanding pod. */
export interface FederationApprovalRequestMessage {
  /** Discriminant message tag. */
  type: 'approval/request'
  /** Correlating request identifier. */
  requestId: string
  /** Writer-node session the approval belongs to. */
  sessionId: SessionId
  /** Tool the question is about. */
  toolName: string
  /** Exact tool call id when the asker had one. */
  callId?: string
  /** Asker's human-readable explanation. */
  reason?: string
}

/** Commanding pod's decision for a {@link FederationApprovalRequestMessage}. */
export interface FederationApprovalResultMessage {
  /** Discriminant message tag. */
  type: 'approval/result'
  /** Correlating request identifier. */
  requestId: string
  /** Closed outcome when the pod answered. */
  outcome?: ApprovalOutcome
}

/** Withdraw a still-pending {@link FederationApprovalRequestMessage}. */
export interface FederationApprovalCancelMessage {
  /** Discriminant message tag. */
  type: 'approval/cancel'
  /** Correlating request identifier. */
  requestId: string
}

/** Forward one user-questions ask to the commanding pod. */
export interface FederationQuestionRequestMessage {
  /** Discriminant message tag. */
  type: 'question/request'
  /** Correlating request identifier. */
  requestId: string
  /** Writer-node session the question belongs to. */
  sessionId: SessionId
  /** Questions to display on the pod. */
  questions: AskUserQuestionItem[]
}

/** Commanding pod's answer or failure for a {@link FederationQuestionRequestMessage}. */
export interface FederationQuestionResultMessage {
  /** Discriminant message tag. */
  type: 'question/result'
  /** Correlating request identifier. */
  requestId: string
  /** Structured answers when the pod collected them. */
  answers?: AskUserQuestionAnswerItem[]
  /** Failure when the pod did not collect an answer. */
  error?: {
    /** Failure code. */
    code: string
    /** Failure message. */
    message: string
  }
}

/** Withdraw a still-pending {@link FederationQuestionRequestMessage}. */
export interface FederationQuestionCancelMessage {
  /** Discriminant message tag. */
  type: 'question/cancel'
  /** Correlating request identifier. */
  requestId: string
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
  | FederationSessionSendMessage
  | FederationSessionSendResultMessage
  | FederationApprovalRequestMessage
  | FederationApprovalResultMessage
  | FederationApprovalCancelMessage
  | FederationQuestionRequestMessage
  | FederationQuestionResultMessage
  | FederationQuestionCancelMessage
