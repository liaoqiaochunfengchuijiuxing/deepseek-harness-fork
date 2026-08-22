/**
 * Wire protocol vocabulary and data types for deepseek-harness federation hub.
 * @module @deepseek-ai/dsh-federation-hub/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
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
  /** Direct peer WebSocket endpoint for overlay/LAN direct P2P transport. */
  directEndpoint?: string
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
  /** Direct peer WebSocket endpoint when declared. */
  directEndpoint?: string
  /** Token permission level granted to this pod connection. */
  role: FederationTokenRole
  /** Current connection status. */
  status: PodStatus
  /** Timestamp (ms) of the last received heartbeat. */
  lastHeartbeat: number
}

/** Summary of a discovered peer pod and its direct transport endpoint. */
export interface PeerDirectInfo {
  /** Peer pod identifier. */
  podId: string
  /** Human-readable peer name. */
  name: string
  /** Direct WebSocket peer endpoint if declared. */
  directEndpoint?: string
  /** Online state. */
  status: PodStatus
}

/** Registration message sent by a pod upon connecting to the hub. */
export interface FederationRegisterMessage {
  /** Discriminant message tag. */
  type: 'federation/register'
  /** Unique identifier of the pod. */
  podId: string
  /**
   * Owning pod identity for auxiliary connections (e.g. a pod's read-only
   * session-mirror source, which registers under its own unique id so it
   * does not replace the pod's primary connection). A token bound to a pod
   * identity authenticates a registration whose `ownerPodId ?? podId`
   * matches that binding.
   */
  ownerPodId?: string
  /** Human-readable display name of the pod. */
  name: string
  /** Declared capabilities of the pod. */
  capabilities?: PodCapabilities
  /** Direct peer WebSocket endpoint for overlay/LAN direct transport. */
  directEndpoint?: string
}

/** Acknowledgement message sent by the hub confirming pod registration. */
export interface FederationRegisteredMessage {
  /** Discriminant message tag. */
  type: 'federation/registered'
  /** Confirmed pod identifier. */
  podId: string
  /** Hub runtime version string. */
  hubVersion: string
  /** Active peer pods with advertised direct endpoints. */
  peers?: PeerDirectInfo[]
}

/** Peer update notification broadcast to connected pods. */
export interface FederationPeerUpdateMessage {
  /** Discriminant message tag. */
  type: 'peer/update'
  /** Peer pod identifier. */
  podId: string
  /** Human-readable peer name. */
  name?: string
  /** Direct WebSocket peer endpoint if declared. */
  directEndpoint?: string
  /** Peer status. */
  status: PodStatus
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
  /** Hub-registered pod that should execute this run. Absent: hub picks an online pod. */
  targetPodId?: string
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

/** Upload a locally-spooled event batch to hub session persistence. */
export interface FederationSessionPersistMessage {
  /** Discriminant message tag. */
  type: 'session/persist'
  /** Correlating request identifier. */
  requestId: string
  /** Session whose log is being uploaded. */
  sessionId: SessionId
  /** Header required when the hub has not materialized this session. */
  header?: SessionHeader
  /** Contiguous events to append; already-stored seqs are skipped. */
  events: SessionEvent[]
}

/** Result of a {@link FederationSessionPersistMessage}. */
export interface FederationSessionPersistResultMessage {
  /** Discriminant message tag. */
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

/** Acquire the single-writer lease for a session. */
export interface FederationSessionLeaseAcquireMessage {
  /** Discriminant message tag. */
  type: 'session/lease-acquire'
  /** Correlating request identifier. */
  requestId: string
  /** Session to write. */
  sessionId: SessionId
}

/** Release the single-writer lease for a session. */
export interface FederationSessionLeaseReleaseMessage {
  /** Discriminant message tag. */
  type: 'session/lease-release'
  /** Correlating request identifier. */
  requestId: string
  /** Session to release. */
  sessionId: SessionId
}

/** Result of a lease acquire or release. */
export interface FederationSessionLeaseResultMessage {
  /** Discriminant message tag. */
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

/** Target seam for capability delegation. */
export type CapabilitySeam = 'fs' | 'subprocess'

/** Capability RPC request message sent between nodes. */
export interface CapabilityRequestMessage {
  type: 'capability/request'
  requestId: string
  targetPodId?: string
  seam: CapabilitySeam
  method: string
  args: Record<string, unknown>
}

/** Capability RPC response result message. */
export interface CapabilityResultMessage {
  type: 'capability/result'
  requestId: string
  ok: boolean
  value?: unknown
  error?: {
    code?: string
    message: string
  }
}

/** Capability stream chunk message for streaming reads / process pipes / terminal output. */
export interface CapabilityStreamMessage {
  type: 'capability/stream'
  requestId: string
  seq: number
  chunk: unknown
  done?: boolean
}

/** Capability cancel request message to abort in-flight remote operation. */
export interface CapabilityCancelMessage {
  type: 'capability/cancel'
  requestId: string
}

/** Generic federation-level error delivered before a connection is closed. */
export interface FederationErrorMessage {
  type: 'federation/error'
  /** Machine-readable error code (e.g. 'POD_IDENTITY_MISMATCH'). */
  code: string
  /** Human-readable failure explanation. */
  message: string
}

/** Union of all messages sent over the federation WebSocket connection. */
export type FederationWireMessage =
  | FederationRegisterMessage
  | FederationRegisteredMessage
  | FederationErrorMessage
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
  | FederationSessionPersistMessage
  | FederationSessionPersistResultMessage
  | FederationSessionLeaseAcquireMessage
  | FederationSessionLeaseReleaseMessage
  | FederationSessionLeaseResultMessage
  | CapabilityRequestMessage
  | CapabilityResultMessage
  | CapabilityStreamMessage
  | CapabilityCancelMessage
  | FederationPeerUpdateMessage
