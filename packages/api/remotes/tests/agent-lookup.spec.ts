import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { createApiRemoteAgentResolver, inspectApiRemoteSession } from '@deepseek-ai/dsh-api-remotes'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const sid = (value: string): SessionId => value as SessionId

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1, cwd: '/proj' }
}

async function createContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function provideSession(
  ctx: Context,
  meta: SessionHeader,
  inspect: () => Promise<{ meta: SessionHeader; events: SessionEvent[] }>,
): void {
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect,
    locate: () => undefined,
  } as never)
}

function stubAgent(ctx: Context, session: Session): Agent {
  return { id: session.id, session, status: 'idle', ctx } as Agent
}

describe('API Remote Agent resolver races', () => {
  it('maps an inspected session without a cwd to session-not-found', async () => {
    const ctx = await createContext()
    const sessionId = sid('missing-after-inspect')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => Promise.resolve({
      meta: { ...meta, cwd: undefined } as unknown as SessionHeader,
      events: [],
    }))

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'session-not-found', details: { sessionId } } })
    await ctx.fiber.dispose()
  })

  it('resumes through a concurrently attached ordinary Session without optional defaults', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-attach-race')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: sessionId })
    await ctx.fiber.dispose()
  })

  it('rejects a subagent Session published after durable inspection', async () => {
    const ctx = await createContext()
    const sessionId = sid('owned-attach-race')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => {
      ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reclassifies failed resumes after a live or attached subagent wins publication', async () => {
    for (const winner of ['agent', 'session'] as const) {
      const ctx = await createContext()
      const sessionId = sid(`owned-${winner}-resume-race`)
      const meta = header(sessionId)
      provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
      vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async () => {
        const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
        if (winner === 'agent') ctx.agents.register(stubAgent(ctx, session))
        throw new Error('session id already published')
      })

      const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

      expect(result).toMatchObject({ error: { code: 'agent-busy' } })
      await ctx.fiber.dispose()
    }
  })

  it('materializes a session-source session before cold resume for both remote shapes', async () => {
    const shapes = [
      { name: 'wrapped-with-id', wrap: true, sourceId: 'federation-hub' },
      { name: 'wrapped', wrap: true, sourceId: undefined },
      { name: 'bare', wrap: false, sourceId: undefined },
    ] as const
    for (const shape of shapes) {
      const ctx = await createContext()
      const sessionId = sid(`remote-source-${shape.name}`)
      const meta = header(sessionId)
      const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } }] as SessionEvent[]
      const created: SessionHeader[] = []
      const appended: SessionEvent[][] = []
      ctx.provide('sessionPersistence', {
        list: () => Promise.resolve([]),
        create: (candidate: SessionHeader) => { created.push(candidate); return Promise.resolve() },
        append: (_id: SessionId, batch: readonly SessionEvent[]) => {
          appended.push([...batch])
          return Promise.resolve()
        },
      } as never)
      ctx.provide('sessionSources', {
        getSession: () => Promise.resolve(shape.wrap
          ? { source: { id: shape.sourceId }, session: { header: meta, events } }
          : { header: meta, events }),
      } as never)
      let published: Session | undefined
      vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
        published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
        return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
      })

      const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

      expect(result).toMatchObject({ agent: { id: sessionId } })
      // A source that identifies itself stamps the materialized copy with its
      // id so later catch-ups read through it instead of the registry scan.
      expect(created).toEqual([shape.sourceId === undefined ? meta : { ...meta, remoteAuthority: shape.sourceId }])
      expect(appended).toEqual([events])
      await ctx.fiber.dispose()
    }
  })

  it('appends the remote suffix to an already-materialized stale copy', async () => {
    const ctx = await createContext()
    const sessionId = sid('stale-materialized')
    const meta = header(sessionId)
    const base = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 0, reason: 'success' } },
    ] as SessionEvent[]
    const growth = [{ type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } }] as SessionEvent[]
    const appended: SessionEvent[][] = []
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: base }),
      create: () => Promise.resolve(),
      append: (_id: SessionId, batch: readonly SessionEvent[]) => {
        appended.push([...batch])
        return Promise.resolve()
      },
    } as never)
    ctx.provide('sessionSources', {
      getSession: () => Promise.resolve({ source: {}, session: { header: meta, events: [...base, ...growth] } }),
    } as never)
    let published: Session | undefined
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect(appended).toEqual([growth])
    await ctx.fiber.dispose()
  })

  it('targets the stamped authority when resuming a stale materialized copy', async () => {
    const ctx = await createContext()
    const sessionId = sid('authority-resume')
    const meta = { ...header(sessionId), remoteAuthority: 'federation-hub' }
    const base = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 0, reason: 'success' } },
    ] as SessionEvent[]
    const growth = [{ type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } }] as SessionEvent[]
    const appended: SessionEvent[][] = []
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: base }),
      create: () => Promise.resolve(),
      append: (_id: SessionId, batch: readonly SessionEvent[]) => {
        appended.push([...batch])
        return Promise.resolve()
      },
    } as never)
    const getSession = vi.fn().mockResolvedValue({ source: { id: 'federation-hub' }, session: { header: meta, events: [...base, ...growth] } })
    ctx.provide('sessionSources', { getSession } as never)
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return { agent: stubAgent(ctx, session), dispose: () => Promise.resolve() }
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    // The catch-up asks the stamped source directly: the registry scan would
    // answer with the stale local copy through a registered local source.
    expect(getSession).toHaveBeenCalledWith(sessionId, 'federation-hub')
    expect(appended).toEqual([growth])
    await ctx.fiber.dispose()
  })

  it('catches a stamped copy up to its authority on a plain inspection read', async () => {
    const ctx = await createContext()
    const sessionId = sid('authority-inspect')
    const meta = { ...header(sessionId), remoteAuthority: 'federation-hub' }
    const base = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    ] as SessionEvent[]
    const growth = [{ type: 'turn/end', seq: 1, time: 2, data: { turn: 0, reason: 'success' } }] as SessionEvent[]
    let store = [...base]
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: store }),
      create: () => Promise.resolve(),
      append: (_id: SessionId, batch: readonly SessionEvent[]) => {
        store = [...store, ...batch]
        return Promise.resolve()
      },
    } as never)
    ctx.provide('sessionSources', {
      getSession: (id: SessionId, hint?: string) => Promise.resolve(hint === 'federation-hub' && id === sessionId
        ? { source: { id: 'federation-hub' }, session: { header: meta, events: [...base, ...growth] } }
        : undefined),
    } as never)

    const inspected = await inspectApiRemoteSession(ctx, sessionId)

    expect(inspected.events).toEqual([...base, ...growth])
    expect(store).toEqual([...base, ...growth])
    await ctx.fiber.dispose()
  })

  it('serves the stale stamped copy when the authority is unavailable', async () => {
    for (const mode of ['absent', 'throws'] as const) {
      const ctx = await createContext()
      const sessionId = sid(`authority-${mode}`)
      const meta = { ...header(sessionId), remoteAuthority: 'federation-hub' }
      const base = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } }] as SessionEvent[]
      const appended: SessionEvent[][] = []
      ctx.provide('sessionPersistence', {
        list: () => Promise.resolve([meta]),
        inspect: () => Promise.resolve({ meta, events: base }),
        create: () => Promise.resolve(),
        append: (_id: SessionId, batch: readonly SessionEvent[]) => {
          appended.push([...batch])
          return Promise.resolve()
        },
      } as never)
      ctx.provide('sessionSources', {
        getSession: () => mode === 'absent' ? Promise.resolve(undefined) : Promise.reject(new Error('hub unreachable')),
      } as never)

      const inspected = await inspectApiRemoteSession(ctx, sessionId)

      expect(inspected.events).toEqual(base)
      expect(appended).toEqual([])
      await ctx.fiber.dispose()
    }
  })

  it('leaves a diverged or current local copy untouched', async () => {
    const cases: readonly [name: string, remote: SessionEvent[]][] = [
      ['diverged', [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 9 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 9, reason: 'success' } },
        { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } },
      ] as SessionEvent[]],
      ['current', [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 0, reason: 'success' } },
      ] as SessionEvent[]],
    ]
    for (const [name, remoteEvents] of cases) {
      const ctx = await createContext()
      const sessionId = sid(`${name}-copy`)
      const meta = header(sessionId)
      const local = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 0, reason: 'success' } },
      ] as SessionEvent[]
      const appended: SessionEvent[][] = []
      ctx.provide('sessionPersistence', {
        list: () => Promise.resolve([meta]),
        inspect: () => Promise.resolve({ meta, events: local }),
        create: () => Promise.resolve(),
        append: (_id: SessionId, batch: readonly SessionEvent[]) => {
          appended.push([...batch])
          return Promise.resolve()
        },
      } as never)
      ctx.provide('sessionSources', {
        getSession: () => Promise.resolve({ source: {}, session: { header: meta, events: remoteEvents } }),
      } as never)
      vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
        const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
        return { agent: stubAgent(ctx, session), dispose: () => Promise.resolve() }
      })

      const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

      expect(result).toMatchObject({ agent: { id: sessionId } })
      expect(appended).toEqual([])
      await ctx.fiber.dispose()
    }
  })

  it('uses the shared cold-resume policy for the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-cold-resume')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const agentCtx = ctx.extend()
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(agentCtx, published), dispose: () => Promise.resolve() }
    })
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    await expect(provider.resolve(sessionId)).resolves.toBe(agentCtx)
    await ctx.fiber.dispose()
  })

  it('applies the subagent ownership fence to the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-owned-subagent')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
    ctx.agents.register(stubAgent(ctx.extend(), session))
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    const resolution = provider.resolve(sessionId)
    await expect(resolution).rejects.toBeInstanceOf(TypertLookupFailure)
    await expect(resolution).rejects.toMatchObject({ failure: { code: 'agent-busy' } })
    await ctx.fiber.dispose()
  })
})
