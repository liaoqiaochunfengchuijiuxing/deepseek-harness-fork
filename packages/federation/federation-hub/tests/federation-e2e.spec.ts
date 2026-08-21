import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentRuntime, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import InvariantsService from '@deepseek-ai/dsh-invariants'
import * as RemoteSubagentPlugin from '@deepseek-ai/dsh-subagent-remote'
import {
  FederationHubService,
  FederationHubServer,
  type PodInfo,
} from '../src/index.ts'
import * as FederationClientPlugin from '../../federation-client/src/index.ts'
import { FederationPodClient } from '../../federation-client/src/index.ts'

describe('Federation Cross-Node End-to-End (M1)', () => {
  let hubCtx: Context
  let hubService: FederationHubService
  let hubServer: FederationHubServer
  let hubPort: number
  const hubToken = 'federation-cluster-secret'

  beforeEach(async () => {
    hubCtx = new Context()
    await hubCtx.plugin(InvariantsService)
    hubService = new FederationHubService(hubCtx)
    hubServer = new FederationHubServer(hubService, {
      port: 0,
      host: '127.0.0.1',
      path: '/federation/connect',
      subagentPath: '/federation/subagent',
      token: hubToken,
      heartbeatTimeoutMs: 1000,
    })
    await hubServer.start()
    hubPort = hubServer.getPort()
  })

  afterEach(async () => {
    await hubServer.stop()
    await hubCtx.fiber.dispose()
  })

  it('connects multiple pods, discovers live presence, delegates tasks, and recovers from disconnect', async () => {
    // 1. Start Pod 1 (MacBook Pro)
    const pod1Ctx = new Context()
    await pod1Ctx.plugin(InvariantsService)
    await pod1Ctx.plugin(FederationClientPlugin, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId: 'pod-mac-1',
      name: 'MacBook Pro',
      token: hubToken,
      heartbeatIntervalMs: 100,
      workspaces: [process.cwd()],
      tools: ['bash', 'fs'],
      executor: async (req, onChunk, _signal) => {
        onChunk('compiling...')
        onChunk('done.')
        return {
          type: 'subagent/stop',
          id: req.id,
          output: [{ type: 'text', text: `Result from ${req.prompt[0]?.type === 'text' ? req.prompt[0].text : 'task'}` }],
          stopReason: 'completed',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        }
      },
    })

    // 2. Start Pod 2 (Linux Compute Server)
    const pod2Ctx = new Context()
    await pod2Ctx.plugin(InvariantsService)
    await pod2Ctx.plugin(FederationClientPlugin, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId: 'pod-linux-compute',
      name: 'Linux Compute',
      token: hubToken,
      heartbeatIntervalMs: 100,
      workspaces: ['/data/projects'],
      tools: ['bash', 'python'],
    })

    // Wait for both pods to appear in Hub registry with 'online' status
    await vi.waitFor(() => {
      const pods = hubService.listPods()
      expect(pods).toHaveLength(2)
      expect(pods.find((p: PodInfo) => p.podId === 'pod-mac-1')?.status).toBe('online')
      expect(pods.find((p: PodInfo) => p.podId === 'pod-linux-compute')?.status).toBe('online')
    })

    // Verify capability records on Hub
    const macPod = hubService.getPod('pod-mac-1')
    expect(macPod?.name).toBe('MacBook Pro')
    expect(macPod?.capabilities.workspaces).toEqual([process.cwd()])
    expect(macPod?.capabilities.tools).toEqual(['bash', 'fs'])

    // 3. Mount Subagent caller with subagent-remote provider pointing to Hub subagent endpoint
    const callerCtx = new Context()
    await callerCtx.plugin(InvariantsService)
    await callerCtx.plugin(SubagentRuntime)
    await callerCtx.plugin(RemoteSubagentPlugin, {
      providerName: 'remote',
      endpoint: `ws://127.0.0.1:${hubPort}/federation/subagent`,
      token: hubToken,
    })

    const abortCtrl = new AbortController()

    // 4. Delegate task through remote provider
    const run: SubagentRun = await callerCtx.subagents.start('remote', {
      prompt: [{ type: 'text', text: 'Build production artifacts' }],
      signal: abortCtrl.signal,
      parent: { session: { header: { cwd: process.cwd() } } } as unknown as Agent,
    })

    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output[0]).toEqual({ type: 'text', text: 'Result from Build production artifacts' })

    // 5. Verify mid-run disconnect handling
    await pod1Ctx.fiber.dispose()
    await pod2Ctx.fiber.dispose()

    await vi.waitFor(() => {
      expect(hubService.listPods().filter((p: PodInfo) => p.status === 'online')).toHaveLength(0)
    })

    let inFlightTaskStarted = false
    const podLongTaskCtx = new Context()
    await podLongTaskCtx.plugin(InvariantsService)
    const longTaskClient = new FederationPodClient(podLongTaskCtx, {
      endpoint: `ws://127.0.0.1:${hubPort}/federation/connect`,
      podId: 'pod-disconnect-test',
      name: 'Flaky Pod',
      token: hubToken,
      workspaces: [process.cwd()],
      executor: async (_req, _onChunk, signal) => {
        inFlightTaskStarted = true
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        })
      },
    })
    longTaskClient.start()

    await vi.waitFor(() => {
      expect(hubService.getPod('pod-disconnect-test')?.status).toBe('online')
    })

    // Launch task targeting flaky pod
    const flakyRun = await callerCtx.subagents.start('remote', {
      prompt: [{ type: 'text', text: 'Long task' }],
      signal: new AbortController().signal,
      parent: { session: { header: { cwd: process.cwd() } } } as unknown as Agent,
    })

    await vi.waitFor(() => {
      expect(inFlightTaskStarted).toBe(true)
    })

    // Abruptly dispose the pod client to simulate socket drop
    longTaskClient.dispose()
    await podLongTaskCtx.fiber.dispose()

    // Hub marks pod offline and terminates in-flight task with error
    const flakyResult = await flakyRun.result
    expect(flakyResult.stopReason).toBe('error')

    // Clean up
    await callerCtx.fiber.dispose()
  })
})
