/**
 * Unit and integration tests for @deepseek-ai/dsh-subagent-remote.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer, type RawData } from 'ws'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { CallId } from '@deepseek-ai/dsh-llm'
import CredentialProvider from '@deepseek-ai/dsh-credentials'
import * as remotePlugin from '../src/index.ts'
import {
  normalizeWsEndpoint,
  rawDataToString,
  remoteStopReason,
  startRemoteRun,
  type RemoteRunSpec,
} from '../src/run.ts'
import type { RemoteSubagentClientMessage, RemoteSubagentServerMessage } from '../src/types.ts'

/** Stub parent agent providing session header cwd. */
const fakeParent = { id: 'parent-1', session: { header: { cwd: process.cwd() } } } as unknown as Agent

function makeRequest(text = 'task prompt', signal = new AbortController().signal) {
  return {
    label: text,
    prompt: [{ type: 'text' as const, text }],
    parent: fakeParent,
    signal,
  }
}

function extractText(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Helper to create a local mock WebSocket server on an ephemeral port. */
function createMockServer(): Promise<{
  server: WebSocketServer
  endpoint: string
  close: () => Promise<void>
}> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 }, () => {
      const port = (server.address() as AddressInfo).port
      const endpoint = `ws://127.0.0.1:${port}`
      resolve({
        server,
        endpoint,
        close: () => new Promise<void>((res) => {
          for (const client of server.clients) {
            client.terminate()
          }
          server.close(() => { res() })
        }),
      })
    })
  })
}

describe('remoteStopReason', () => {
  it('maps each remote stop reason to the harness vocabulary', () => {
    expect(remoteStopReason('completed')).toBe('completed')
    expect(remoteStopReason('max-tokens')).toBe('max-tokens')
    expect(remoteStopReason('aborted')).toBe('aborted')
    expect(remoteStopReason('error')).toBe('error')
    expect(remoteStopReason(undefined)).toBe('error')
    expect(remoteStopReason('unknown-reason')).toBe('error')
  })
})

describe('normalizeWsEndpoint', () => {
  it('converts http and https URLs to ws and wss', () => {
    expect(normalizeWsEndpoint('http://127.0.0.1:3000/subagent')).toBe('ws://127.0.0.1:3000/subagent')
    expect(normalizeWsEndpoint('https://example.com/api/subagent')).toBe('wss://example.com/api/subagent')
    expect(normalizeWsEndpoint('ws://127.0.0.1:3080')).toBe('ws://127.0.0.1:3080')
    expect(normalizeWsEndpoint('wss://example.com/ws')).toBe('wss://example.com/ws')
  })
})

