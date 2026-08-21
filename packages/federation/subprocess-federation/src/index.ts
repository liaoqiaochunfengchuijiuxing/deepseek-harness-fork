/**
 * Federation subprocess provider: delegates `ctx.subprocess` operations to a remote
 * pod over federation WebSocket.
 *
 * @module @deepseek-ai/dsh-subprocess-federation
 */

import { randomUUID } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  SubprocessRuntime,
  type SubprocessCollect,
  type SubprocessCollectedOutputs,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessOutputMode,
  type SubprocessOutputRead,
  type SubprocessOutputReader,
  type SubprocessSpawnSpec,
  type SubprocessTerminalForeground,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSignal,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { FederationHubService } from '@deepseek-ai/dsh-federation-hub'
import type { FederationClientService } from '@deepseek-ai/dsh-federation-client'
export * from './invariant.ts'

export const name = 'subprocess-federation'

/** Configuration for remote federation subprocess provider. */
export interface Config {
  /** Target pod identifier to route subprocess operations to. */
  targetPodId: string
  /** RPC request timeout in milliseconds. */
  timeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  targetPodId: Schema.string().description('Target pod identifier to route subprocess operations to.').required(),
  timeoutMs: Schema.number().description('RPC request timeout in milliseconds.').default(15000),
})

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return typeof mode === 'object' && 'maxBytes' in mode
}

class CollectedStreamBuffer implements SubprocessOutputReader {
  private buffer = ''
  private totalBytes = 0

  constructor(private readonly collect: SubprocessCollect) {}

  append(text: string): void {
    this.buffer += text
    this.totalBytes += Buffer.byteLength(text, 'utf-8')
    if (this.buffer.length > this.collect.maxBytes) {
      this.buffer = this.buffer.slice(this.buffer.length - this.collect.maxBytes)
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const text = this.buffer
    const currentOffset = this.totalBytes
    const lossy = fromByte < this.totalBytes - Buffer.byteLength(this.buffer, 'utf-8')
    return {
      text,
      nextOffset: currentOffset,
      lossy,
    }
  }
}

/**
 * Subprocess runtime provider that executes processes on a remote pod.
 */
export class FederationSubprocessRuntime extends SubprocessRuntime {
  static Config = Config

  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config
  }

  private async callRpc(
    method: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onStream?: (chunk: unknown, done?: boolean) => void,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw new Error(`${method} aborted`)
    }

    const hub = this.ctx.federationHub as FederationHubService | undefined
    const client = this.ctx.federationClient as FederationClientService | undefined

