import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantsService from '@deepseek-ai/dsh-invariants'
import SessionStore, {
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

  it('applies list limits, inspect failures, empty-event rename, and fork defaults', async () => {
    const h1: SessionHeader = {
      id: SessionId('limit-a'),
      version: SESSION_FORMAT_VERSION,
      createdAt: 1000,
      cwd: '/workspace/app',
      delegationDepth: 0,
    }
    const h2: SessionHeader = {
      id: SessionId('limit-b'),
      version: SESSION_FORMAT_VERSION,
      createdAt: 2000,
      cwd: '/workspace/app',
      delegationDepth: 0,
    }
    const untitled: SessionHeader = {
      id: SessionId('no-cwd'),
      version: SESSION_FORMAT_VERSION,
      createdAt: 1500,
      delegationDepth: 0,
    }
    await persistence.create(h1)
    await persistence.create(h2)
    await persistence.create(untitled)

    const limited = await ctx.sessionSources.listAllSessions({ cwd: '/workspace/app', limit: 1 })
    expect(limited).toHaveLength(1)
    expect(limited[0]?.id).toBe(SessionId('limit-b'))

    const queried = await ctx.sessionSources.searchAllSessions({ query: 'workspace/app', limit: 1 })
    expect(queried).toHaveLength(1)

    const noQueryLimited = await ctx.sessionSources.searchAllSessions({ limit: 1 })
    expect(noQueryLimited).toHaveLength(1)

    const localSource = ctx.sessionSources.getSource('local') as LocalSessionSource
    expect(await localSource.getSession(SessionId('absent-session'))).toBeUndefined()

    await localSource.renameSession(SessionId('no-cwd'), 'Untitled')
    const renamed = await persistence.load(SessionId('no-cwd'))
    expect(renamed.events.some(e => e.type === 'session/title')).toBe(true)

    const forkedId = await localSource.forkSession(SessionId('no-cwd'))
    const forked = await persistence.load(forkedId)
    expect(forked.meta.parentSession).toBe(SessionId('no-cwd'))
    expect(forked.meta.cwd).toBeUndefined()
    expect(forked.events.length).toBeGreaterThan(0)

    const emptyId = SessionId('empty-fork')
    await persistence.create({
      id: emptyId,
      version: SESSION_FORMAT_VERSION,
      createdAt: 3000,
      cwd: '/workspace/app',
    })
    const emptyFork = await localSource.forkSession(emptyId, '/workspace/forked')
    expect((await persistence.load(emptyFork)).events).toHaveLength(0)
  })
})

