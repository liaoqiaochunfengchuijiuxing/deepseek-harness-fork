/**
 * Wire protocol vocabulary for remote subagent communication over WebSocket.
 * @module @deepseek-ai/dsh-subagent-remote/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Message from client to remote endpoint to start a subagent run. */
export interface RemoteSubagentStartMessage {
  /** The message discriminant tag. */
  type: 'subagent/start'
  /** Unique subagent run identifier. */
  id: string
  /** Human-readable task label or description. */
  label?: string
  /** The model-facing initial prompt content. */
  prompt: ContentBlock[]
  /** Absolute working directory for the remote session workspace. */
  cwd?: string
  /** Extra environment variables for the remote execution environment. */
  env?: Record<string, string>
  /** Hub-registered pod that should execute this run. Absent: hub picks an online pod. */
  targetPodId?: string
}

/** Message from client to remote endpoint to abort an in-flight subagent run. */
export interface RemoteSubagentAbortMessage {
  /** The message discriminant tag. */
  type: 'subagent/abort'
  /** Target subagent run identifier to cancel. */
  id: string
  /** Optional cancellation reason. */
  reason?: string
}

/** Client ping message for connection keepalive. */
export interface RemoteSubagentPingMessage {
  /** The message discriminant tag. */
  type: 'ping'
}

/** All possible messages sent from client to remote server. */
export type RemoteSubagentClientMessage =
  | RemoteSubagentStartMessage
  | RemoteSubagentAbortMessage
  | RemoteSubagentPingMessage

/** Message from remote endpoint to client with a streamed text chunk. */
export interface RemoteSubagentChunkMessage {
  /** The message discriminant tag. */
  type: 'subagent/chunk'
  /** Subagent run identifier. */
  id: string
  /** Incremental output delta text. */
  delta: string
}

/** Token usage summary reported by the remote subagent. */
export interface RemoteSubagentUsage {
  /** Prompt / input tokens consumed. */
  promptTokens?: number
  /** Completion / output tokens consumed. */
  completionTokens?: number
  /** Total tokens consumed across prompt and completion. */
  totalTokens?: number
}

/** Message from remote endpoint to client indicating run completion. */
export interface RemoteSubagentStopMessage {
  /** The message discriminant tag. */
  type: 'subagent/stop'
  /** Subagent run identifier. */
  id: string
  /** The final assembled model-facing output content. */
  output: ContentBlock[]
  /** Terminal stop reason mapped from remote execution. */
  stopReason: SubagentStopReason
  /** Optional diagnostic message on failure. */
  diagnostic?: string
  /** Optional token usage summary. */
  usage?: RemoteSubagentUsage
}

/** Message from remote endpoint to client indicating an error. */
export interface RemoteSubagentErrorMessage {
  /** The message discriminant tag. */
  type: 'subagent/error'
  /** Subagent run identifier. */
  id: string
  /** Error detail payload. */
  error: {
    /** Failure diagnostic message. */
    message: string
    /** Optional error code. */
    code?: string
  }
}

/** Server pong message answering client ping. */
export interface RemoteSubagentPongMessage {
  /** The message discriminant tag. */
  type: 'pong'
}

/** All possible messages sent from remote server to client. */
export type RemoteSubagentServerMessage =
  | RemoteSubagentChunkMessage
  | RemoteSubagentStopMessage
  | RemoteSubagentErrorMessage
  | RemoteSubagentPongMessage
