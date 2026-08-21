/**
 * Types and interfaces for the session sources capability seam.
 * @module @deepseek-ai/dsh-session-source/types
 */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** Lightweight summary describing one session from any session source. */
export interface SessionSummary {
  /** Session identifier. */
  id: SessionId
  /** Resolved human-readable session title. */
  title?: string | undefined
  /** Session creation timestamp (ms). */
  createdAt: number
  /** Last update timestamp (ms). */
  updatedAt: number
  /** Working directory of the session. */
  cwd: string
  /** Parent session identifier if this is a delegated or forked session. */
  parentSession?: SessionId | undefined
  /** Identifier of the owning session source (e.g. 'local' or a pod/hub id). */
  sourceId: string
  /** Human-readable node or source label. */
  sourceName?: string | undefined
  /** Node classification kind ('local' or 'remote'). */
  nodeKind?: 'local' | 'remote' | undefined
  /** Whether the session source connection is currently degraded. */
  isDegraded?: boolean | undefined
}

/** Filter criteria for searching or querying sessions across sources. */
export interface SessionSearchFilter {
  /** Optional free-text search query. */
  query?: string | undefined
  /** Optional working directory filter. */
  cwd?: string | undefined
  /** Maximum number of results to return. */
  limit?: number | undefined
}

/** Declared operational capabilities for a session source. */
export interface SessionSourceCapabilities {
  /** Whether this source allows creating and appending new turns. */
  readonly canWrite: boolean
  /** Whether this source supports forking a session into a new session. */
  readonly canFork: boolean
  /** Whether this source supports deleting sessions. */
  readonly canDelete: boolean
  /** Whether this source supports renaming sessions. */
  readonly canRename: boolean
  /** Whether this source supports full-text search. */
  readonly canSearch: boolean
}

/** Result of loading/inspecting a session from a source. */
export interface SessionInspectionResult {
  /** Header metadata for the session. */
  header: SessionHeader
  /** Contiguous event log for the session. */
  events: readonly SessionEvent[]
}

/** Provider interface for a session source (local persistence or remote federation proxy). */
export interface SessionSource {
  /** Unique source identifier (e.g. 'local', 'hub', 'pod-mac-1'). */
  readonly id: string
  /** Human-readable display name for this source. */
  readonly name: string
  /** Node classification kind. */
  readonly kind: 'local' | 'remote'
  /** Feature capabilities supported by this source. */
  readonly capabilities: SessionSourceCapabilities

  /**
   * List session summaries available from this source.
   * @param options - optional filtering and limit parameters.
   * @returns list of session summaries.
   */
  listSessions(options?: { cwd?: string; limit?: number }): Promise<SessionSummary[]>

  /**
   * Fetch full metadata and events for a session.
   * @param id - session identifier.
   * @returns inspection result if found, or undefined.
   */
  getSession(id: SessionId): Promise<SessionInspectionResult | undefined>

  /**
   * Search sessions matching a search filter.
   * @param filter - search query filter.
   * @returns list of matching session summaries.
   */
  searchSessions?(filter: SessionSearchFilter): Promise<SessionSummary[]>

  /**
   * Subscribe to live session events as they are committed.
   * @param sessionId - target session identifier.
   * @param onEvent - callback invoked for each new event.
   * @param fromSeq - optional sequence number to replay from.
   * @returns unsubscribe function.
   */
  subscribeEvents?(
    sessionId: SessionId,
    onEvent: (event: SessionEvent) => void,
    fromSeq?: number,
  ): Promise<() => void>

  /**
   * Rename a session title.
   * @param id - session identifier.
   * @param title - new title string.
   */
  renameSession?(id: SessionId, title: string): Promise<void>

  /**
   * Delete a session and its durable records.
   * @param id - session identifier.
   */
  deleteSession?(id: SessionId): Promise<void>

  /**
   * Fork a session into a new independent session.
   * @param id - source session identifier.
   * @param targetCwd - optional new working directory for the fork.
   * @returns new session identifier.
   */
  forkSession?(id: SessionId, targetCwd?: string): Promise<SessionId>
}
