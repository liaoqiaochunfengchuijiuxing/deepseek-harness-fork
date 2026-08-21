/**
 * `/push_to_hub` human command: upload a local session log to hub persistence.
 * @module @deepseek-ai/dsh-federation-client/push-to-hub
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-source'
import { FederationSessionSource } from '@deepseek-ai/dsh-session-source-federation'

/** Usage string returned for missing arguments. */
export const PUSH_TO_HUB_USAGE = 'Usage: /push_to_hub <sessionId>'

/**
 * Parse `/push_to_hub` arguments.
 * @param rawInput - text after the command name.
 * @returns session id, or undefined when empty.
 */
export function parsePushToHub(rawInput: string): string | undefined {
  const trimmed = rawInput.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Execute one `/push_to_hub` invocation.
 * @param ctx - context carrying session sources.
 * @param invocation - command invocation from `ctx.commands`.
 * @returns UI result.
 */
export async function executePushToHub(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const sessionId = parsePushToHub(invocation.rawInput)
  if (sessionId === undefined) return { kind: 'error', text: PUSH_TO_HUB_USAGE }
  const sources = ctx.get('sessionSources')
  const source = sources?.listSources().find((item): item is FederationSessionSource =>
    item instanceof FederationSessionSource)
  if (source === undefined) {
    return { kind: 'error', text: 'no remote federation session source is mounted' }
  }
  try {
    await source.pushSession(SessionId(sessionId))
    return { kind: 'success', text: `Pushed ${sessionId} to hub. Session continuity is not work continuity.` }
  } catch (err: unknown) {
    return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
}
