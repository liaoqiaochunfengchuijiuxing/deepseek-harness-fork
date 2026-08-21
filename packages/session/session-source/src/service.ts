/**
 * Service Definition for `ctx.sessionSources`.
 * @module @deepseek-ai/dsh-session-source/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionInspectionResult,
  SessionSearchFilter,
  SessionSource,
  SessionSummary,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionSources: SessionSourcesService
  }
}

/**
 * Service registry and aggregator for session sources across local and federation nodes.
 */
export class SessionSourcesService extends Service {
  private readonly sources = new Map<string, SessionSource>()

  constructor(ctx: Context) {
    super(ctx, 'sessionSources')
  }

  /**
   * Register a session source provider into the registry.
   * @param source - the session source instance to register.
   * @returns a disposer function that unregisters the source.
   */
  registerSource(source: SessionSource): () => void {
    if (this.sources.has(source.id)) {
      throw new Error(`session source "${source.id}" is already registered`)
    }
    this.sources.set(source.id, source)
    return () => {
      this.sources.delete(source.id)
    }
  }

  /**
   * Get a registered session source by its unique identifier.
   * @param id - source identifier (e.g. 'local', 'hub').
   * @returns the session source or undefined.
   */
  getSource(id: string): SessionSource | undefined {
    return this.sources.get(id)
  }

  /**
   * List all currently registered session sources.
   * @returns array of registered session sources.
   */
  listSources(): SessionSource[] {
    return Array.from(this.sources.values())
  }

  /**
   * Aggregate and list sessions across all registered session sources.
   * Results are sorted newest-first by updatedAt/createdAt timestamp.
   * @param options - optional directory filter and result limit.
   * @returns combined session summaries across all active sources.
   */
  async listAllSessions(options?: { cwd?: string; limit?: number }): Promise<SessionSummary[]> {
    const promises = Array.from(this.sources.values()).map(async (source) => {
      try {
        return await source.listSessions(options)
      } catch {
        return []
      }
    })

    const results = await Promise.all(promises)
    const combined = results.flat()
    combined.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)

    if (options?.limit !== undefined && options.limit > 0) {
      return combined.slice(0, options.limit)
    }
    return combined
  }

  /**
   * Search sessions across all sources supporting search.
   * @param filter - search filter parameters.
   * @returns combined matching session summaries.
   */
  async searchAllSessions(filter: SessionSearchFilter): Promise<SessionSummary[]> {
    const promises = Array.from(this.sources.values()).map(async (source) => {
      try {
        if (source.searchSessions) {
          return await source.searchSessions(filter)
        }
        // Fallback: list sessions and filter by substring match on title/cwd
        const listOpts: { cwd?: string; limit?: number } = {}
        if (filter.cwd !== undefined) listOpts.cwd = filter.cwd
        const listed = await source.listSessions(Object.keys(listOpts).length > 0 ? listOpts : undefined)
        if (!filter.query) return listed
        const q = filter.query.toLowerCase()
        return listed.filter(s => (s.title && s.title.toLowerCase().includes(q)) || s.cwd.toLowerCase().includes(q))
      } catch {
        return []
      }
    })

    const results = await Promise.all(promises)
    const combined = results.flat()
    combined.sort((a, b) => b.updatedAt - a.updatedAt)

    if (filter.limit !== undefined && filter.limit > 0) {
      return combined.slice(0, filter.limit)
    }
    return combined
  }

  /**
   * Look up and load a session across registered sources.
   * @param sessionId - the target session identifier.
   * @param sourceId - optional source identifier hint to narrow search.
   * @returns object containing the finding source and the inspection result, or undefined.
   */
  async getSession(
    sessionId: SessionId,
    sourceId?: string,
  ): Promise<{ source: SessionSource; session: SessionInspectionResult } | undefined> {
    if (sourceId) {
      const source = this.sources.get(sourceId)
      if (!source) return undefined
      const session = await source.getSession(sessionId)
      return session ? { source, session } : undefined
    }

    for (const source of this.sources.values()) {
      try {
        const session = await source.getSession(sessionId)
        if (session) {
          return { source, session }
        }
      } catch {
        // continue searching other sources
      }
    }
    return undefined
  }

  /**
   * Subscribe to live events for a session, locating its source automatically.
   * @param sessionId - target session identifier.
   * @param onEvent - callback for incoming session events.
   * @param fromSeq - optional starting sequence number.
   * @param sourceId - optional specific source identifier.
   * @returns disposer to unsubscribe.
   */
  async subscribeEvents(
    sessionId: SessionId,
    onEvent: (event: SessionEvent) => void,
    fromSeq?: number,
    sourceId?: string,
  ): Promise<() => void> {
    if (sourceId) {
      const source = this.sources.get(sourceId)
      if (source?.subscribeEvents) {
        return source.subscribeEvents(sessionId, onEvent, fromSeq)
      }
      return () => {}
    }

    for (const source of this.sources.values()) {
      if (source.subscribeEvents) {
        try {
          const session = await source.getSession(sessionId)
          if (session) {
            return await source.subscribeEvents(sessionId, onEvent, fromSeq)
          }
        } catch {
          // ignore
        }
      }
    }
    return () => {}
  }
}