    if (!hub && !client) {
      throw new Error('neither federationHub nor federationClient service is available')
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
          { requestId, seam: 'subprocess', method, args },
          onStream,
          this.config.timeoutMs ?? 15000,
        )
        if (!res.ok) {
          throw new Error(res.error?.message ?? 'Subprocess RPC failed')
        }
        return res.value
      } else {
        const res = await client?.rpcCapability(
          { requestId, targetPodId: this.config.targetPodId, seam: 'subprocess', method, args },
          onStream,
          this.config.timeoutMs ?? 15000,
        )
        if (!res?.ok) {
          throw new Error(res?.message ?? 'Subprocess RPC failed')
        }
        return res.value
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await this.callRpc('resolveExecutable', { command, options: { env } }, signal)
    return res as string
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    let processPid = -1
    let remoteHandleId: string | undefined
    let resolveDone: (outcome: SubprocessOutcome) => void
    let rejectDone: (err: Error) => void

    const done = new Promise<SubprocessOutcome>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })

    const stdoutStream = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderrStream = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined

    const stdoutCollector = isCollect(spec.stdio.stdout) ? new CollectedStreamBuffer(spec.stdio.stdout) : undefined
    const stderrCollector = isCollect(spec.stdio.stderr) ? new CollectedStreamBuffer(spec.stdio.stderr) : undefined

    const collected: SubprocessCollectedOutputs = {
      ...stdoutCollector !== undefined ? { stdout: stdoutCollector } : {},
      ...stderrCollector !== undefined ? { stderr: stderrCollector } : {},
    }

    let stdinStream: Writable | undefined
    if (spec.stdio.stdin === 'pipe') {
      stdinStream = new Writable({
        decodeStrings: false,
        write: (chunk: Buffer | string, _encoding, callback) => {
          if (!remoteHandleId) {
            callback(new Error('Process not yet spawned on remote pod'))
            return
          }
          const data = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
          this.callRpc('writeStdin', { handleId: remoteHandleId, data })
            .then(() => { callback() })
            .catch((err: unknown) => { callback(err instanceof Error ? err : new Error(String(err))) })
        },
      })
    }

    const onStream = (chunk: unknown, isDone?: boolean): void => {
      if (typeof chunk === 'object' && chunk !== null) {
        const payload = chunk as { type?: string; outcome?: SubprocessOutcome; data?: string; stream?: string }
        if (payload.type === 'exit' && payload.outcome) {
          resolveDone(payload.outcome)
        } else if (payload.stream === 'stdout' && typeof payload.data === 'string') {
          stdoutStream?.write(payload.data)
          stdoutCollector?.append(payload.data)
        } else if (payload.stream === 'stderr' && typeof payload.data === 'string') {
          stderrStream?.write(payload.data)
          stderrCollector?.append(payload.data)
        }
      }
      if (isDone) {
        stdoutStream?.end()
        stderrStream?.end()
      }
    }

    // Launch remote spawn asynchronously
    this.callRpc('spawn', { request: spec }, spec.signal, onStream)
      .then((val: unknown) => {
        const res = val as { handleId: string; pid: number }
        remoteHandleId = res.handleId
        processPid = res.pid
      })
      .catch((err: unknown) => {
        rejectDone(err instanceof Error ? err : new Error(String(err)))
      })

    const terminate = (): void => {
      if (remoteHandleId) {
        void this.callRpc('terminate', { handleId: remoteHandleId, graceMs: spec.graceMs }).catch(() => {})
      }
    }

    const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
      if (signal?.aborted) return false
      return new Promise<boolean>((resolve) => {
        const onAbort = () => { resolve(false) }
        signal?.addEventListener('abort', onAbort, { once: true })
        void done.then(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve(true)
        }).catch(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve(true)
        })
      })
    }

    return {
      get pid() {
        return processPid
      },
      stdin: stdinStream,
      stdout: stdoutStream,
      stderr: stderrStream,
      collected,
      done,
      terminate,
      waitForExit,
    }
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const output = new PassThrough()
    let resolveDone: (outcome: SubprocessOutcome) => void

    const done = new Promise<SubprocessOutcome>((resolve) => {
      resolveDone = resolve
    })

    const onStream = (chunk: unknown, isDone?: boolean): void => {
      if (typeof chunk === 'string') {
        output.write(chunk)
      } else if (typeof chunk === 'object' && chunk !== null) {
        const payload = chunk as { type?: string; outcome?: SubprocessOutcome }
        if (payload.type === 'terminal-exit') {
          resolveDone(payload.outcome ?? { exitCode: 0, signal: null })
        }
      }
      if (isDone) {
        output.end()
      }
    }

    const res = await this.callRpc('spawnTerminal', { request: spec }, spec.signal, onStream) as { handleId: string; pid: number }
    const handleId = res.handleId
    const pid = res.pid

    return {
      pid,
      output,
      done,
      write: async (data: string): Promise<void> => {
        await this.callRpc('writeTerminal', { handleId, data })
      },
      inspectForeground: async (): Promise<SubprocessTerminalForeground | undefined> => {
        const val = await this.callRpc('inspectForeground', { handleId }) as { info?: SubprocessTerminalForeground }
        return val.info
      },
      signalForeground: async (signal: SubprocessTerminalSignal): Promise<number> => {
        const val = await this.callRpc('signalForeground', { handleId, signal }) as { groupId?: number }
        return val.groupId ?? 0
      },
      terminate: async (): Promise<void> => {
        await this.callRpc('terminateTerminal', { handleId })
      },
    }
  }
}

/**
 * Apply the federation subprocess provider plugin.
 * @param ctx - Cordis context.
 * @param config - Provider configuration.
 */
export function apply(ctx: Context, config: Config): void {
  new FederationSubprocessRuntime(ctx, config)
}

export default FederationSubprocessRuntime
