import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import InvariantsService from '@deepseek-ai/dsh-invariants'
import * as SessionSourcePlugin from '../src/index.ts'
import { SessionSourcesService, type SessionSource, type SessionSummary } from '../src/index.ts'

function createFakeSource(id: string, name: string, kind: 'local' | 'remote', sessions: SessionSummary[]): SessionSource {
  return {
    id,
    name,
    kind,
    capabilities: {
      canWrite: kind === 'local',
      canFork: true,
      canDelete: kind === 'local',
      canRename: true,
      canSearch: true,
    },
    listSessions: async () => sessions,
    getSession: async (sid) => {
      const match = sessions.find(s => s.id === sid)
      if (!match) return undefined
      const header: SessionHeader = {
        id: match.id,
        version: 0,
        createdAt: match.createdAt,
        cwd: match.cwd,
        delegationDepth: 0,
      }
      const events: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: match.createdAt, data: { turn: 1 } },
      ]
      return { header, events }
    },
    searchSessions: async (filter) => {
      if (!filter.query) return sessions
      const q = filter.query.toLowerCase()
      return sessions.filter(s => (s.title && s.title.toLowerCase().includes(q)) || s.cwd.toLowerCase().includes(q))
    },
    subscribeEvents: async (_sid, onEvent) => {
      onEvent({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } })
      return () => {}
    },
  }
}

describe('SessionSourcesService', () => {
  let ctx: Context
  let service: SessionSourcesService

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(InvariantsService)
    await ctx.plugin(SessionSourcePlugin)
    service = ctx.sessionSources
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it('registers and retrieves session sources', () => {
    const src1 = createFakeSource('local', 'Local Node', 'local', [])
    const dispose = service.registerSource(src1)

    expect(service.getSource('local')).toBe(src1)
    expect(service.listSources()).toHaveLength(1)

    // Cannot register duplicate id
    expect(() => service.registerSource(src1)).toThrow(/already registered/)

    dispose()
    expect(service.getSource('local')).toBeUndefined()
    expect(service.listSources()).toHaveLength(0)
  })

  it('aggregates sessions across multiple sources sorted by timestamp', async () => {
    const s1: SessionSummary = {
      id: SessionId('s1'),
      title: 'Fix issue',
      createdAt: 1000,
      updatedAt: 2000,
      cwd: '/workspace/app',
      sourceId: 'local',
    }
    const s2: SessionSummary = {
      id: SessionId('s2'),
      title: 'Run benchmarks',
      createdAt: 1500,
      updatedAt: 3000,
      cwd: '/workspace/bench',
      sourceId: 'hub',
    }
    const s3: SessionSummary = {
      id: SessionId('s3'),
      title: 'Deploy to cloud',
      createdAt: 500,
      updatedAt: 1000,
      cwd: '/workspace/cloud',
      sourceId: 'hub',
    }

    service.registerSource(createFakeSource('local', 'Local', 'local', [s1]))
    service.registerSource(createFakeSource('hub', 'Hub', 'remote', [s2, s3]))

    const all = await service.listAllSessions()
    expect(all).toHaveLength(3)
    // Ordered by updatedAt descending: s2 (3000), s1 (2000), s3 (1000)
    expect(all.map(s => s.id)).toEqual([SessionId('s2'), SessionId('s1'), SessionId('s3')])

    // Limit check
    const limited = await service.listAllSessions({ limit: 2 })
    expect(limited).toHaveLength(2)
    expect(limited.map(s => s.id)).toEqual([SessionId('s2'), SessionId('s1')])
  })

  it('searches and finds sessions across sources', async () => {
    const s1: SessionSummary = {
      id: SessionId('s1'),
      title: 'Frontend redesign',
      createdAt: 1000,
      updatedAt: 2000,
      cwd: '/web',
      sourceId: 'local',
    }
    const s2: SessionSummary = {
      id: SessionId('s2'),
      title: 'Backend API rewrite',
      createdAt: 1500,
      updatedAt: 3000,
      cwd: '/api',
      sourceId: 'hub',
    }

    service.registerSource(createFakeSource('local', 'Local', 'local', [s1]))
    service.registerSource(createFakeSource('hub', 'Hub', 'remote', [s2]))

    const searchResults = await service.searchAllSessions({ query: 'redesign' })
    expect(searchResults).toHaveLength(1)
    expect(searchResults[0]?.id).toBe(SessionId('s1'))

    const loaded = await service.getSession(SessionId('s2'))
    expect(loaded).toBeDefined()
    expect(loaded?.source.id).toBe('hub')
    expect(loaded?.session.header.id).toBe(SessionId('s2'))

    const notFound = await service.getSession(SessionId('s-non-existent'))
    expect(notFound).toBeUndefined()
  })

  it('subscribes to live events across sources', async () => {
    const s1: SessionSummary = {
      id: SessionId('s1'),
      createdAt: 1000,
      updatedAt: 2000,
      cwd: '/web',
      sourceId: 'local',
    }
    service.registerSource(createFakeSource('local', 'Local', 'local', [s1]))

    const events: SessionEvent[] = []
    const unsub = await service.subscribeEvents(SessionId('s1'), (e) => {
      events.push(e)
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('turn/start')
    unsub()
  })
})
