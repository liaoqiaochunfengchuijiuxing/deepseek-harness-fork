/**
 * Federation Client plugin: connects edge pod to central hub, advertises
 * capabilities, sends periodic heartbeats, and executes delegated subagent tasks.
 *
 * @module @deepseek-ai/dsh-federation-client
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import { FederationPodClient, type FederationClientConfig } from './client.ts'
import { FederationClientService } from './service.ts'
import { executeRemoteSend } from './remote-send.ts'

export * from './types.ts'
export * from './client.ts'
export * from './service.ts'
export * from './remote-send.ts'

export const name = 'federation-client'

export const inject = []

/** Config alias for the federation client plugin. */
export type Config = FederationClientConfig

export const Config: z<Config> = z.object({
  endpoint: z.string().required().description('WebSocket endpoint of the federation hub'),
  podId: z.string().required().description('Unique identifier for this pod in the federation cluster'),
  name: z.string().required().description('Human-readable display name for this pod'),
  token: z.string().description('Direct Bearer token for authenticating with the hub'),
  tokenEnv: z.string().description('Environment variable name providing the authentication token'),
  heartbeatIntervalMs: z.natural().default(5000).description('Heartbeat interval in milliseconds'),
  reconnectDelayMs: z.natural().default(2000).description('Initial reconnect backoff delay in milliseconds'),
  maxReconnectDelayMs: z.natural().default(30000).description('Maximum reconnect delay in milliseconds'),
  workspaces: z.array(z.string()).description('Permitted workspace root directories on this pod'),
  tools: z.array(z.string()).description('Supported tool names on this pod'),
  sandboxModes: z.array(z.string()).description('Supported sandbox execution modes'),
  role: z.union([z.const('read'), z.const('command'), z.const('manage'), z.const('takeover')]).default('command').description('Declared role for this pod'),
  requestTimeoutMs: z.natural().default(10000).description('Bound (ms) on a session/send round-trip'),
})

/**
 * Apply the federation client plugin.
 * @param ctx - The owning Cordis context.
 * @param config - Federation client configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new FederationPodClient(ctx, config)
  new FederationClientService(ctx, client)

  ctx.effect(() => {
    client.start()
    return () => {
      client.dispose()
    }
  }, 'federation.client.connect')

  const commands = ctx.get('commands')
  if (commands) {
    commands.register({
      name: 'remote_send',
      description: 'send a message to a remote writer-node session inbox',
      input: { hint: '<sessionId> <message>' },
      handler: invocation => executeRemoteSend(ctx, invocation),
    })
  }
}
