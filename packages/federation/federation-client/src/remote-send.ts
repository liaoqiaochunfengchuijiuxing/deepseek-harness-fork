/**
 * `/remote_send` human command: deliver a message to a writer-node session inbox.
 * @module @deepseek-ai/dsh-federation-client/remote-send
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Usage string returned for missing or malformed arguments. */
export const REMOTE_SEND_USAGE = 'Usage: /remote_send <sessionId> <message>'

/**
 * Parse `/remote_send` arguments: first token is the target session id, the rest is message text.
 * @param rawInput - text after the command name, including leading whitespace.
 * @returns session id and message text, or undefined when the grammar is not satisfied.
 */
export function parseRemoteSend(rawInput: string): { sessionId: string; text: string } | undefined {
  const trimmed = rawInput.trim()
  const split = trimmed.search(/\s/u)
  if (split <= 0) return undefined
  return { sessionId: trimmed.slice(0, split), text: trimmed.slice(split).trim() }
}

/**
 * Execute one `/remote_send` invocation against `ctx.federationClient`.
 * @param ctx - context carrying the federation client service.
 * @param invocation - command invocation from `ctx.commands`.
 * @returns UI result; never submits the text as a local model prompt.
 */
export async function executeRemoteSend(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const parsed = parseRemoteSend(invocation.rawInput)
  if (parsed === undefined) return { kind: 'error', text: REMOTE_SEND_USAGE }
  if (ctx.federationClient.getStatus() !== 'connected') {
    return { kind: 'error', text: 'federation client is not connected' }
  }
  const result = await ctx.federationClient.sendToSession(
    SessionId(parsed.sessionId),
    [{ type: 'text', text: parsed.text }],
    invocation.commandId,
  )
  if (!result.ok) return { kind: 'error', text: result.message }
  return { kind: 'success', text: `Sent to ${parsed.sessionId}` }
}
