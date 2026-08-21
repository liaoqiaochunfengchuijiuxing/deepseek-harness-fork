/**
 * Remote subagent run client over WebSocket. Connects to a remote endpoint,
 * sends the subagent start request, accumulates streamed output, maps stop reasons,
 * and handles cancellation and disposal under the seam contract.
 *
 * @module @deepseek-ai/dsh-subagent-remote/run
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import type {
  RemoteSubagentAbortMessage,
  RemoteSubagentServerMessage,
  RemoteSubagentStartMessage,
} from './types.ts'

/** Resolved connection spec for a remote subagent run. */
export interface RemoteRunSpec {
  /** The WebSocket endpoint URL (e.g. `ws://host:port/path` or `wss://...`). */
  endpoint: string
  /** Resolved bearer authentication token, if any. */
  token?: string
  /** Absolute working directory for the remote session workspace. */
  cwd: string
  /** Bound (ms) on establishing WebSocket connection. */
  connectTimeoutMs: number
  /** Sink for child-level failures flattened to stop reasons. */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** Default timeout for establishing a WebSocket connection (ms). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

/**
 * Map a remote stop reason string to a harness {@link SubagentStopReason}.
 * @param reason - the stop reason reported by the remote endpoint.
 * @returns the harness equivalent; unknown reason maps to `error`.
 */
export function remoteStopReason(reason: string | undefined): SubagentStopReason {
  switch (reason) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    default:
      return 'error'
  }
}

/**
 * Normalize an endpoint URL to WebSocket scheme (`ws:` or `wss:`).
 * @param endpoint - the input URL string.
 * @returns the normalized WebSocket URL string.
 */
export function normalizeWsEndpoint(endpoint: string): string {
  if (endpoint.startsWith('http://')) {
    return `ws://${endpoint.slice('http://'.length)}`
  }
  if (endpoint.startsWith('https://')) {
    return `wss://${endpoint.slice('https://'.length)}`
  }
  return endpoint
}

/**
 * Convert raw WebSocket data to string safely.
 * @param data - the raw data from WebSocket message.
 * @returns the UTF-8 decoded string representation.
 */
export function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/** Normalize an unknown thrown value to an Error. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Start and publish one remote subagent run after establishing the WebSocket connection.
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved connection and run spec.
 * @returns the ready run handle for the remote delegation.
 */
export async function startRemoteRun(request: SubagentStartRequest, spec: RemoteRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) {
    throw new Error('subagent request was aborted before remote subagent started')
  }

  const id = SessionId(randomUUID())
  const url = normalizeWsEndpoint(spec.endpoint)

  const headers: Record<string, string> = {}
  if (spec.token !== undefined && spec.token.length > 0) {
    headers.Authorization = `Bearer ${spec.token}`
  }

  const socket = new WebSocket(url, {
    headers,
    handshakeTimeout: spec.connectTimeoutMs,
  })

  const flags = { cancelled: false }
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => {
    signalCancelSettled = resolve
  })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    if (socket.readyState === WebSocket.OPEN) {
      try {
        const abortMsg: RemoteSubagentAbortMessage = {
          type: 'subagent/abort',
          id,
          reason: 'cancelled',
        }
        socket.send(JSON.stringify(abortMsg))
      } catch {
        // ignore send error on abort
      }
    }
    signalCancelSettled()
  }
  const onAbort = (): void => {
    requestCancel()
  }
  request.signal.addEventListener('abort', onAbort, { once: true })

  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup()
        resolve()
      }

      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }

      const onClose = (code: number, reason: Buffer): void => {
        cleanup()
        reject(new Error(`WebSocket connection closed before open (code: ${code}, reason: ${reason.toString()})`))
      }

      const timer = setTimeout(() => {
        cleanup()
        socket.on('error', () => {})
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.terminate()
        }
        reject(new Error(`subagent-remote: connection to "${spec.endpoint}" timed out after ${spec.connectTimeoutMs}ms`))
      }, spec.connectTimeoutMs)

      const cleanup = (): void => {
        clearTimeout(timer)
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('close', onClose)
      }

      if (flags.cancelled) {
        cleanup()
        socket.on('error', () => {})
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.terminate()
        }
        reject(new Error('subagent request was aborted before remote subagent started'))
        return
      }

      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('close', onClose)
    })

    if (flags.cancelled) {
      throw new Error('subagent request was aborted before remote subagent started')
    }
  } catch (error) {
    request.signal.removeEventListener('abort', onAbort)
    socket.on('error', () => {})
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate()
    }
    if (flags.cancelled) {
      throw new Error('subagent request was aborted before remote subagent started')
    }
    throw toError(error)
  }

  const startMessage: RemoteSubagentStartMessage = {
    type: 'subagent/start',
    id,
    ...request.label !== undefined ? { label: request.label } : {},
    prompt: request.prompt,
    cwd: spec.cwd,
  }
  socket.send(JSON.stringify(startMessage))

  const streamedBlocks: ContentBlock[] = []
  let accumulatedText = ''
  let lastDiagnostic: string | undefined

  const collectOutput = (): ContentBlock[] => {
    if (streamedBlocks.length > 0) return streamedBlocks
    if (accumulatedText.length > 0) return [{ type: 'text', text: accumulatedText }]
    return []
  }

  let settleTurn!: (result: SubagentResult) => void
  let rejectTurn!: (error: Error) => void
  let turnSettled = false
  const turnPromise = new Promise<SubagentResult>((resolve, reject) => {
    settleTurn = (res) => {
      if (turnSettled) return
      turnSettled = true
      resolve(res)
    }
    rejectTurn = (err) => {
      if (turnSettled) return
      turnSettled = true
      reject(err)
    }
  })

  socket.on('message', (data: WebSocket.RawData) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawDataToString(data))
    } catch {
      return
    }

    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return
    const msg = parsed as RemoteSubagentServerMessage

    switch (msg.type) {
      case 'subagent/chunk': {
        if (msg.id === id && typeof msg.delta === 'string') {
          accumulatedText += msg.delta
        }
        break
      }
      case 'subagent/stop': {
        if (msg.id === id) {
          if (Array.isArray(msg.output) && msg.output.length > 0) {
            streamedBlocks.length = 0
            streamedBlocks.push(...msg.output)
          }
          if (msg.diagnostic !== undefined) lastDiagnostic = msg.diagnostic
          settleTurn({
            output: collectOutput(),
            stopReason: remoteStopReason(msg.stopReason),
            ...msg.diagnostic !== undefined ? { diagnostic: msg.diagnostic } : {},
          })
        }
        break
      }
      case 'subagent/error': {
        if (msg.id === id) {
          const diag = msg.error.message
          lastDiagnostic = diag
          rejectTurn(new Error(diag))
        }
        break
      }
      default:
        break
    }
  })

  socket.on('close', (code, reason) => {
    if (!turnSettled) {
      const diag = reason.length > 0 ? reason.toString('utf8') : `connection closed (code: ${code})`
      lastDiagnostic = diag
      rejectTurn(new Error(diag))
    }
  })

  socket.on('error', (err: Error) => {
    if (!turnSettled) {
      lastDiagnostic = err.message
      rejectTurn(err)
    }
  })

  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      const outcome = await Promise.race([
        turnPromise,
        cancelSettled.then(() => 'cancelled' as const),
      ])
      if (outcome === 'cancelled') {
        return { output: collectOutput(), stopReason: 'aborted' }
      }
      return outcome
    },
    collectOutput,
    collectDiagnostic: () => lastDiagnostic,
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close()
      }
      return Promise.resolve()
    },
  })
}
