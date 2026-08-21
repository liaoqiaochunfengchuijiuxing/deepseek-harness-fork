import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import FederationSessionPersistence from '../src/index.ts'
import { oneTurnLog, meta, runPersistenceContract } from '../../../session/session-persistence/tests/contract.ts'

describe('FederationSessionPersistence', () => {
  const dirs: string[] = []
  let ctx: Context | undefined

  afterEach(async () => {
    if (ctx) {
      await ctx.fiber.dispose()
      ctx = undefined
    }
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function spoolDir(): Promise<string> {
    const spoolRoot = await mkdtemp(join(tmpdir(), 'dsh-fed-spool-'))
    dirs.push(spoolRoot)
    return spoolRoot
  }

  async function mounted(persistFn?: ReturnType<typeof vi.fn>): Promise<FederationSessionPersistence> {
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    if (persistFn) {
      ctx.provide('federationClient', {
        getStatus: () => 'connected',
        persistSession: persistFn,
        leaseSession: vi.fn(async () => ({ ok: true, holder: 'pod-1' })),
      })
    }
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    return ctx.sessionPersistence as FederationSessionPersistence
  }

  it('appends locally even when hub upload fails', async () => {
    const persistFn = vi.fn(async () => {
      throw new Error('hub down')
    })
    const persistence = await mounted(persistFn)
    const header = meta('sess-1', '/tmp/work')
    await persistence.create(header)
    const log = oneTurnLog()
    await persistence.append(header.id, log)
    const loaded = await persistence.load(header.id)
    expect(loaded.events).toHaveLength(log.length)
    await vi.waitFor(() => {
      expect(persistFn).toHaveBeenCalled()
    })
  })

  it('uploads events asynchronously after local durability', async () => {
    const persistFn = vi.fn(async (_id, events: SessionEvent[]) => ({
      ok: true as const,
      lastSeq: events[events.length - 1]?.seq ?? 0,
    }))
    const persistence = await mounted(persistFn)
    const header = meta('sess-2', '/tmp/work')
    await persistence.create(header)
    await persistence.append(header.id, oneTurnLog())
    await vi.waitFor(() => {
      expect(persistFn).toHaveBeenCalled()
    })
    const [, events, uploadedHeader] = persistFn.mock.calls[0] as [SessionId, SessionEvent[], SessionHeader]
    expect(events.length).toBeGreaterThan(0)
    expect(uploadedHeader.id).toBe(header.id)
  })

  it('does not fail append when the federation client is disconnected', async () => {
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('federationClient', {
      getStatus: () => 'disconnected',
      persistSession: vi.fn(),
      leaseSession: vi.fn(),
    })
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    const header = meta('sess-3', '/tmp/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(header.id)
    expect(loaded.events.length).toBe(oneTurnLog().length)
  })

  it('does not fail append when no federation client is mounted', async () => {
    const persistence = await mounted()
    const header = meta('sess-no-client', '/tmp/work')
    await persistence.create(header)
    await persistence.append(header.id, oneTurnLog())
    expect((await persistence.load(header.id)).events).toHaveLength(oneTurnLog().length)
  })

  it('retries unacked prefix after a failed upload', async () => {
    let calls = 0
    const persistFn = vi.fn(async (_id: SessionId, events: SessionEvent[]) => {
      calls += 1
      if (calls === 1) {
        return { ok: false as const, code: 'unavailable' as const, message: 'hub down' }
      }
      return { ok: true as const, lastSeq: events[events.length - 1]?.seq ?? 0 }
    })
    const persistence = await mounted(persistFn)
    const header = meta('sess-retry', '/tmp/work')
    await persistence.create(header)
    const log = oneTurnLog()
    await persistence.append(header.id, log.slice(0, 3))
    await vi.waitFor(() => {
      expect(persistFn).toHaveBeenCalledTimes(1)
    })
    await persistence.append(header.id, log.slice(3))
    await vi.waitFor(() => {
      expect(persistFn).toHaveBeenCalledTimes(2)
    })
    const second = persistFn.mock.calls[1] as [SessionId, SessionEvent[], SessionHeader?]
    expect(second[1][0]?.seq).toBe(0)
    expect(second[1]).toHaveLength(log.length)
  })

  it('uploads only unacked events after a successful ack', async () => {
    const persistFn = vi.fn(async (_id: SessionId, events: SessionEvent[]) => ({
      ok: true as const,
      lastSeq: events[events.length - 1]?.seq ?? 0,
    }))
    const persistence = await mounted(persistFn)
    const header = meta('sess-ack', '/tmp/work')
    const log = oneTurnLog()
    await persistence.create(header)
    await persistence.append(header.id, log.slice(0, 3))
    await vi.waitFor(() => {
      expect(persistFn).toHaveBeenCalledTimes(1)
    })
    await persistence.append(header.id, log.slice(3))
    await vi.waitFor(() => {
      expect(persistFn).toHaveBeenCalledTimes(2)
    })
    const second = persistFn.mock.calls[1] as [SessionId, SessionEvent[], SessionHeader?]
    expect(second[1][0]?.seq).toBe(3)
    expect(second[2]).toBeUndefined()
  })

  it('refuses takeover of an unknown required event type', () => {
    expect(() => {
      FederationSessionPersistence.assertTakeoverCompatible(
        [{ type: 'future/unknown', seq: 0, time: 1, data: {} } as SessionEvent],
        SESSION_FORMAT_VERSION,
      )
    }).toThrow(/unknown required event type/)
    expect(() => {
      FederationSessionPersistence.assertTakeoverCompatible(
        [{ type: 'future/unknown', seq: 0, time: 1, data: {}, ignorable: true } as SessionEvent],
        SESSION_FORMAT_VERSION,
      )
    }).not.toThrow()
    expect(() => {
      FederationSessionPersistence.assertTakeoverCompatible(
        oneTurnLog(),
        SESSION_FORMAT_VERSION + 1,
      )
    }).toThrow(/log format/)
    expect(() => {
      FederationSessionPersistence.assertTakeoverCompatible(oneTurnLog(), SESSION_FORMAT_VERSION)
    }).not.toThrow()
  })

  it('acquires a writer lease on prepare', async () => {
    const leaseSession = vi.fn(async () => ({ ok: true as const, holder: 'pod-1' }))
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('federationClient', {
      getStatus: () => 'connected',
      persistSession: vi.fn(async () => ({ ok: true, lastSeq: 0 })),
      leaseSession,
    })
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    const header = meta('sess-4', '/tmp/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const prep = await ctx.sessionPersistence.prepare(header.id)
    expect(leaseSession).toHaveBeenCalledWith('session/lease-acquire', header.id)
    prep[Symbol.dispose]()
  })

  it('rejects prepare when the lease is held elsewhere', async () => {
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('federationClient', {
      getStatus: () => 'connected',
      persistSession: vi.fn(async () => ({ ok: true, lastSeq: 0 })),
      leaseSession: vi.fn(async () => ({
        ok: false as const,
        code: 'stale-writer' as const,
        message: 'session sess-5 is leased to pod-other',
      })),
    })
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    const header = meta('sess-5', '/tmp/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    await expect(ctx.sessionPersistence.prepare(header.id)).rejects.toThrow(/leased to pod-other/)
  })

  it('skips lease acquire when the client is disconnected', async () => {
    const leaseSession = vi.fn()
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('federationClient', {
      getStatus: () => 'disconnected',
      persistSession: vi.fn(),
      leaseSession,
    })
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    const header = meta('sess-offline-prep', '/tmp/work')
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, oneTurnLog())
    const prep = await ctx.sessionPersistence.prepare(header.id)
    expect(leaseSession).not.toHaveBeenCalled()
    prep[Symbol.dispose]()
  })

  it('releases a writer lease through the federation client', async () => {
    const leaseSession = vi.fn(async () => ({ ok: true as const, holder: 'pod-1' }))
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('federationClient', {
      getStatus: () => 'connected',
      persistSession: vi.fn(async () => ({ ok: true, lastSeq: 0 })),
      leaseSession,
    })
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    const persistence = ctx.sessionPersistence as FederationSessionPersistence
    await persistence.releaseWriter(SessionId('sess-hand-off'))
    expect(leaseSession).toHaveBeenCalledWith('session/lease-release', SessionId('sess-hand-off'))
  })

  it('rejects releaseWriter when the hub refuses the release', async () => {
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('federationClient', {
      getStatus: () => 'connected',
      persistSession: vi.fn(),
      leaseSession: vi.fn(async () => ({
        ok: false as const,
        code: 'stale-writer' as const,
        message: 'leased to other',
      })),
    })
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    const persistence = ctx.sessionPersistence as FederationSessionPersistence
    await expect(persistence.releaseWriter(SessionId('sess-x'))).rejects.toThrow(/leased to other/)
  })

  it('no-ops releaseWriter when disconnected', async () => {
    const leaseSession = vi.fn()
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('federationClient', {
      getStatus: () => 'disconnected',
      persistSession: vi.fn(),
      leaseSession,
    })
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    await (ctx.sessionPersistence as FederationSessionPersistence).releaseWriter(SessionId('sess-x'))
    expect(leaseSession).not.toHaveBeenCalled()
  })

  it('lists, locates, and reloads spool files', async () => {
    const persistence = await mounted()
    const header = meta('sess-list', '/tmp/work')
    expect(persistence.locate(header)).toMatchObject({ kind: 'federation-spool' })
    await persistence.create(header)
    expect(await persistence.list()).toEqual([])
    await persistence.append(header.id, oneTurnLog())
    const listed = await persistence.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(header.id)
    const snapshots = await persistence.listSnapshots()
    expect(snapshots).toHaveLength(1)
    const suffix = await persistence.readFrom(header.id, 4)
    expect(suffix.events[0]?.seq).toBe(4)
    expect(await persistence.loadStored(SessionId('missing'))).toBeUndefined()
    expect(await persistence.readStoredRevision(SessionId('missing'))).toBeUndefined()

    const root = dirname(persistence.locate(header).path)
    await ctx!.fiber.dispose()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await writeFile(join(root, 'ignore.txt'), 'not a spool', 'utf8')
    await ctx.plugin(FederationSessionPersistence, { spoolRoot: root })
    const reloaded = await ctx.sessionPersistence.list()
    expect(reloaded.some(item => item.id === header.id)).toBe(true)
  })

  it('honors abort signals on list and stored reads', async () => {
    const persistence = await mounted()
    const header = meta('sess-abort', '/tmp/work')
    await persistence.create(header)
    await persistence.append(header.id, oneTurnLog())
    const signal = AbortSignal.abort(new Error('aborted'))
    await expect(persistence.list(signal)).rejects.toThrow(/aborted/)
    await expect(persistence.listSnapshots(signal)).rejects.toThrow(/aborted/)
    await expect(persistence.loadStored(header.id, signal)).rejects.toThrow(/aborted/)
    await expect(persistence.readStoredRevision(header.id, signal)).rejects.toThrow(/aborted/)
  })

  it('applies coordinator defaults when optional config is omitted', async () => {
    const spoolRoot = await spoolDir()
    ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = new FederationSessionPersistence(ctx, { spoolRoot })
    const header = meta('sess-defaults', '/tmp/work')
    await persistence.create(header)
    await persistence.append(header.id, oneTurnLog())
    expect((await persistence.load(header.id)).events).toHaveLength(oneTurnLog().length)
  })

  it('records a -1 revision for an empty spool entry', async () => {
    const persistence = await mounted()
    const header = meta('sess-empty-rev', '/tmp/work')
    await persistence.appendBatch(header, [], false)
    const snapshots = await persistence.listSnapshots()
    expect(snapshots[0]?.revision).toBeDefined()
  })

  it('rejects spool load when the root is not a directory', async () => {
    const spoolRoot = join(await spoolDir(), 'not-a-dir')
    await writeFile(spoolRoot, 'file', 'utf8')
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(FederationSessionPersistence, { spoolRoot })
    await expect(ctx.sessionPersistence.list()).rejects.toThrow()
    await expect(ctx.sessionPersistence.list()).rejects.toThrow()
  })

  it('skips upload after dispose and when there is nothing unacked', async () => {
    let release: ((value: { ok: true; lastSeq: number }) => void) | undefined
    const persistFn = vi.fn(() => new Promise<{ ok: true; lastSeq: number }>((resolve) => {
      release = resolve
    }))
    const persistence = await mounted(persistFn)
    const header = meta('sess-dispose', '/tmp/work')
    await persistence.create(header)
    await persistence.append(header.id, oneTurnLog())
    await ctx!.fiber.dispose()
    ctx = undefined
    release?.({ ok: true, lastSeq: 5 })
    await new Promise(r => setTimeout(r, 20))
    ;(persistence as unknown as { enqueueUpload: (id: SessionId) => void }).enqueueUpload(header.id)
    await new Promise(r => setTimeout(r, 20))
  })

  it('skips upload when the spool entry is missing or fully acked', async () => {
    const persistFn = vi.fn(async (_id: SessionId, events: SessionEvent[]) => ({
      ok: true as const,
      lastSeq: events[events.length - 1]?.seq ?? 0,
    }))
    const persistence = await mounted(persistFn)
    const header = meta('sess-acked', '/tmp/work')
    await persistence.create(header)
    await persistence.append(header.id, oneTurnLog())
    await vi.waitFor(() => {
      expect(persistFn).toHaveBeenCalledTimes(1)
    })
    const backend = persistence as unknown as { enqueueUpload: (id: SessionId) => void }
    backend.enqueueUpload(header.id)
    backend.enqueueUpload(SessionId('missing-upload'))
    await new Promise(r => setTimeout(r, 30))
    expect(persistFn).toHaveBeenCalledTimes(1)
  })

  it('no-ops releaseWriter without a federation client', async () => {
    const persistence = await mounted()
    await persistence.releaseWriter(SessionId('sess-x'))
  })

  it('rejects appendBatch for a missing materialized session and no-ops empty repair', async () => {
    const persistence = await mounted()
    const header = meta('sess-batch', '/tmp/work')
    await expect(persistence.appendBatch(header, oneTurnLog(), true))
      .rejects.toThrow(/is not materialized/)
    await persistence.commitRepair(header, undefined, [])
    await persistence.create(header)
    await persistence.append(header.id, oneTurnLog())
    await persistence.commitRepair(header, undefined, [])
    expect((await persistence.load(header.id)).events).toHaveLength(oneTurnLog().length)
  })
})

runPersistenceContract('federation-spool', async () => {
  const spoolRoot = await mkdtemp(join(tmpdir(), 'dsh-fed-contract-'))
  const c = new Context()
  await c.plugin(SessionStore)
  await c.plugin(FederationSessionPersistence, { spoolRoot })
  return {
    persistence: c.sessionPersistence,
    dispose: async () => {
      await c.fiber.dispose()
      await rm(spoolRoot, { recursive: true, force: true })
    },
  }
})
