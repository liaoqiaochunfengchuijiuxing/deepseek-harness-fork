/**
 * Federation client types: configuration schemas, connection statuses,
 * capability specifications, and delegation runtime interfaces.
 *
 * @module @deepseek-ai/dsh-federation-client/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

export type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'

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

/** Closed approval outcomes accepted on the federation wire. */
const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/**
 * Whether `value` is a closed {@link ApprovalOutcome}.
 * @param value - untrusted answerer or wire payload.
 * @returns true when the value is one of the four outcomes.
 */
export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && (APPROVAL_OUTCOMES as readonly string[]).includes(value)
}

/** Hub-forwarded approval for a session this pod commands. */
export interface FederationApprovalRequestPayload {
  /** Discriminant message type tag. */
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

/** This pod's decision for a {@link FederationApprovalRequestPayload}. */
export interface FederationApprovalResultPayload {
  /** Discriminant message type tag. */
  type: 'approval/result'
  /** Correlating request identifier. */
  requestId: string
  /** Closed outcome. */
  outcome: ApprovalOutcome
}

/** Withdraw a still-pending {@link FederationApprovalRequestPayload}. */
export interface FederationApprovalCancelPayload {
  /** Discriminant message type tag. */
  type: 'approval/cancel'
  /** Correlating request identifier. */
  requestId: string
}

/** Hub-forwarded user question for a session this pod commands. */
export interface FederationQuestionRequestPayload {
  /** Discriminant message type tag. */
  type: 'question/request'
  /** Correlating request identifier. */
  requestId: string
  /** Writer-node session the question belongs to. */
  sessionId: SessionId
  /** Questions to display. */
  questions: AskUserQuestionItem[]
}

/** This pod's answer or failure for a {@link FederationQuestionRequestPayload}. */
export interface FederationQuestionResultPayload {
  /** Discriminant message type tag. */
  type: 'question/result'
  /** Correlating request identifier. */
  requestId: string
  /** Structured answers when collected. */
  answers?: AskUserQuestionAnswerItem[]
  /** Failure when this pod did not collect an answer. */
  error?: {
    /** Failure code. */
    code: string
    /** Failure message. */
    message: string
  }
}

/** Withdraw a still-pending {@link FederationQuestionRequestPayload}. */
export interface FederationQuestionCancelPayload {
  /** Discriminant message type tag. */
  type: 'question/cancel'
  /** Correlating request identifier. */
  requestId: string
}

/** Upload a locally-spooled event batch to hub session persistence. */
export interface FederationSessionPersistPayload {
  /** Discriminant message type tag. */
  type: 'session/persist'
  /** Correlating request identifier. */
  requestId: string
  /** Session whose log is being uploaded. */
  sessionId: SessionId
  /** Header required when the hub has not materialized this session. */
  header?: SessionHeader
  /** Contiguous events to append. */
  events: SessionEvent[]
}

/** Result of a {@link FederationSessionPersistPayload}. */
export interface FederationSessionPersistResultPayload {
  /** Discriminant message type tag. */
  type: 'session/persist-result'
  /** Correlating request identifier. */
  requestId: string
  /** Highest stored seq after applying this batch. */
  lastSeq?: number
  /** Failure code when the upload did not apply. */
  code?: 'unauthorized' | 'invalid' | 'stale-writer' | 'unavailable'
  /** Failure message when the upload did not apply. */
  error?: string
}

/** Acquire or release the single-writer lease. */
export interface FederationSessionLeasePayload {
  /** Discriminant message type tag. */
  type: 'session/lease-acquire' | 'session/lease-release'
  /** Correlating request identifier. */
  requestId: string
  /** Target session. */
  sessionId: SessionId
}

/** Result of a lease acquire or release. */
export interface FederationSessionLeaseResultPayload {
  /** Discriminant message type tag. */
  type: 'session/lease-result'
  /** Correlating request identifier. */
  requestId: string
  /** Holder pod id when acquire succeeded. */
  holder?: string
  /** Failure code. */
  code?: 'unauthorized' | 'stale-writer' | 'invalid'
  /** Failure message. */
  error?: string
}

/** Outcome of persist RPCs. */
export type SessionPersistResult =
  | { ok: true; lastSeq: number }
  | { ok: false; code: 'disconnected' | 'timeout' | 'unauthorized' | 'invalid' | 'stale-writer' | 'unavailable'; message: string }

/** Outcome of a lease RPC. */
export type SessionLeaseResult =
  | { ok: true; holder: string }
  | { ok: false; code: 'disconnected' | 'timeout' | 'unauthorized' | 'stale-writer' | 'invalid'; message: string }

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
  | FederationApprovalRequestPayload
  | FederationApprovalResultPayload
  | FederationApprovalCancelPayload
  | FederationQuestionRequestPayload
  | FederationQuestionResultPayload
  | FederationQuestionCancelPayload
  | FederationSessionPersistPayload
  | FederationSessionPersistResultPayload
  | FederationSessionLeasePayload
  | FederationSessionLeaseResultPayload

/** Custom execution handler signature for executing delegated tasks. */
export type DelegatedTaskExecutor = (
  req: RemoteSubagentStartPayload,
  onChunk: (delta: string) => void,
  signal: AbortSignal,
) => Promise<RemoteSubagentStopPayload>
