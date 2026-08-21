/**
 * Keyless M5 e2e: pod-to-pod subagent relay through the hub.
 * A remote provider with targetPodId must hit the named pod, not the first online one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubagentRuntime, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import InvariantsService from '@deepseek-ai/dsh-invariants'
import * as RemoteSubagentPlugin from '@deepseek-ai/dsh-subagent-remote'
import {
  FederationHubService,
  FederationHubServer,
} from '../src/index.ts'
import * as FederationClientPlugin from '../../federation-client/src/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

describe('Federation M5 peer relay e2e', () => {
  let hubCtx: Context | undefined
  let hubServer: FederationHubServer | undefined
  let hubService: FederationHubService | undefined
  let podA: Context | undefined
  let podB: Context | undefined
  let callerCtx: Context | undefined
  const token = 'm5-secret-token'

  afterEach(async () => {
    if (callerCtx) {
      await callerCtx.fiber.dispose()
      callerCtx = undefined
    }
    if (podA) {
      await podA.fiber.dispose()
      podA = undefined
    }
    if (podB) {
      await podB.fiber.dispose()
      podB = undefined
    }
    if (hubServer) {
      await hubServer.stop()
      hubServer = undefined
    }
    if (hubCtx) {
      await hubCtx.fiber.dispose()
      hubCtx = undefined
    }
    hubService = undefined
  })

  it('delegates to the named peer pod and not the first online pod', async () => {
    hubCtx = new Context()
    hubService = new FederationHubService(hubCtx)
    hubServer = new FederationHubServer(hubService, {
      port: 0,
      host: '127.0.0.1',
      token,
    })
    await hubServer.start()
    const hubPort = hubServer.getPort()

    const executed: string[] = []
    podA = new Context()
    await podA.plugin(InvariantsService)
    await podA.plugin(FederationClientPlugin, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId: 'pod-a',
      name: 'Pod A',
      token,
      executor: async (req, _onChunk) => {
        executed.push('pod-a')
        return {
          type: 'subagent/stop',
          id: req.id,
          output: [{ type: 'text', text: 'from A' }],
          stopReason: 'completed',
        }
      },
    })
    podB = new Context()
    await podB.plugin(InvariantsService)
    await podB.plugin(FederationClientPlugin, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId: 'pod-b',
      name: 'Pod B',
      token,
      executor: async (req, onChunk) => {
        executed.push('pod-b')
        onChunk('chunk-b')
        return {
          type: 'subagent/stop',
          id: req.id,
          output: [{ type: 'text', text: 'from B' }],
          stopReason: 'completed',
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        }
      },
    })

    await vi.waitFor(() => {
      expect(hubService!.getPod('pod-a')?.status).toBe('online')
      expect(hubService!.getPod('pod-b')?.status).toBe('online')
    })

    callerCtx = new Context()
    await callerCtx.plugin(InvariantsService)
    await callerCtx.plugin(SubagentRuntime)
    await callerCtx.plugin(RemoteSubagentPlugin, {
      providerName: 'peer-b',
      endpoint: `ws://127.0.0.1:${hubPort}/federation/subagent`,
      token,
      targetPodId: 'pod-b',
    })

    const run: SubagentRun = await callerCtx.subagents.start('peer-b', {
      prompt: [{ type: 'text', text: 'run on B' }],
      signal: new AbortController().signal,
      parent: { session: { header: { cwd: process.cwd() } } } as unknown as Agent,
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output[0]).toEqual({ type: 'text', text: 'from B' })
    expect(executed).toEqual(['pod-b'])
  })
})
