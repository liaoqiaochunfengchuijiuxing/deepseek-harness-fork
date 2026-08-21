import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantsService from '@deepseek-ai/dsh-invariants'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionPersistence, { type SessionInspection, type SessionLocation, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import * as SessionSourcePlugin from '@deepseek-ai/dsh-session-source'
import * as LocalSessionSourcePlugin from '../src/index.ts'
import { LocalSessionSource } from '../src/index.ts'

class MockSessionPersistence extends SessionPersistence {
  readonly supportsRawArtifacts = false
  private readonly stored = new Map<SessionId, { header: SessionHeader; events: SessionEvent[] }>()

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  async create(meta: SessionHeader): Promise<void> {
    this.stored.set(meta.id, { header: meta, events: [] })
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const s = this.stored.get(id)
    if (!s) throw new Error(`session ${id} not found`)
    s.events.push(...events)
  }

  async load(id: SessionId): Promise<SessionInspection> {
    const s = this.stored.get(id)
    if (!s) throw new Error(`session ${id} not found`)
    return { meta: s.header, events: s.events }
  }

  async inspect(id: SessionId): Promise<SessionInspection> {
    return this.load(id)
  }

  async readFrom(id: SessionId, fromSeq: number): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const s = this.stored.get(id)
    if (!s) throw new Error(`session ${id} not found`)
    return { meta: s.header, events: s.events.filter(e => e.seq >= fromSeq) }
  }

  async list(): Promise<SessionHeader[]> {
    return Array.from(this.stored.values()).map(s => s.header)
  }

  async listSnapshots(): Promise<SessionPersistenceSnapshot[]> {
    return Array.from(this.stored.values()).map(s => ({
      header: s.header,
      revision: 'rev-1' as never,
    }))
  }
}

describe('LocalSessionSource', () => {
  let ctx: Context
  let persistence: MockSessionPersistence

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(InvariantsService)
    persistence = new MockSessionPersistence(ctx)
    ctx.set('sessionPersistence', persistence)
    await ctx.plugin(SessionSourcePlugin)
    await ctx.plugin(LocalSessionSourcePlugin)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('registers local session source automatically on ctx.sessionSources', () => {
    const source = ctx.sessionSources.getSource('local')
    expect(source).toBeDefined()
    expect(source?.kind).toBe('local')
    expect(source?.capabilities.canWrite).toBe(true)
    expect(source?.capabilities.canFork).toBe(true)
  })

  it('lists and inspects sessions via local persistence', async () => {
    const h1: SessionHeader = {
      id: SessionId('local-s1'),
      version: SESSION_FORMAT_VERSION,
      createdAt: 1000,
      cwd: '/workspace/app',
      delegationDepth: 0,
    }
    const h2: SessionHeader = {
      id: SessionId('local-s2'),
      version: SESSION_FORMAT_VERSION,
      createdAt: 2000,
      cwd: '/workspace/other',
      delegationDepth: 0,
    }

    await persistence.create(h1)
    await persistence.create(h2)

    const list = await ctx.sessionSources.listAllSessions()
    expect(list).toHaveLength(2)
    expect(list[0]?.id).toBe(SessionId('local-s2'))
    expect(list[1]?.id).toBe(SessionId('local-s1'))

    // Filter by cwd
    const filtered = await ctx.sessionSources.listAllSessions({ cwd: '/workspace/app' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.id).toBe(SessionId('local-s1'))

    // Inspect session
    const inspected = await ctx.sessionSources.getSession(SessionId('local-s1'))
    expect(inspected).toBeDefined()
    expect(inspected?.source.id).toBe('local')
    expect(inspected?.session.header.cwd).toBe('/workspace/app')
  })

  it('renames and forks a session', async () => {
    const h1: SessionHeader = {
      id: SessionId('session-to-fork'),
      version: SESSION_FORMAT_VERSION,
      createdAt: 1000,
      cwd: '/workspace/app',
      delegationDepth: 0,
    }
    await persistence.create(h1)
    await persistence.append(SessionId('session-to-fork'), [
      { type: 'turn/start', seq: 0, time: 1001, data: { turn: 1 } },
    ])

    const localSource = ctx.sessionSources.getSource('local') as LocalSessionSource
    expect(localSource).toBeDefined()

    // Rename
    await localSource.renameSession(SessionId('session-to-fork'), 'New Title')
    const reloaded = await persistence.load(SessionId('session-to-fork'))
    expect(reloaded.events.some(e => e.type === 'session/title' && (e.data as { title: string }).title === 'New Title')).toBe(true)

    // Fork
    const forkedId = await localSource.forkSession(SessionId('session-to-fork'), '/workspace/forked')
    expect(forkedId).toBeDefined()
    expect(forkedId).not.toBe(SessionId('session-to-fork'))

    const forkedLoaded = await persistence.load(forkedId)
    expect(forkedLoaded.meta.parentSession).toBe(SessionId('session-to-fork'))
    expect(forkedLoaded.meta.cwd).toBe('/workspace/forked')
    expect(forkedLoaded.meta.delegationDepth).toBe(1)
    expect(forkedLoaded.events).toHaveLength(2) // turn/start + session/title
  })
})
