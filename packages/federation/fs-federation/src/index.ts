/**
 * Federation filesystem provider: delegates `ctx.fs` operations to a remote
 * pod over federation WebSocket.
 *
 * @module @deepseek-ai/dsh-fs-federation
 */

import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { FederationHubService } from '@deepseek-ai/dsh-federation-hub'
import type { FederationClientService } from '@deepseek-ai/dsh-federation-client'

export * from './invariant.ts'

export const name = 'fs-federation'

/** Configuration for remote federation filesystem provider. */
export interface Config {
  /** Target pod identifier to route filesystem operations to. */
  targetPodId: string
  /** RPC request timeout in milliseconds. */
  timeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  targetPodId: Schema.string().description('Target pod identifier to route filesystem operations to.').required(),
  timeoutMs: Schema.number().description('RPC request timeout in milliseconds.').default(15000),
})

/**
 * Filesystem provider that executes file operations on a remote pod.
 */
export class FederationFileSystem extends FileSystem {
  static Config = Config

  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config
  }

  override get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  private async callRpc(
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onStream?: (chunk: unknown, done?: boolean) => void,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new FsError(`${method} aborted`, 'FS_ABORTED')
    }

    const hub = this.ctx.federationHub as FederationHubService | undefined
    const client = this.ctx.federationClient as FederationClientService | undefined

    if (!hub && !client) {
      throw new FsError('neither federationHub nor federationClient service is available', 'FS_NOT_FOUND')
    }

    const requestId = randomUUID()
    const onAbort = (): void => {
      if (hub) {
        hub.cancelCapabilityRpc(this.config.targetPodId, requestId)
      } else {
        client?.cancelCapabilityRpc(requestId)
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      if (hub) {
        const res = await hub.rpcToPod(
          this.config.targetPodId,
          { requestId, seam: 'fs', method, args },
          onStream,
          this.config.timeoutMs ?? 15000,
        )
        if (!res.ok) {
          const code = res.error?.code
          const message = res.error?.message ?? 'Filesystem RPC failed'
          if (code && this.isFsErrorCode(code)) {
            throw new FsError(message, code)
          }
          throw new Error(message)
        }
        return res.value
      } else {
        const res = await client?.rpcCapability(
          { requestId, targetPodId: this.config.targetPodId, seam: 'fs', method, args },
          onStream,
          this.config.timeoutMs ?? 15000,
        )
        if (!res?.ok) {
          const code = res?.code
          const message = res?.message ?? 'Filesystem RPC failed'
          if (code && this.isFsErrorCode(code)) {
            throw new FsError(message, code)
          }
          throw new Error(message)
        }
        return res.value
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private isFsErrorCode(code: string): code is FsErrorCode {
    return [
      'FS_NOT_FOUND',
      'FS_NOT_REGULAR_FILE',
      'FS_NOT_DIRECTORY',
      'FS_NOT_TEXT',
      'FS_TOO_LARGE',
      'FS_STALE_VERSION',
      'FS_NOT_OBSERVED',
      'FS_EDIT_MISMATCH',
      'FS_RESTRICTED',
      'FS_ABORTED',
      'FS_DISCONNECTED',
      'FS_IO_ERROR',
    ].includes(code)
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const res = await this.callRpc('resolve', { path, cwd: opts?.cwd }, opts?.signal) as FsTarget
    return {
      displayPath: res.displayPath,
      targetKey: FsTargetKey(String(res.targetKey)),
    }
  }

  processPath(target: FsTarget): string {
    return posix.normalize(String(target.targetKey))
  }

  fileUrl(target: FsTarget): string {
    return pathToFileURL(String(target.targetKey)).toString()
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const p = posix.normalize(String(parent.targetKey))
    const c = posix.normalize(String(child.targetKey))
    return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`)
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const res = await this.callRpc('stat', { target }, signal) as FsInfo | undefined
    if (res && res.version) {
      return { ...res, version: FsVersion(res.version) }
    }
    return res
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return await this.callRpc('lstat', { path, cwd: opts?.cwd }, signal) as FsPathInfo | undefined
  }

  readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.callRpc('readText', { target }, signal) as Promise<string>
  }

  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (signal?.aborted) {
      return Promise.reject(new FsError('streamText aborted', 'FS_ABORTED'))
    }

    const queue: string[] = []
    let notify: (() => void) | undefined
    let done = false
    let failure: Error | undefined

    const pushChunk = (chunk: unknown, isDone?: boolean) => {
      if (typeof chunk === 'string') {
        queue.push(chunk)
      }
      if (isDone) {
        done = true
      }
      notify?.()
    }

    const rpcPromise = this.callRpc('streamText', { target }, signal, pushChunk)
      .then(() => {
        done = true
        notify?.()
      })
      .catch((err: unknown) => {
        failure = err instanceof Error ? err : new Error(String(err))
        done = true
        notify?.()
      })

    const iterator = async function* () {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as string
        } else if (failure !== undefined) {
          throw failure
        } else if (done) {
          break
        } else {
          await new Promise<void>((resolve) => {
            notify = resolve
          })
          notify = undefined
        }
      }
      await rpcPromise
    }

    return Promise.resolve({
      [Symbol.asyncIterator]: iterator,
    })
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const res = await this.callRpc('readBytes', { target, maxBytes }, signal) as { base64?: string }
    return new Uint8Array(Buffer.from(res.base64 ?? '', 'base64'))
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const res = await this.callRpc('listDir', { target }, signal) as FsDirEntry[]
    return res.map(entry => ({
      ...entry,
      target: {
        ...entry.target,
        targetKey: FsTargetKey(String(entry.target.targetKey)),
      },
    }))
  }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const res = await this.callRpc('writeText', { target, content, expected, sandboxPolicy }, signal) as FsWriteOutcome
    if (res.version) {
      return { ...res, version: FsVersion(res.version) }
    }
    return res
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const res = await this.callRpc('editText', { target, edit, expected, sandboxPolicy }, signal) as FsEditOutcome
    if (res.version) {
      return { ...res, version: FsVersion(res.version) }
    }
    return res
  }
}

/**
 * Apply the federation filesystem provider plugin.
 * @param ctx - Cordis context.
 * @param config - Provider configuration.
 */
export function apply(ctx: Context, config: Config): void {
  new FederationFileSystem(ctx, config)
}

export default FederationFileSystem