describe('dsh-subagent-remote provider integration', () => {
  it('runs a subagent delegation end-to-end over WebSocket', async () => {
    const mock = await createMockServer()
    let receivedAuth: string | undefined
    let receivedStart: RemoteSubagentClientMessage | undefined

    mock.server.on('connection', (socket, req) => {
      receivedAuth = req.headers.authorization
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          receivedStart = msg
          const chunk: RemoteSubagentServerMessage = {
            type: 'subagent/chunk',
            id: msg.id,
            delta: 'hello from ',
          }
          socket.send(JSON.stringify(chunk))
          const stop: RemoteSubagentServerMessage = {
            type: 'subagent/stop',
            id: msg.id,
            output: [{ type: 'text', text: 'hello from remote pod' }],
            stopReason: 'completed',
            usage: { totalTokens: 42 },
          }
          socket.send(JSON.stringify(stop))
        }
      })
    })

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, {
        providerName: 'remote-test',
        endpoint: mock.endpoint,
        token: 'secret-token-123',
      })

      const provider = ctx.subagents.getProvider('remote-test')
      expect(provider).toBeDefined()
      expect(provider?.capabilities).toEqual({
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      })
      expect(provider?.inheritsParentContext).toBe(false)

      const run = await ctx.subagents.start('remote-test', makeRequest('do task A'))
      expect(run.localAgent).toBeUndefined()
      expect(typeof run.id).toBe('string')

      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(extractText(result.output)).toBe('hello from remote pod')
      expect(receivedAuth).toBe('Bearer secret-token-123')
      expect(receivedStart).toMatchObject({
        type: 'subagent/start',
        label: 'do task A',
        cwd: process.cwd(),
      })

      const disposal = run.dispose()
      expect(run.dispose()).toBe(disposal)
      await disposal

      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('accumulates streamed chunks when output in stop message is omitted or empty', async () => {
    const mock = await createMockServer()

    mock.server.on('connection', (socket) => {
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          const chunk1: RemoteSubagentServerMessage = {
            type: 'subagent/chunk',
            id: msg.id,
            delta: 'part 1, ',
          }
          const chunk2: RemoteSubagentServerMessage = {
            type: 'subagent/chunk',
            id: msg.id,
            delta: 'part 2',
          }
          const stop: RemoteSubagentServerMessage = {
            type: 'subagent/stop',
            id: msg.id,
            output: [],
            stopReason: 'completed',
          }
          socket.send(JSON.stringify(chunk1))
          socket.send(JSON.stringify(chunk2))
          socket.send(JSON.stringify(stop))
        }
      })
    })

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, {
        endpoint: mock.endpoint,
      })

      const run = await ctx.subagents.start('remote', makeRequest('streaming task'))
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(extractText(result.output)).toBe('part 1, part 2')
      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('maps max-tokens, aborted, and error stop reasons from remote', async () => {
    const mock = await createMockServer()

    mock.server.on('connection', (socket) => {
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          const reason = msg.label as 'max-tokens' | 'aborted' | 'error'
          const stop: RemoteSubagentServerMessage = {
            type: 'subagent/stop',
            id: msg.id,
            output: [{ type: 'text', text: `stopped with ${reason}` }],
            stopReason: reason,
            ...reason === 'error' ? { diagnostic: 'remote execution failed' } : {},
          }
          socket.send(JSON.stringify(stop))
        }
      })
    })

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, { endpoint: mock.endpoint })

      for (const reason of ['max-tokens', 'aborted', 'error'] as const) {
        const run = await ctx.subagents.start('remote', makeRequest(reason))
        const result = await run.result
        expect(result.stopReason).toBe(reason)
        if (reason === 'error') {
          expect(result.diagnostic).toBe('remote execution failed')
        }
        await run.dispose()
      }
      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('handles subagent/error message from remote server', async () => {
    const mock = await createMockServer()

    mock.server.on('connection', (socket) => {
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          const errMsg: RemoteSubagentServerMessage = {
            type: 'subagent/error',
            id: msg.id,
            error: { message: 'pod internal error', code: 'INTERNAL_ERROR' },
          }
          socket.send(JSON.stringify(errMsg))
        }
      })
    })

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, { endpoint: mock.endpoint })

      const run = await ctx.subagents.start('remote', makeRequest())
      const result = await run.result
      expect(result.stopReason).toBe('error')
      expect(result.diagnostic).toBe('pod internal error')
      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('settles result with stopReason error when socket drops abruptly mid-flight', async () => {
    const mock = await createMockServer()

    mock.server.on('connection', (socket) => {
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          const chunk: RemoteSubagentServerMessage = {
            type: 'subagent/chunk',
            id: msg.id,
            delta: 'partial text before drop',
          }
          socket.send(JSON.stringify(chunk))
          socket.terminate()
        }
      })
    })

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, { endpoint: mock.endpoint })

      const run = await ctx.subagents.start('remote', makeRequest())
      const result = await run.result
      expect(result.stopReason).toBe('error')
      expect(extractText(result.output)).toBe('partial text before drop')
      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('rejects start before publishing when endpoint is unreachable', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(remotePlugin, {
      endpoint: 'ws://127.0.0.1:59999',
      connectTimeoutMs: 1000,
    })

    await expect(ctx.subagents.start('remote', makeRequest()))
      .rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects start when connection times out', async () => {
    const hangingServer = http.createServer((_req, _res) => {
      // Ignore upgrade requests so WebSocket connection handshake times out
    })
    await new Promise<void>((res) => { hangingServer.listen(0, '127.0.0.1', () => { res() }) })
    const port = (hangingServer.address() as AddressInfo).port
    const endpoint = `ws://127.0.0.1:${port}`

    try {
      const spec: RemoteRunSpec = {
        endpoint,
        cwd: process.cwd(),
        connectTimeoutMs: 50,
      }
      await expect(startRemoteRun(makeRequest(), spec)).rejects.toThrow(/timed out/)
    } finally {
      await new Promise<void>((res) => { hangingServer.close(() => { res() }) })
    }
  })

  it('rejects start immediately without connecting when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const spec: RemoteRunSpec = {
      endpoint: 'ws://127.0.0.1:12345',
      cwd: process.cwd(),
      connectTimeoutMs: 1000,
    }

    await expect(startRemoteRun(makeRequest('prompt', controller.signal), spec))
      .rejects.toThrow('aborted before remote subagent started')
  })

  it('sends subagent/abort message when signal aborts mid-run and settles aborted', async () => {
    const mock = await createMockServer()
    let onAbortReceived!: () => void
    const abortReceived = new Promise<void>((resolve) => { onAbortReceived = resolve })

    mock.server.on('connection', (socket) => {
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/abort') {
          onAbortReceived()
        }
      })
    })

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, { endpoint: mock.endpoint })

      const controller = new AbortController()
      const run = await ctx.subagents.start('remote', makeRequest('long task', controller.signal))

      controller.abort('user cancel')
      const result = await run.result
      expect(result.stopReason).toBe('aborted')
      await abortReceived

      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('dispose settles in-flight run as aborted and closes socket', async () => {
    const mock = await createMockServer()

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, { endpoint: mock.endpoint })

      const run = await ctx.subagents.start('remote', makeRequest('hanging task'))
      await run.dispose()
      const result = await run.result
      expect(result.stopReason).toBe('aborted')

      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('routes provider-level onError through ctx.logger.warn', async () => {
    const mock = await createMockServer()
    mock.server.on('connection', (socket) => {
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          socket.close(4001, 'simulated provider failure')
        }
      })
    })

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      const warnings: string[] = []
      ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn

      await ctx.plugin(remotePlugin, { endpoint: mock.endpoint })

      const run = await ctx.subagents.start('remote', makeRequest())
      const result = await run.result
      expect(result.stopReason).toBe('error')
      expect(warnings.some(w => w.includes('subagent-remote "remote": child run failed (error)'))).toBe(true)

      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('delegates through dsh-tool-subagent to remote provider over WebSocket', async () => {
    const mock = await createMockServer()
    mock.server.on('connection', (socket) => {
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          const stop: RemoteSubagentServerMessage = {
            type: 'subagent/stop',
            id: msg.id,
            output: [{ type: 'text', text: 'answer from remote tool execution' }],
            stopReason: 'completed',
          }
          socket.send(JSON.stringify(stop))
        }
      })
    })

    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, {
        providerName: 'remote',
        endpoint: mock.endpoint,
      })
      await ctx.plugin(subagentTool, {
        provider: 'remote',
        maxDepth: 'provider-managed',
      })

      const toolResult = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('call-remote-1'),
        name: 'subagent',
        arguments: {
          description: 'run research on pod',
          prompt: 'investigate performance',
        },
        agent: fakeParent,
      })

      expect(toolResult.isError).toBe(false)
      const text = toolResult.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
      expect(text).toBe('answer from remote tool execution')

      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })
})

