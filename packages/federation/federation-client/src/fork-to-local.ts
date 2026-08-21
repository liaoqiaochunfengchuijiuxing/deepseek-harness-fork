/**
 * `/fork_to_local` human command: copy a hub session into local persistence.
 * @module @deepseek-ai/dsh-federation-client/fork-to-local
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-source'
import {
  FederationSessionSource,
  SESSION_CONTINUITY_NOTICE,
} from '@deepseek-ai/dsh-session-source-federation'

/** Usage string returned for missing arguments. */
export const FORK_TO_LOCAL_USAGE = 'Usage: /fork_to_local <sessionId> [cwd]'

/**
 * Parse `/fork_to_local` arguments.
 * @param rawInput - text after the command name.
 * @returns session id and optional cwd, or undefined when the grammar is not satisfied.
 */
export function parseForkToLocal(rawInput: string): { sessionId: string; cwd?: string } | undefined {
  const trimmed = rawInput.trim()
  if (trimmed.length === 0) return undefined
  const split = trimmed.search(/\s/u)
  if (split <= 0) return { sessionId: trimmed }
  return { sessionId: trimmed.slice(0, split), cwd: trimmed.slice(split).trim() }
}

/**
 * Execute one `/fork_to_local` invocation.
 * @param ctx - context carrying session sources.
 * @param invocation - command invocation from `ctx.commands`.
 * @returns UI result.
 */
export async function executeForkToLocal(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const parsed = parseForkToLocal(invocation.rawInput)
  if (parsed === undefined) return { kind: 'error', text: FORK_TO_LOCAL_USAGE }
  const sources = ctx.get('sessionSources')
  const source = sources?.listSources().find((item): item is FederationSessionSource =>
    item instanceof FederationSessionSource)
  if (source === undefined) {
    return { kind: 'error', text: 'no remote federation session source is mounted' }
  }
  try {
    const newId = await source.forkSession(SessionId(parsed.sessionId), parsed.cwd)
    return { kind: 'success', text: `Forked to local session ${newId}. ${SESSION_CONTINUITY_NOTICE}` }
  } catch (err: unknown) {
    return { kind: 'error', text: err instanceof Error ? err.message : String(err) }
  }
}
