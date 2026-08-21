/**
 * Session source Service Definition and registry plugin for deepseek-harness.
 * Provides multi-source aggregation over local persistence and remote federation nodes.
 *
 * @module @deepseek-ai/dsh-session-source
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionSourcesService } from './service.ts'

export * from './types.ts'
export * from './service.ts'

export const name = 'session-sources'

/** Empty config schema for session sources service. */
export interface Config {}

export const Config: Schema<Config> = Schema.object({})

/**
 * Apply the session sources service definition plugin.
 * @param ctx - the owning Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.set('sessionSources', new SessionSourcesService(ctx))
}