describe('authentication and credential resolution', () => {
  it('resolves token from ctx.credentials when tokenEnv is configured', async () => {
    const mock = await createMockServer()
    let seenAuth: string | undefined

    mock.server.on('connection', (socket, req) => {
      seenAuth = req.headers.authorization
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          const stop: RemoteSubagentServerMessage = {
            type: 'subagent/stop',
            id: msg.id,
            output: [{ type: 'text', text: 'auth ok' }],
            stopReason: 'completed',
          }
          socket.send(JSON.stringify(stop))
        }
      })
    })

    class MockCredentialProvider extends CredentialProvider {
      async resolve(ref: string) {
        if (ref === 'DSH_REMOTE_TOKEN') return { value: 'resolved-vault-secret', source: 'test' }
        return undefined
      }
      async describe() { return { configured: true, writable: false } }
      async set() {}
      async unset() {}
    }

    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      ctx.plugin(MockCredentialProvider)
      await ctx.plugin(remotePlugin, {
        endpoint: mock.endpoint,
        tokenEnv: 'DSH_REMOTE_TOKEN',
      })

      const run = await ctx.subagents.start('remote', makeRequest())
      await run.result
      expect(seenAuth).toBe('Bearer resolved-vault-secret')

      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      await mock.close()
    }
  })

  it('resolves token from ambient launch environment when credentials service is absent', async () => {
    const mock = await createMockServer()
    let seenAuth: string | undefined

    mock.server.on('connection', (socket, req) => {
      seenAuth = req.headers.authorization
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          const stop: RemoteSubagentServerMessage = {
            type: 'subagent/stop',
            id: msg.id,
            output: [{ type: 'text', text: 'ok' }],
            stopReason: 'completed',
          }
          socket.send(JSON.stringify(stop))
        }
      })
    })

    process.env.DSH_TEST_POD_TOKEN = 'ambient-token-value'
    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, {
        endpoint: mock.endpoint,
        tokenEnv: 'DSH_TEST_POD_TOKEN',
      })

      const run = await ctx.subagents.start('remote', makeRequest())
      await run.result
      expect(seenAuth).toBe('Bearer ambient-token-value')

      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      delete process.env.DSH_TEST_POD_TOKEN
      await mock.close()
    }
  })
})

