/**
 * Local implementation of SessionSource wrapping in-process session persistence and projections.
 * @module @deepseek-ai/dsh-session-source-local/local-source
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {
  SessionInspectionResult,
  SessionSearchFilter,
  SessionSource,
  SessionSourceCapabilities,
  SessionSummary,
} from '@deepseek-ai/dsh-session-source'

/**
 * Local session source provider backed by in-process persistence and session services.
 */
export class LocalSessionSource implements SessionSource {
  readonly id = 'local'
  readonly name = 'Local Sessions'
  readonly kind = 'local' as const
  readonly capabilities: SessionSourceCapabilities = {
    canWrite: true,
    canFork: true,
    canDelete: true,
    canRename: true,
    canSearch: true,
  }

  constructor(private readonly ctx: Context) {}

  async listSessions(options?: { cwd?: string; limit?: number }): Promise<SessionSummary[]> {
    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) {
      const sessions = this.ctx.get('sessions')
      if (!sessions) return []
      const list: SessionSummary[] = []
      for (const session of sessions.list()) {
        if (options?.cwd && session.header.cwd !== options.cwd) continue
        list.push({
          id: session.header.id,
          createdAt: session.header.createdAt,
          updatedAt: session.header.createdAt,
          cwd: session.header.cwd ?? '',
          parentSession: session.header.parentSession,
          sourceId: this.id,
          sourceName: this.name,
          nodeKind: 'local',
        })
      }
      return options?.limit !== undefined && options.limit > 0 ? list.slice(0, options.limit) : list
    }

    const headers = await persistence.list()
    const summaries: SessionSummary[] = []

    for (const header of headers) {
      if (options?.cwd && header.cwd !== options.cwd) continue
      summaries.push({
        id: header.id,
        createdAt: header.createdAt,
        updatedAt: header.createdAt,
        cwd: header.cwd ?? '',
        parentSession: header.parentSession,
        sourceId: this.id,
        sourceName: this.name,
        nodeKind: 'local',
      })
    }

    summaries.sort((a, b) => b.createdAt - a.createdAt)
    if (options?.limit !== undefined && options.limit > 0) {
      return summaries.slice(0, options.limit)
    }
    return summaries
  }

  async getSession(id: SessionId): Promise<SessionInspectionResult | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence) {
      try {
        const inspection = await persistence.inspect(id)
        return {
          header: inspection.meta,
          events: inspection.events,
        }
      } catch {
        return undefined
      }
    }

    const sessions = this.ctx.get('sessions')
    if (sessions) {
      const live = sessions.get(id)
      if (live) {
        return {
          header: live.header,
          events: live.events,
        }
      }
    }

    return undefined
  }

  async searchSessions(filter: SessionSearchFilter): Promise<SessionSummary[]> {
    const all = await this.listSessions(filter.cwd !== undefined ? { cwd: filter.cwd } : undefined)
    if (!filter.query) return filter.limit !== undefined ? all.slice(0, filter.limit) : all
    const q = filter.query.toLowerCase()
    const matched = all.filter(s => (s.title ?? '').toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
    return filter.limit !== undefined ? matched.slice(0, filter.limit) : matched
  }

  subscribeEvents(
    sessionId: SessionId,
    onEvent: (event: SessionEvent) => void,
    fromSeq?: number,
  ): Promise<() => void> {
    const sessions = this.ctx.get('sessions')
    const live = sessions?.get(sessionId)
    if (live) {
      this.replayFrom(live, onEvent, fromSeq)
      return Promise.resolve(this.attachEventForwarding(sessionId, onEvent))
    }

    // A cold session owns no live event flow yet, but a subscriber must still
    // see the session the moment it activates (a resume republishes it): hold
    // the subscription open against that activation instead of ending it.
    let forwarding: (() => void) | undefined
    const stopWaiting = this.ctx.on('session/created', (session) => {
      if (session.id !== sessionId || forwarding !== undefined) return
      this.replayFrom(session, onEvent, fromSeq)
      forwarding = this.attachEventForwarding(sessionId, onEvent)
    })
    return Promise.resolve(() => {
      stopWaiting()
      forwarding?.()
    })
  }

  /** Replay a live session's already-appended events at or after `fromSeq`. */
  private replayFrom(
    live: { events: readonly SessionEvent[] },
    onEvent: (event: SessionEvent) => void,
    fromSeq?: number,
  ): void {
    if (fromSeq === undefined) return
    for (const ev of live.events) {
      if (ev.seq >= fromSeq) {
        onEvent(ev)
      }
    }
  }

  /** Forward this process's appended events for one session to a subscriber. */
  private attachEventForwarding(sessionId: SessionId, onEvent: (event: SessionEvent) => void): () => void {
    return this.ctx.on('session/event', (session, event) => {
      if (session.id === sessionId) {
        onEvent(event)
      }
    })
  }

  async renameSession(id: SessionId, title: string): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) return
    const inspection = await persistence.inspect(id)
    const lastEvent = inspection.events.at(-1)
    const nextSeq = lastEvent !== undefined ? lastEvent.seq + 1 : 0
    const titleEvent: SessionEvent = {
      type: 'session/title',
      seq: nextSeq,
      time: Date.now(),
      data: {
        title,
        messageSeqs: [],
        source: { kind: 'user' },
      },
    }
    await persistence.append(id, [titleEvent])
  }

  async forkSession(id: SessionId, targetCwd?: string): Promise<SessionId> {
    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) {
      throw new Error('cannot fork session: SessionPersistence is not configured')
    }

    const source = await persistence.inspect(id)
    const newId = SessionId(randomUUID())
    const resolvedCwd = targetCwd ?? source.meta.cwd
    const newHeader: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: newId,
      createdAt: Date.now(),
      ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
      parentSession: id,
      delegationDepth: (source.meta.delegationDepth ?? 0) + 1,
    }

    await persistence.create(newHeader)
    if (source.events.length > 0) {
      await persistence.append(newId, source.events)
    }

    return newId
  }
}
