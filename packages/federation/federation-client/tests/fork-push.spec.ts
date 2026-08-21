import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionSourcesService } from '@deepseek-ai/dsh-session-source'
import { FederationSessionSource } from '@deepseek-ai/dsh-session-source-federation'
import {
  executeForkToLocal,
  executePushToHub,
  FORK_TO_LOCAL_USAGE,
  parseForkToLocal,
  parsePushToHub,
  PUSH_TO_HUB_USAGE,
} from '../src/index.ts'

describe('fork_to_local and push_to_hub commands', () => {
  it('parses session id and optional cwd', () => {
    expect(parseForkToLocal('')).toBeUndefined()
    expect(parseForkToLocal('   ')).toBeUndefined()
    expect(parseForkToLocal('sess-1')).toEqual({ sessionId: 'sess-1' })
    expect(parseForkToLocal('  sess-1  /tmp/work  ')).toEqual({ sessionId: 'sess-1', cwd: '/tmp/work' })
    expect(parsePushToHub('')).toBeUndefined()
    expect(parsePushToHub('sess-2')).toBe('sess-2')
  })

  it('returns usage and missing-source errors', async () => {
    const ctx = new Context()
    const invocation = { rawInput: '', commandId: 'c1' } as never
    expect(await executeForkToLocal(ctx, invocation)).toEqual({
      kind: 'error',
      text: FORK_TO_LOCAL_USAGE,
    })
    expect(await executePushToHub(ctx, invocation)).toEqual({
      kind: 'error',
      text: PUSH_TO_HUB_USAGE,
    })
    expect(await executeForkToLocal(ctx, { rawInput: 'sess-1', commandId: 'c1' } as never)).toEqual({
      kind: 'error',
      text: 'no remote federation session source is mounted',
    })
    expect(await executePushToHub(ctx, { rawInput: 'sess-1', commandId: 'c1' } as never)).toEqual({
      kind: 'error',
      text: 'no remote federation session source is mounted',
    })
    await ctx.fiber.dispose()
  })

  it('forks and pushes through a registered federation session source', async () => {
    const ctx = new Context()
    new SessionSourcesService(ctx)
    const source = new FederationSessionSource({
      endpoint: 'ws://127.0.0.1:1',
      autoReconnect: false,
    }, ctx)
    source.forkSession = async (id, cwd) => {
      expect(id).toBe(SessionId('sess-1'))
      expect(cwd).toBe('/tmp/work')
      return SessionId('forked-1')
    }
    source.pushSession = async (id) => {
      expect(id).toBe(SessionId('sess-2'))
    }
    ctx.sessionSources.registerSource(source)
    const forked = await executeForkToLocal(ctx, { rawInput: 'sess-1 /tmp/work', commandId: 'c1' } as never)
    expect(forked.kind).toBe('success')
    if (forked.kind === 'success') {
      expect(forked.text).toContain('forked-1')
      expect(forked.text).toMatch(/not work continuity/)
    }
    expect(await executePushToHub(ctx, { rawInput: 'sess-2', commandId: 'c1' } as never)).toEqual({
      kind: 'success',
      text: 'Pushed sess-2 to hub. Session continuity is not work continuity.',
    })
    source.forkSession = async () => {
      throw new Error('fork failed')
    }
    source.pushSession = async () => {
      throw new Error('push failed')
    }
    expect(await executeForkToLocal(ctx, { rawInput: 'sess-1', commandId: 'c1' } as never)).toEqual({
      kind: 'error',
      text: 'fork failed',
    })
    expect(await executePushToHub(ctx, { rawInput: 'sess-2', commandId: 'c1' } as never)).toEqual({
      kind: 'error',
      text: 'push failed',
    })
    source.forkSession = async () => {
      throw 42
    }
    source.pushSession = async () => {
      throw 42
    }
    expect(await executeForkToLocal(ctx, { rawInput: 'sess-1', commandId: 'c1' } as never)).toEqual({
      kind: 'error',
      text: '42',
    })
    expect(await executePushToHub(ctx, { rawInput: 'sess-2', commandId: 'c1' } as never)).toEqual({
      kind: 'error',
      text: '42',
    })
    source.dispose()
    await ctx.fiber.dispose()
  })
})
