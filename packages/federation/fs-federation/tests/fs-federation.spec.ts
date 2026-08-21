import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { apply as applyInvariant } from '../src/invariant.ts'
import { apply, FederationFileSystem } from '../src/index.ts'

describe('FederationFileSystem', () => {
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
      '@deepseek-ai/dsh-fs-federation',
      expect.any(Function),
    )
    installerFn?.()
    disposer()
  })

  it('fails loud when neither federationHub nor federationClient is available', async () => {
    const ctx = new Context()
    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    await expect(fs.resolve('/foo/bar')).rejects.toThrow(FsError)
  })

  it('reports undefined default sandboxMode', () => {
    const ctx = new Context()
    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    expect(fs.sandboxMode).toBeUndefined()
  })

  it('handles pure synchronous methods and contains edge cases', () => {
    const ctx = new Context()
    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    const target1 = { displayPath: '/foo/bar', targetKey: FsTargetKey('/foo/bar') }
    const target1Slash = { displayPath: '/foo/bar/', targetKey: FsTargetKey('/foo/bar/') }
    const target2 = { displayPath: '/foo/bar/baz.txt', targetKey: FsTargetKey('/foo/bar/baz.txt') }
    const target3 = { displayPath: '/other/file.txt', targetKey: FsTargetKey('/other/file.txt') }

    expect(fs.processPath(target1)).toBe('/foo/bar')
    expect(fs.fileUrl(target1)).toContain('file:')
    expect(fs.contains(target1, target2)).toBe(true)
    expect(fs.contains(target1Slash, target2)).toBe(true)
    expect(fs.contains(target1, target3)).toBe(false)
  })

  it('delegates operations via federationHub in Cloud mode', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn(),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-alpha', timeoutMs: 5000 })

    // 1. resolve (with and without canonicalPath)
    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-1',
      ok: true,
      value: { displayPath: 'foo.txt', targetKey: '/workspace/foo.txt' },
    })
    const resolved = await fs.resolve('foo.txt')
    expect(resolved.displayPath).toBe('foo.txt')
    expect(String(resolved.targetKey)).toBe('/workspace/foo.txt')

    // 2. stat (with and without version)
    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-2',
      ok: true,
      value: { type: 'file', size: 42, mtimeMs: 1000, version: 'v1' },
    })
    const stat = await fs.stat(resolved)
    expect(stat?.type).toBe('file')
    expect(stat?.size).toBe(42)
    expect(stat?.version).toBe(FsVersion('v1'))

    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-2b',
      ok: true,
      value: undefined,
    })
    const statMissing = await fs.stat(resolved)
    expect(statMissing).toBeUndefined()

    // 3. lstat
    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-3',
      ok: true,
      value: { type: 'file', size: 42, mtimeMs: 1000 },
    })
    const lstat = await fs.lstat('foo.txt')
    expect(lstat?.type).toBe('file')

    // 4. readText
    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-4',
      ok: true,
      value: 'hello world text',
    })
    const text = await fs.readText(resolved)
    expect(text).toBe('hello world text')

    // 5. streamText with string and non-string chunk
    mockHub.rpcToPod.mockImplementationOnce((_podId: string, _req: unknown, onStream?: (chunk: unknown, done?: boolean) => void) => {
      onStream?.(null) // non-string chunk ignored
      onStream?.('chunk 1 ')
      onStream?.('chunk 2', true)
      return Promise.resolve({
        type: 'capability/result',
        requestId: 'req-5',
        ok: true,
        value: { streamed: true },
      })
    })
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(resolved)) {
      chunks.push(chunk)
    }
    expect(chunks.join('')).toBe('chunk 1 chunk 2')

    // 6. readBytes
    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-6',
      ok: true,
      value: { base64: Buffer.from('binary-data').toString('base64') },
    })
    const bytes = await fs.readBytes(resolved, undefined, 1024)
    expect(Buffer.from(bytes).toString('utf-8')).toBe('binary-data')

    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-6b',
      ok: true,
      value: {},
    })
    const bytesEmpty = await fs.readBytes(resolved, undefined, 1024)
    expect(bytesEmpty.length).toBe(0)

    // 7. listDir
    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-7',
      ok: true,
      value: [{ name: 'sub', type: 'file', target: { displayPath: 'sub', targetKey: '/workspace/sub' } }],
    })
    const entries = await fs.listDir(resolved)
    expect(entries.length).toBe(1)
    expect(entries[0]!.name).toBe('sub')

    // 8. writeText (with and without version)
    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-8',
      ok: true,
      value: { version: 'v2' },
    })
    const writeRes = await fs.writeText(resolved, 'content')
    expect(writeRes.version).toBe(FsVersion('v2'))

    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-8b',
      ok: true,
      value: {},
    })
    const writeResNoVer = await fs.writeText(resolved, 'content')
    expect(writeResNoVer.version).toBeUndefined()

    // 9. editText (with and without version)
    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-9',
      ok: true,
      value: { version: 'v3', before: 'a', after: 'b' },
    })
    const editRes = await fs.editText(resolved, { oldString: 'a', newString: 'b', replaceAll: false })
    expect(editRes.version).toBe(FsVersion('v3'))

    mockHub.rpcToPod.mockResolvedValueOnce({
      type: 'capability/result',
      requestId: 'req-9b',
      ok: true,
      value: { before: 'a', after: 'b' },
    })
    const editResNoVer = await fs.editText(resolved, { oldString: 'a', newString: 'b', replaceAll: false })
    expect(editResNoVer.before).toBe('a')
    expect(editResNoVer.version).toBeUndefined()
  })

  it('delegates operations via federationClient in Peer mode', async () => {
    const ctx = new Context()
    const mockClient = {
      rpcCapability: vi.fn(),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationClient = mockClient as unknown as typeof ctx.federationClient

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-beta' })

    mockClient.rpcCapability.mockResolvedValueOnce({
      ok: true,
      value: { displayPath: 'bar.txt', targetKey: '/workspace/bar.txt' },
    })

    const target = await fs.resolve('bar.txt')
    expect(target.displayPath).toBe('bar.txt')
    expect(mockClient.rpcCapability).toHaveBeenCalledWith(
      expect.objectContaining({ targetPodId: 'pod-beta', seam: 'fs', method: 'resolve' }),
      undefined,
      15000,
    )
  })

  it('handles client rpc error without code or message', async () => {
    const ctx = new Context()
    const mockClient = {
      rpcCapability: vi.fn().mockResolvedValue({
        ok: false,
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationClient = mockClient as unknown as typeof ctx.federationClient

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-beta' })
    await expect(fs.resolve('bar.txt')).rejects.toThrow('Filesystem RPC failed')
  })

  it('handles client rpc error with FsErrorCode', async () => {
    const ctx = new Context()
    const mockClient = {
      rpcCapability: vi.fn().mockResolvedValue({
        ok: false,
        code: 'FS_NOT_FOUND',
        message: 'target missing',
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationClient = mockClient as unknown as typeof ctx.federationClient

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-beta' })
    await expect(fs.resolve('bar.txt')).rejects.toThrow(FsError)
  })

  it('maps typed FsError codes correctly', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockResolvedValue({
        type: 'capability/result',
        requestId: 'req-err',
        ok: false,
        error: { code: 'FS_NOT_FOUND', message: 'file missing' },
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    await expect(fs.readText({ displayPath: 'x', targetKey: FsTargetKey('/x') }))
      .rejects.toThrow(FsError)
  })

  it('handles hub error with code but no message', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockResolvedValue({
        type: 'capability/result',
        requestId: 'req-err-nomsg',
        ok: false,
        error: { code: 'FS_NOT_FOUND' },
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    await expect(fs.readText({ displayPath: 'x', targetKey: FsTargetKey('/x') }))
      .rejects.toThrow(FsError)
  })

  it('throws non-FsError when error code is unknown', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockResolvedValue({
        type: 'capability/result',
        requestId: 'req-err2',
        ok: false,
        error: { code: 'UNKNOWN_CODE', message: 'unknown failure' },
      }),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    await expect(fs.readText({ displayPath: 'x', targetKey: FsTargetKey('/x') }))
      .rejects.toThrow('unknown failure')
  })

  it('handles in-flight cancellation via signal on hub and client', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn().mockImplementation(() => new Promise(r => setTimeout(r, 200))),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    const controller = new AbortController()

    const resolvePromise = fs.resolve('test', { signal: controller.signal })
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
    const fsClient = new FederationFileSystem(ctxClient, { targetPodId: 'pod-2' })
    const controller2 = new AbortController()

    const resolvePromise2 = fsClient.resolve('test2', { signal: controller2.signal })
    controller2.abort()

    await expect(resolvePromise2).rejects.toThrow()
    expect(mockClient.cancelCapabilityRpc).toHaveBeenCalledWith(expect.any(String))
  })

  it('aborts operation when signal is already aborted', async () => {
    const ctx = new Context()
    ctx.federationHub = { rpcToPod: vi.fn(), cancelCapabilityRpc: vi.fn() } as unknown as typeof ctx.federationHub
    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    const controller = new AbortController()
    controller.abort()

    await expect(fs.resolve('test', { signal: controller.signal })).rejects.toThrow(FsError)
    await expect(fs.streamText({ displayPath: 'x', targetKey: FsTargetKey('/x') }, controller.signal)).rejects.toThrow(FsError)
  })

  it('handles streamText failure during iteration with Error and non-Error object', async () => {
    const ctx = new Context()
    const mockHub = {
      rpcToPod: vi.fn()
        .mockRejectedValueOnce('string-network-broke')
        .mockRejectedValueOnce(new Error('error-instance-broke')),
      cancelCapabilityRpc: vi.fn(),
    }
    ctx.federationHub = mockHub as unknown as typeof ctx.federationHub

    const fs = new FederationFileSystem(ctx, { targetPodId: 'pod-1' })
    const target = { displayPath: 'stream.txt', targetKey: FsTargetKey('/stream.txt') }

    const stream1 = await fs.streamText(target)
    await expect(async () => {
      for await (const chunk of stream1) {
        void chunk
      }
    }).rejects.toThrow('string-network-broke')

    const stream2 = await fs.streamText(target)
    await expect(async () => {
      for await (const chunk of stream2) {
        void chunk
      }
    }).rejects.toThrow('error-instance-broke')
  })

  it('registers via apply function', () => {
    const ctx = new Context()
    apply(ctx, { targetPodId: 'pod-1' })
    expect(ctx.fs).toBeInstanceOf(FederationFileSystem)
  })
})