describe('LocalSessionSource live session store', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(InvariantsService)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionSourcePlugin)
    await ctx.plugin(LocalSessionSourcePlugin)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('lists, inspects, searches, and subscribes without persistence', async () => {
    ctx.sessions.create(SessionId('no-cwd-live'))
    const session = ctx.sessions.create(SessionId('live-s1'), {
      meta: { cwd: process.cwd() },
    })

    const list = await ctx.sessionSources.listAllSessions()
    expect(list.some(s => s.id === session.id)).toBe(true)
    expect(list.find(s => s.id === session.id)?.cwd).toBe(process.cwd())

    const filtered = await ctx.sessionSources.listAllSessions({ cwd: process.cwd() })
    expect(filtered.some(s => s.id === session.id)).toBe(true)

    const inspected = await ctx.sessionSources.getSession(session.id)
    expect(inspected?.source.id).toBe('local')
    expect(inspected?.session.header.id).toBe(session.id)
    expect(await ctx.sessionSources.getSession(SessionId('missing-live'))).toBeUndefined()

    const searched = await ctx.sessionSources.searchAllSessions({ cwd: process.cwd() })
    expect(searched.some(s => s.id === session.id)).toBe(true)

    const received: string[] = []
    const unsubscribe = await ctx.sessionSources.subscribeEvents(session.id, (event) => {
      received.push(event.type)
    })
    session.append('turn/start', { turn: 1 })
    expect(received).toContain('turn/start')
    unsubscribe()

    const replayed: string[] = []
    const stopReplay = await ctx.sessionSources.subscribeEvents(session.id, (event) => {
      replayed.push(event.type)
    }, 0)
    expect(replayed.length).toBeGreaterThan(0)
    stopReplay()

    const missing = await ctx.sessionSources.subscribeEvents(SessionId('no-such-session'), () => {})
    missing()

    const localSource = ctx.sessionSources.getSource('local') as LocalSessionSource
    await localSource.renameSession(session.id, 'ignored-without-persistence')
    await expect(localSource.forkSession(session.id)).rejects.toThrow('SessionPersistence is not configured')

    ctx.sessions.create(SessionId('live-s2'), { meta: { cwd: process.cwd() } })
    const limited = await ctx.sessionSources.listAllSessions({ limit: 1 })
    expect(limited).toHaveLength(1)

    const cwdMiss = await ctx.sessionSources.listAllSessions({ cwd: '/no/such/cwd' })
    expect(cwdMiss).toEqual([])

    const queried = await ctx.sessionSources.searchAllSessions({
      query: process.cwd(),
      limit: 1,
    })
    expect(queried.length).toBeLessThanOrEqual(1)
    const queriedAll = await ctx.sessionSources.searchAllSessions({ query: process.cwd() })
    expect(queriedAll.length).toBeGreaterThan(0)

    const localLive = ctx.sessionSources.getSource('local') as LocalSessionSource
    const stopMissing = await localLive.subscribeEvents(SessionId('missing-live'), () => {})
    stopMissing()

    const other = ctx.sessions.create(SessionId('live-other'), { meta: { cwd: process.cwd() } })
    const skipped: string[] = []
    const stopSkip = await ctx.sessionSources.subscribeEvents(session.id, (event) => {
      skipped.push(event.type)
    }, 10_000)
    expect(skipped).toEqual([])
    other.append('turn/start', { turn: 1 })
    expect(skipped).toEqual([])
    stopSkip()
  })

  it('holds a cold-session subscription open and activates on publication, replaying from fromSeq', async () => {
    // Directly on the source: the aggregate's scan probes ownership through
    // getSession, which needs persistence to resolve a cold session — the
    // activation contract under test is the source's own.
    const localSource = ctx.sessionSources.getSource('local') as LocalSessionSource
    const received: string[] = []
    const unsubscribe = await localSource.subscribeEvents(SessionId('cold-activate'), (event) => {
      received.push(event.type)
    }, 0)

    // Nothing arrives while the session stays cold.
    await Promise.resolve()
    expect(received).toEqual([])

    // Publication (a resume republishes the session) activates the held
    // subscription: the fromSeq replay plus every later append flows.
    const session = ctx.sessions.create(SessionId('cold-activate'), { meta: { cwd: process.cwd() } })
    session.append('turn/start', { turn: 1 })
    expect(received).toContain('turn/start')

    unsubscribe()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(received).not.toContain('turn/end')

    // A subscription disposed while still cold never activates later.
    const dropped: string[] = []
    const unsubscribeCold = await localSource.subscribeEvents(SessionId('never-activates'), (event) => {
      dropped.push(event.type)
    }, 0)
    unsubscribeCold()
    ctx.sessions.create(SessionId('never-activates'), { meta: { cwd: process.cwd() } })
    expect(dropped).toEqual([])
  })

  it('returns empty results when no session store is mounted', async () => {
    const empty = new Context()
    await empty.plugin(InvariantsService)
    await empty.plugin(SessionSourcePlugin)
    await empty.plugin(LocalSessionSourcePlugin)
    expect(await empty.sessionSources.listAllSessions()).toEqual([])
    expect(await empty.sessionSources.getSession(SessionId('missing'))).toBeUndefined()
    const stop = await empty.sessionSources.subscribeEvents(SessionId('missing'), () => {})
    stop()
    await empty.fiber.dispose()
  })
})
