/**
 * Local SessionSource provider plugin for deepseek-harness.
 * Mounts LocalSessionSource on `ctx.sessionSources`.
 *
 * @module @deepseek-ai/dsh-session-source-local
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { LocalSessionSource } from './local-source.ts'

export * from './local-source.ts'

export const name = 'session-source-local'

export const inject = ['sessionSources']

/** Empty configuration schema for local session source. */
export interface Config {}

export const Config: Schema<Config> = Schema.object({})

/**
 * Apply the local session source plugin.
 * @param ctx - the owning Cordis context.
 */
export function apply(ctx: Context): void {
  const source = new LocalSessionSource(ctx)
  ctx.effect(() => {
    return ctx.sessionSources.registerSource(source)
  }, 'session.source.local')
}
