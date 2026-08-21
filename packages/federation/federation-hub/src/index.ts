/**
 * @deepseek-ai/dsh-federation-hub — Central federation hub service plugin.
 * Manages the pod registry, authenticates incoming pod connections, tracks
 * heartbeats, and routes subagent delegations to connected pods.
 *
 * @module @deepseek-ai/dsh-federation-hub
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { FederationHubService } from './service.ts'
import { FederationHubServer, type FederationHubConfig } from './server.ts'

export * from './types.ts'
export * from './service.ts'
export * from './server.ts'

export const name = 'federation-hub'
export const inject = {
  optional: ['sessionSources'],
}

/** Config schema for federation hub. */
export interface Config extends FederationHubConfig {}

export const Config: Schema<Config> = Schema.object({
  port: Schema.natural().max(65535).default(3080).description('Listen port for HTTP and WebSocket federation server'),
  host: Schema.string().default('127.0.0.1').description('Listen bind host'),
  path: Schema.string().default('/federation/connect').description('WebSocket path for pod connections'),
  subagentPath: Schema.string().default('/federation/subagent').description('WebSocket path for incoming subagent delegations'),
  heartbeatTimeoutMs: Schema.natural().default(30000).description('Timeout (ms) without heartbeat before marking a pod offline'),
  allowAnonymous: Schema.boolean().default(false).description('Whether to allow unauthenticated connections'),
  token: Schema.string().description('Admin/shared authentication token'),
})

/**
 * Apply the federation hub plugin to the Cordis context.
 * @param ctx - the owning Cordis context.
 * @param config - federation hub configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const service = new FederationHubService(ctx)
  const server = new FederationHubServer(service, config)

  ctx.effect(() => {
    let stopped = false
    void server.start().catch((err: unknown) => {
      if (!stopped) {
        ctx.logger.error(err instanceof Error ? err : new Error(String(err)))
      }
    })

    return async () => {
      stopped = true
      await server.stop()
    }
  }, 'federation.hub.serve')
}
