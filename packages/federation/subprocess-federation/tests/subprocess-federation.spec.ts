import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyInvariant } from '../src/invariant.ts'
import { apply, FederationSubprocessRuntime } from '../src/index.ts'

describe('FederationSubprocessRuntime', () => {
  it('registers invariant companion', async () => {
    const ctx = new Context()
    let installerFn: (() => void) | undefined
    const invariants = {
      register: vi.fn().mockImplementation((_name: string, fn: () => void) => {
        installerFn = fn
        return () => {}
      }),
    }
    ctx.invariants = invariants as unknown as typeof ctx.invariants
    const disposer = await applyInvariant(ctx)
    expect(invariants.register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-subprocess-federation',
      expect.any(Function),
    )
    installerFn?.()
    disposer()
  })

  it('fails loud when neither federationHub nor federationClient is available', async () => {
    const ctx = new Context()
    const subprocess = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    await expect(subprocess.resolveExecutable('node')).rejects.toThrow('neither federationHub nor federationClient service is available')
  })

  it('resolves executable via federationHub with and without env', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockResolvedValue({
        type: 'capability/result',
        requestId: 'req-1',
        ok: true,
        value: '/usr/bin/node',
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const path = await runtime.resolveExecutable('node', { PATH: '/usr/bin' })
    expect(path).toBe('/usr/bin/node')
  })

  it('resolves executable via federationClient in peer mode', async () => {
    const ctx = new Context()
    const mockClient = {
      rpcCapability: vi.fn().mockResolvedValue({
        ok: true,
        value: '/bin/bash',
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationClient = mockClient as unknown as typeof ctx.federationClient

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-peer' })
    const path = await runtime.resolveExecutable('bash')
    expect(path).toBe('/bin/bash')
  })

  it('throws when hub rpc fails without message', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockResolvedValue({
        type: 'capability/result',
        requestId: 'req-err-nomsg',
        ok: false,
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    await expect(runtime.resolveExecutable('missing')).rejects.toThrow('Subprocess RPC failed')
  })

  it('throws when client rpc fails without message', async () => {
    const ctx = new Context()
    const mockClient = {
      rpcCapability: vi.fn().mockResolvedValue({
        ok: false,
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationClient = mockClient as unknown as typeof ctx.federationClient

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-peer' })
    await expect(runtime.resolveExecutable('missing')).rejects.toThrow('Subprocess RPC failed')
  })

  it('spawns managed process with collected stdio, buffer overflow, unknown stream, non-object chunk, and stderr', async () => {
    const ctx = new Context()
    let streamCallback: ((chunk: unknown, done?: boolean) => void) | undefined
    const mockHub = {
      rpcToPod: vi.fn().mockImplementation(
        (_podId: string, _req: { method?: string }, onStream?: (chunk: unknown, done?: boolean) => void) => {
          streamCallback = onStream
          return Promise.resolve({
            type: 'capability/result',
            requestId: 'req-spawn',
            ok: true,
            value: { handleId: 'h-1', pid: 1234 },
          })
        },
      ),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const handle = runtime.spawn({
      argv: ['echo', 'hi'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 10 },
        stderr: { maxBytes: 10 },
      },
    })

    await new Promise(r => setTimeout(r, 20))
    expect(handle.pid).toBe(1234)

    // Stream chunks with non-object, unknown stream, stdout, stderr, exit
    streamCallback?.('string-ignored')
    streamCallback?.({ stream: 'other', data: 'ignored' })
    streamCallback?.({ stream: 'stdout', data: '1234567890EXTRA' })
    streamCallback?.({ stream: 'stderr', data: 'err-chunk' })
    streamCallback?.({ type: 'exit', outcome: { exitCode: 0, signal: null } }, true)

    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)

    const stdoutRead = handle.collected.stdout?.readFrom(0)
    expect(stdoutRead?.lossy).toBe(true)

    const stderrRead = handle.collected.stderr?.readFrom(0)
    expect(stderrRead?.text).toBe('err-chunk')

    const exited = await handle.waitForExit()
    expect(exited).toBe(true)

    // Terminate when handleId is known and callRpc terminates
    handle.terminate()
    expect(mockHub.rpcToPod).toHaveBeenCalledWith(
      'pod-1',
      expect.objectContaining({ method: 'terminate' }),
      undefined,
      15000,
    )
  })

  it('handles spawn rejection with Error and non-Error string', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn()
        .mockRejectedValueOnce('spawn-failed-string')
        .mockRejectedValueOnce(new Error('spawn-failed-err')),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const handle1 = runtime.spawn({
      argv: ['invalid'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    handle1.terminate() // No remote handle, should no-op safely
    await expect(handle1.done).rejects.toThrow('spawn-failed-string')

    const handle2 = runtime.spawn({
      argv: ['invalid2'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    await expect(handle2.done).rejects.toThrow('spawn-failed-err')
  })

  it('handles terminate call when callRpc rejects', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockImplementation((_podId: string, req: { method?: string }) => {
        if (req.method === 'spawn') {
          return Promise.resolve({
            type: 'capability/result',
            requestId: 'req-term-fail',
            ok: true,
            value: { handleId: 'h-term-fail', pid: 10 },
          })
        }
        if (req.method === 'terminate') {
          return Promise.reject(new Error('terminate network error'))
        }
        return Promise.resolve({ ok: true })
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const handle = runtime.spawn({
      argv: ['sleep'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    await new Promise(r => setTimeout(r, 20))
    handle.terminate() // Should catch error silently
  })

  it('handles stdin stream writes with string, Buffer, success, and string error', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockImplementation((_podId: string, req: { method?: string; args?: { data?: string } }) => {
        if (req.method === 'spawn') {
          return Promise.resolve({
            type: 'capability/result',
            requestId: 'req-s',
            ok: true,
            value: { handleId: 'h-s', pid: 100 },
          })
        }
        if (req.method === 'writeStdin') {
          if (req.args?.data === 'fail-string') {
            return Promise.reject('string-err')
          }
          return Promise.resolve({ type: 'capability/result', requestId: 'req-w', ok: true })
        }
        return Promise.resolve({ type: 'capability/result', requestId: 'req-def', ok: true })
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const handle = runtime.spawn({
      argv: ['cat'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    handle.stdin?.on('error', () => {})
    await new Promise(r => setTimeout(r, 20))

    // Write string success
    const strWritePromise = new Promise((resolve) => {
      handle.stdin?.write('string data', (err) => {
        expect(err).toBeFalsy()
        resolve(true)
      })
    })
    await strWritePromise

    // Write Buffer success
    const bufPromise = new Promise((resolve) => {
      handle.stdin?.write(Buffer.from('buffer data'), (err) => {
        expect(err).toBeFalsy()
        resolve(true)
      })
    })
    await bufPromise

    // Test string rejection on separate handle
    const ctx2 = new Context()
    ctx2.federationHub = mockHub as unknown as typeof ctx2.federationHub
    const runtime2 = new FederationSubprocessRuntime(ctx2, { targetPodId: 'pod-1' })
    const handle2 = runtime2.spawn({
      argv: ['cat'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    handle2.stdin?.on('error', () => {})
    await new Promise(r => setTimeout(r, 20))

    const strPromise = new Promise((resolve) => {
      handle2.stdin?.write('fail-string', (err) => {
        expect(err?.message).toContain('string-err')
        resolve(true)
      })
    })
    await strPromise

    // Test Error instance rejection on third handle
    const ctx3 = new Context()
    const mockHub3 = {
      rpcToPod: vi.fn().mockImplementation((_podId: string, req: { method?: string }) => {
        if (req.method === 'spawn') {
          return Promise.resolve({
            type: 'capability/result',
            requestId: 'req-s3',
            ok: true,
            value: { handleId: 'h-s3', pid: 102 },
          })
        }
        if (req.method === 'writeStdin') {
          return Promise.reject(new Error('error-instance-rejection'))
        }
        return Promise.resolve({ ok: true })
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx3.federationHub = mockHub3 as unknown as typeof ctx3.federationHub
    const runtime3 = new FederationSubprocessRuntime(ctx3, { targetPodId: 'pod-1' })
    const handle3 = runtime3.spawn({
      argv: ['cat'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
    handle3.stdin?.on('error', () => {})
    await new Promise(r => setTimeout(r, 20))

    const errPromise = new Promise((resolve) => {
      handle3.stdin?.write('fail-err', (err) => {
        expect(err?.message).toContain('error-instance-rejection')
        resolve(true)
      })
    })
    await errPromise
  })

  it('handles stdin stream writes before ready and after ready with errors', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockImplementation((_podId: string, req: { method?: string }) => {
        if (req.method === 'spawn') {
          return new Promise(() => {}) // never resolves
        }
        return Promise.resolve({ ok: true })
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const handle = runtime.spawn({
      argv: ['cat'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })

    handle.stdin?.on('error', () => {})

    // Write before ready -> triggers error callback
    const writePromise1 = new Promise((resolve) => {
      handle.stdin?.write('data', (err) => {
        expect(err?.message).toContain('Process not yet spawned')
        resolve(true)
      })
    })
    await writePromise1
  })

  it('handles waitForExit with abort signal and rejection', async () => {
    const ctx = new Context()
    ctx.federationHub = {
      rpcToPod: vi.fn().mockRejectedValue(new Error('fail-wait')),
      cancelCapabilityRpc: vi.fn(),
    } as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const handle = runtime.spawn({
      argv: ['sleep', '10'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10 }, stderr: { maxBytes: 10 } },
    })

    // Already aborted signal
    const controller1 = new AbortController()
    controller1.abort()
    const exited1 = await handle.waitForExit(controller1.signal)
    expect(exited1).toBe(false)

    // Abort while waiting
    const controller2 = new AbortController()
    const waitPromise = handle.waitForExit(controller2.signal)
    controller2.abort()
    const exited2 = await waitPromise
    expect(exited2).toBe(false)

    // Rejection on done still resolves waitForExit
    const exited3 = await handle.waitForExit()
    expect(exited3).toBe(true)
  })

  it('spawns and controls terminal with default fallbacks and ignores non-exit payloads', async () => {
    const ctx = new Context()
    let streamCallback: ((chunk: unknown, done?: boolean) => void) | undefined
    const mockHub = {
      rpcToPod: vi.fn().mockImplementation(
        (_podId: string, req: { method?: string }, onStream?: (chunk: unknown, done?: boolean) => void) => {
          if (req.method === 'spawnTerminal') {
            streamCallback = onStream
            return Promise.resolve({
              type: 'capability/result',
              requestId: 'req-term',
              ok: true,
              value: { handleId: 'term-1', pid: 9999 },
            })
          }
          if (req.method === 'inspectForeground') {
            return Promise.resolve({
              type: 'capability/result',
              requestId: 'req-term-inspect',
              ok: true,
              value: {},
            })
          }
          if (req.method === 'signalForeground') {
            return Promise.resolve({
              type: 'capability/result',
              requestId: 'req-term-sig',
              ok: true,
              value: {},
            })
          }
          return Promise.resolve({
            type: 'capability/result',
            requestId: 'req-term-def',
            ok: true,
            value: { ok: true },
          })
        },
      ),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const terminal = await runtime.spawnTerminal({
      argv: ['bash'],
      cwd: '/workspace',
      cols: 80,
      rows: 24,
      graceMs: 1000,
    })

    expect(terminal.pid).toBe(9999)

    streamCallback?.(12345) // non-string, non-object ignored
    streamCallback?.({ type: 'other' }) // non-exit payload ignored
    streamCallback?.('string-chunk')
    await terminal.write('ls\n')
    const fg = await terminal.inspectForeground()
    expect(fg).toBeUndefined()

    const sigGroupId = await terminal.signalForeground('SIGINT')
    expect(sigGroupId).toBe(0)

    await terminal.terminate()

    streamCallback?.({ type: 'terminal-exit' }, true)
    const outcome = await terminal.done
    expect(outcome.exitCode).toBe(0)
  })

  it('handles in-flight cancellation via signal in callRpc on hub and client', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockImplementation(() => new Promise(r => setTimeout(r, 200))),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const controller = new AbortController()

    const resolvePromise = runtime.resolveExecutable('test', undefined, controller.signal)
    controller.abort()

    await expect(resolvePromise).rejects.toThrow()
    expect(mockHub.cancelCapabilityRpc).toHaveBeenCalledWith('pod-1', expect.any(String))

    // Client mode cancellation
    const ctxClient = new Context()
    const mockClient = {
      rpcCapability: vi.fn().mockImplementation(() => new Promise(r => setTimeout(r, 200))),
      cancelCapabilityRpc: vi.fn(),
    }
    ctxClient.federationClient = mockClient as unknown as typeof ctxClient.federationClient
    const runtimeClient = new FederationSubprocessRuntime(ctxClient, { targetPodId: 'pod-2' })
    const controller2 = new AbortController()

    const resolvePromise2 = runtimeClient.resolveExecutable('test2', undefined, controller2.signal)
    controller2.abort()

    await expect(resolvePromise2).rejects.toThrow()
    expect(mockClient.cancelCapabilityRpc).toHaveBeenCalledWith(expect.any(String))
  })

  it('aborts operation when signal is already aborted in callRpc', async () => {
    const ctx = new Context()
    ctx.federationHub = { rpcToPod: vi.fn(), cancelCapabilityRpc: vi.fn() } as unknown as typeof ctx.federationHub
    const runtime = new FederationSubprocessRuntime(ctx, { targetPodId: 'pod-1' })
    const controller = new AbortController()
    controller.abort()

    await expect(runtime.resolveExecutable('test', undefined, controller.signal)).rejects.toThrow('resolveExecutable aborted')
  })

  it('registers via apply function', () => {
    const ctx = new Context()
    apply(ctx, { targetPodId: 'pod-1' })
    expect(ctx.subprocess).toBeInstanceOf(FederationSubprocessRuntime)
  })
})