describe('working directory resolution', () => {
  it('uses config cwd override when provided', async () => {
    const mock = await createMockServer()
    let receivedCwd: string | undefined

    mock.server.on('connection', (socket) => {
      socket.on('message', (data: RawData) => {
        const msg = JSON.parse(rawDataToString(data)) as RemoteSubagentClientMessage
        if (msg.type === 'subagent/start') {
          receivedCwd = msg.cwd
          const stop: RemoteSubagentServerMessage = {
            type: 'subagent/stop',
            id: msg.id,
            output: [{ type: 'text', text: 'ok' }],
            stopReason: 'completed',
          }
          socket.send(JSON.stringify(stop))
        }
      })
    })

    const tmp = mkdtempSync(join(tmpdir(), 'remote-cwd-'))
    try {
      const ctx = new Context()
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(remotePlugin, {
        endpoint: mock.endpoint,
        cwd: tmp,
      })

      const run = await ctx.subagents.start('remote', makeRequest())
      await run.result
      expect(receivedCwd).toBe(tmp)

      await run.dispose()
      await ctx.fiber.dispose()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      await mock.close()
    }
  })

  it('rejects an empty config cwd at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(remotePlugin, {
      endpoint: 'ws://127.0.0.1:3000',
      cwd: '',
    })).rejects.toThrow('config cwd must not be empty')
    await ctx.fiber.dispose()
  })

  it('fails loud when neither config cwd nor parent session cwd exists', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(remotePlugin, {
      endpoint: 'ws://127.0.0.1:3000',
    })

    const parentWithoutCwd = { id: 'parent-none', session: { header: {} } } as unknown as Agent
    await expect(ctx.subagents.start('remote', {
      label: 'test',
      prompt: [{ type: 'text' as const, text: 'p' }],
      parent: parentWithoutCwd,
      signal: new AbortController().signal,
    })).rejects.toThrow('no working directory for the child')

    await ctx.fiber.dispose()
  })
})

describe('configuration validation and HMR safety', () => {
  it('rejects non-positive connectTimeoutMs at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.plugin(remotePlugin, {
      endpoint: 'ws://127.0.0.1:3000',
      connectTimeoutMs: 0,
    })).rejects.toThrow(/connectTimeoutMs|expected number/i)
    await expect(ctx.plugin(remotePlugin, {
      endpoint: 'ws://127.0.0.1:3000',
      connectTimeoutMs: -10,
    })).rejects.toThrow(/connectTimeoutMs|expected number/i)
    await ctx.fiber.dispose()
  })

  it('registers and unregisters cleanly on fiber disposal (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(remotePlugin, {
      providerName: 'remote-hmr',
      endpoint: 'ws://127.0.0.1:3000',
    })

    expect(ctx.subagents.getProvider('remote-hmr')?.name).toBe('remote-hmr')
    await fiber.dispose()
    expect(ctx.subagents.getProvider('remote-hmr')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps named plugin exports with no default export', () => {
    expect(remotePlugin.name).toBe('subagent-remote')
    expect(remotePlugin.inject).toEqual(['subagents'])
    expect(typeof remotePlugin.apply).toBe('function')
    expect(typeof remotePlugin.Config).toBe('function')
    expect((remotePlugin as Record<string, unknown>).default).toBeUndefined()
  })
})
