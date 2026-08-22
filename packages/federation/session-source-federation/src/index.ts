/**
 * @deepseek-ai/dsh-session-source-federation — Remote Federation Session Source provider.
 * Connects to a remote federation hub over WebSocket to proxy session listing,
 * search, inspection, and live event streams.
 *
 * @module @deepseek-ai/dsh-session-source-federation
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-source'
import { FederationSessionSource } from './federation-source.ts'
import type { FederationSessionSourceConfig } from './types.ts'

export * from './types.ts'
export * from './federation-source.ts'

export const name = 'session-source-federation'
export const inject = ['sessionSources']

/** Configuration schema for federation session source provider. */
export interface Config extends FederationSessionSourceConfig {}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string().required().description('WebSocket endpoint URL of the remote federation hub'),
  token: Schema.string().description('Literal authentication bearer token'),
  tokenEnv: Schema.string().description('Environment variable containing authentication token'),
  ownerPodId: Schema.string().description('Owning pod identity claimed at registration; required when the token is registry-bound to a pod'),
  ownerPodIdEnv: Schema.string().description('Environment variable name holding the owning pod identity (e.g. DSH_POD_ID)'),
  sourceId: Schema.string().default('federation-hub').description('Unique session source identifier'),
  sourceName: Schema.string().default('Hub Sessions').description('Display name for this session source'),
  connectTimeoutMs: Schema.natural().default(5000).description('Connection timeout in milliseconds'),
  requestTimeoutMs: Schema.natural().default(10000).description('Request timeout in milliseconds'),
  autoReconnect: Schema.boolean().default(true).description('Whether to automatically reconnect on disconnect'),
  reconnectDelayMs: Schema.natural().default(2000).description('Delay in milliseconds before reconnecting'),
})

/**
 * Apply the remote federation session source plugin.
 * @param ctx - the owning Cordis context.
 * @param config - federation session source configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const source = new FederationSessionSource(config, ctx)

  ctx.effect(() => {
    source.start()
    const unregister = ctx.sessionSources.registerSource(source)

    return () => {
      unregister()
      source.dispose()
    }
  }, 'federation.session-source.remote')
}
