/** Host BFF policy for resolving Remote Agent and Session identities. */

import { isDeepStrictEqual } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'

/** Caller-facing failures preserved by the Gateway's RPC adapter. */
export type ApiRemoteLookupError =
  | { readonly code: 'agent-busy'; readonly message: string; readonly details: { readonly reason: string } }
  | { readonly code: 'session-not-found'; readonly message: string; readonly details: { readonly sessionId: SessionId } }
  | { readonly code: 'internal'; readonly message: string; readonly details: Record<never, never> }

/** Result of resolving one session identity to its live Agent. */
export type ApiRemoteAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiRemoteLookupError }

/** Resume configuration supplied by the owning Host composition. */
export interface ApiRemoteAgentOptions {
  /** Read the per-Agent defaults when a cold identity must resume. */
  readonly agentOptions?: () => AgentOptions
  /**
   * Build the Host-specific Agent-scope composition completed before
   * publication. Keyed by the resumed session itself because what a Host
   * installs may depend on what that session recorded: an agent preset fixes
   * the tools its history was produced under, so rebuilding it under another
   * composition would replay tool calls the agent can no longer make. The
   * events come along because a session's own record of such a choice may be
   * an event rather than a header field.
   * @param session - the resumed session's persisted header and event log.
   * @returns the Agent-scope setup to run before publication.
   */
  readonly setup?: (
    session: { meta: SessionHeader; events: readonly SessionEvent[] },
  ) => AgentSetup | Promise<AgentSetup>
}

/** Cold identity absent from the durable session store. */
export class ApiRemoteSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiRemoteSubagentSessionOwnership extends Error {
  /**
   * Construct the ownership fence.
   * @param sessionId - identity reserved to subagent routing.
   */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Session identity that executes on a remote node and must not gain a local writer. */
export class ApiRemoteRoutedSession extends Error {
  /**
   * Construct the routed-execution fence.
   * @param sessionId - identity owned by the remote node.
   * @param authority - the owning remote source id.
   */
  constructor(
    readonly sessionId: SessionId,
    readonly authority: string,
  ) {
    super(`session "${sessionId}" executes on "${authority}"; route operations through its owning node`)
  }
}

/**
 * Test whether generic Host routing must leave an identity to subagent routing.
 * @param ctx - Host Context carrying the live Agent registry.
 * @param session - attached or live Session metadata.
 * @param agent - live Agent when one is registered.
 * @returns whether generic Remote and legacy API calls must reject the identity.
 */
export function hasApiRemoteSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing ownership rejection.
 * @param sessionId - identity reserved to subagent routing.
 * @returns the existing `agent-busy` RPC shape.
 */
export function apiRemoteSubagentOwnershipError(sessionId: SessionId): ApiRemoteLookupError {
  return {
    code: 'agent-busy',
    message: `session "${sessionId}" is owned by subagent routing`,
    details: { reason: 'use subagent delivery for this child session' },
  }
}

/**
 * Read one session through the session-sources seam, unwrapping the aggregate
 * service's `{ source, session }` shape and accepting the bare single-source
 * shape as well.
 * @param ctx - Host Context carrying the optional session-sources service.
 * @param sessionId - identity to read from any remote source.
 * @param sourceId - restrict the read to the source with this id (a
 *   {@link SessionHeader.remoteAuthority} hint that bypasses the registry
 *   scan, which a registered local source would otherwise answer with a
 *   materialized copy's stale log).
 * @returns the answering source's id (absent for the bare shape), the remote
 * header, and event log, or undefined when no source knows the identity.
 */
async function readRemoteSession(
  ctx: Context,
  sessionId: SessionId,
  sourceId?: string,
): Promise<{ sourceId: string | undefined; header: SessionHeader; events: SessionEvent[] } | undefined> {
  const sources = ctx.get('sessionSources') as {
    getSession?: (id: SessionId, hint?: string) => Promise<
      | { source?: { id?: unknown }; session?: { header: SessionHeader; events: SessionEvent[] } }
      | { header: SessionHeader; events: SessionEvent[] }
      | undefined
    >
  } | undefined
  if (sources?.getSession === undefined) return undefined
  const remote = await sources.getSession(sessionId, sourceId)
  if (remote === undefined) return undefined
  const inspection = 'session' in remote && remote.session !== undefined
    ? remote.session
    : (remote as { header: SessionHeader; events: SessionEvent[] })
  if (inspection.header === undefined || !Array.isArray(inspection.events)) return undefined
  const answeringSourceId = sourceId
    ?? ('source' in remote && typeof remote.source?.id === 'string' ? remote.source.id : undefined)
  return { sourceId: answeringSourceId, header: inspection.header, events: inspection.events }
}

/** Structural read/append face this module needs from the durable store. */
interface SessionPersistenceLike {
  list(): Promise<SessionHeader[]>
  inspect(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
  create(meta: SessionHeader): Promise<void>
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void>
}

/**
 * Append the remote suffix a materialized local copy is missing, when the
 * local log is a strict seq prefix of the remote one. A local log that
 * diverged or already covers the remote events is left untouched: under the
 * single-writer model a divergence means another owner wrote one of the two
 * logs, and reconciling it is lease protocol work, not this read path's.
 * @param persistence - local durable store holding the materialized copy.
 * @param sessionId - identity with both a local copy and a remote source.
 * @param remote - the remote source's full event log.
 */
async function appendRemoteSuffix(
  persistence: SessionPersistenceLike,
  sessionId: SessionId,
  remote: readonly SessionEvent[],
): Promise<void> {
  const local = await persistence.inspect(sessionId)
  if (local.events.length >= remote.length) return
  for (let index = 0; index < local.events.length; index += 1) {
    // Deep equality, not just seq order: a same-seq different-content prefix
    // means the two logs were written by different owners.
    if (!isDeepStrictEqual(remote[index], local.events[index])) return
  }
  const suffix = remote.slice(local.events.length)
  if (suffix.length > 0) await persistence.append(sessionId, suffix)
}

/**
 * Catch a materialized copy up to its recorded authority's log. Fail-soft: an
 * unreachable or failing authority serves the stale copy rather than failing
 * the read — the copy stays a valid strict-prefix snapshot.
 * @param ctx - Host Context carrying the optional session-sources service.
 * @param persistence - local durable store holding the materialized copy.
 * @param sessionId - identity with a stamped {@link SessionHeader.remoteAuthority}.
 * @param authority - the recorded authority source id.
 */
async function catchUpMaterializedCopy(
  ctx: Context,
  persistence: SessionPersistenceLike,
  sessionId: SessionId,
  authority: string,
): Promise<void> {
  const remote = await readRemoteSession(ctx, sessionId, authority)
  if (remote !== undefined) {
    await appendRemoteSuffix(persistence, sessionId, remote.events)
  }
}

/**
 * Report which remote source owns a session's execution, without resuming or
 * repairing anything. A locally persisted row answers from its
 * {@link SessionHeader.remoteAuthority} stamp (a stamped copy stays an
 * offline cache); an unstamped local row means this node owns the session;
 * otherwise the aggregate source scan answers with the first remote source
 * that knows the identity.
 * @param ctx - Host Context carrying the optional persistence and
 *   session-sources services.
 * @param sessionId - identity to classify.
 * @returns the owning remote source id, or undefined when the session is
 *   local or unknown.
 */
export async function inspectApiRemoteAuthority(
  ctx: Context,
  sessionId: SessionId,
): Promise<string | undefined> {
  const persistence = ctx.get('sessionPersistence') as { list(): Promise<SessionHeader[]> } | undefined
  if (persistence !== undefined) {
    const localMeta = (await persistence.list()).find(candidate => candidate.id === sessionId)
    if (localMeta !== undefined) return localMeta.remoteAuthority
  }
  const remote = await readRemoteSession(ctx, sessionId)
  return remote?.sourceId
}

/**
 * Inspect one cold served session without repairing, resuming, or publishing it.
 * A materialized copy (stamped {@link SessionHeader.remoteAuthority}) catches
 * up to its authority's log first, so reads never serve a prefix the authority
 * has already grown past.
 * @param ctx - Host Context carrying the optional persistence provider.
 * @param sessionId - durable identity to inspect.
 * @returns detached metadata and events for a servable session.
 * @throws {@link ApiRemoteSessionNotFound} when the identity has no project-backed session.
 */
export async function inspectApiRemoteSession(
  ctx: Context,
  sessionId: SessionId,
): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
  if (persistence !== undefined) {
    const meta = (await persistence.list()).find(candidate => candidate.id === sessionId)
    if (meta !== undefined && meta.cwd !== undefined) {
      if (meta.remoteAuthority !== undefined) {
        try {
          await catchUpMaterializedCopy(ctx, persistence, sessionId, meta.remoteAuthority)
        } catch {
          // The authority fetch or suffix append failed; the stale local copy
          // below is still a servable strict-prefix snapshot.
        }
      }
      const inspected = await persistence.inspect(sessionId)
      if (inspected.meta.cwd !== undefined) {
        return { meta: inspected.meta, events: [...inspected.events] }
      }
    }
  }

  const remote = await readRemoteSession(ctx, sessionId)
  if (remote !== undefined) {
    return {
      meta: remote.sourceId === undefined ? remote.header : { ...remote.header, remoteAuthority: remote.sourceId },
      events: [...remote.events],
    }
  }

  if (persistence === undefined) {
    throw new Error('session persistence is not configured (load a dsh-session-persistence backend)')
  }
  throw new ApiRemoteSessionNotFound(`session "${sessionId}" not found`)
}

/**
 * Create the Host's shared Agent resolver and configure Agent/Session Typert lookups.
 * Live Agents are reused, ordinary cold sessions resume once per identity, and
 * subagent-owned identities retain the legacy `agent-busy` fence.
 * @param ctx - owning Host Context.
 * @param options - defaults and Agent-scope setup used only for cold resume.
 * @returns resolver shared by legacy API Proxy methods and Typert lookups.
 */
export function createApiRemoteAgentResolver(
  ctx: Context,
  options: ApiRemoteAgentOptions,
): (sessionId: SessionId) => Promise<ApiRemoteAgentResult> {
  const resumes = new Map<SessionId, Promise<Agent>>()

  const fencedLiveAgent = (sessionId: SessionId): ApiRemoteAgentResult | undefined => {
    const live = ctx.agents.get(sessionId)
    if (live === undefined) return undefined
    if (hasApiRemoteSubagentOwner(ctx, live.session, live)) {
      return { error: apiRemoteSubagentOwnershipError(sessionId) }
    }
    return { agent: live }
  }

  const agentFor = async (sessionId: SessionId): Promise<ApiRemoteAgentResult> => {
    const fenced = fencedLiveAgent(sessionId)
    if (fenced !== undefined) return fenced
    const attached = ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiRemoteSubagentOwner(ctx, attached, undefined)) {
      return { error: apiRemoteSubagentOwnershipError(sessionId) }
    }
    let resume = resumes.get(sessionId)
    if (resume === undefined) {
      resume = (async () => {
        try {
          const inspected = await inspectApiRemoteSession(ctx, sessionId)
          if (hasApiRemoteSubagentOwner(ctx, { header: inspected.meta }, undefined)) {
            throw new ApiRemoteSubagentSessionOwnership(sessionId)
          }
          // A remote-authority session executes on its owning node; attaching
          // a local writer would migrate execution and strand the log. Reads
          // serve detached (or from the offline cache), writes route through
          // the session's federation channel, and this refusal is the safety
          // net for any verb that reaches the resolver unguarded. A session
          // absent from the local durable store but known to a source is
          // equally remote, even when that source names itself nowhere.
          const localRows = ctx.get('sessionPersistence') as
            | { list(): Promise<SessionHeader[]> }
            | undefined
          const knownLocally = localRows === undefined
            || (await localRows.list()).some(candidate => candidate.id === sessionId)
          if (!knownLocally) {
            throw new ApiRemoteRoutedSession(
              sessionId,
              inspected.meta.remoteAuthority ?? 'an unattributed remote source',
            )
          }
          if (inspected.meta.remoteAuthority !== undefined) {
            throw new ApiRemoteRoutedSession(sessionId, inspected.meta.remoteAuthority)
          }
          // Built from the inspected session before the published re-checks
          // below, so those stay adjacent to `resume` and a Host setup that
          // awaits (composing a preset, say) does not widen the collision
          // window.
          const setup = options.setup === undefined ? undefined : await options.setup(inspected)
          const publishedSession = ctx.sessions.get(sessionId)
          const publishedAgent = ctx.agents.get(sessionId)
          if (publishedSession !== undefined
            && hasApiRemoteSubagentOwner(ctx, publishedSession, publishedAgent)) {
            throw new ApiRemoteSubagentSessionOwnership(sessionId)
          }
          const handle = await ctx.agents.resume({
            resumeSessionId: sessionId,
            ...options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions() },
            ...setup === undefined ? {} : { setup },
          })
          return handle.agent
        } finally {
          resumes.delete(sessionId)
        }
      })()
      resumes.set(sessionId, resume)
    }
    try {
      return { agent: await resume }
    } catch (error: unknown) {
      if (error instanceof ApiRemoteSessionNotFound) {
        return { error: { code: 'session-not-found', message: error.message, details: { sessionId } } }
      }
      if (error instanceof ApiRemoteSubagentSessionOwnership) {
        return { error: apiRemoteSubagentOwnershipError(error.sessionId) }
      }
      if (error instanceof ApiRemoteRoutedSession) {
        return {
          error: {
            code: 'internal',
            message: `session "${error.sessionId}" executes on "${error.authority}"; route operations through its owning node`,
            details: {},
          },
        }
      }
      const fenced = fencedLiveAgent(sessionId)
      if (fenced !== undefined) return fenced
      const attached = ctx.sessions.get(sessionId)
      if (attached !== undefined && hasApiRemoteSubagentOwner(ctx, attached, undefined)) {
        return { error: apiRemoteSubagentOwnershipError(sessionId) }
      }
      return {
        error: {
          code: 'internal',
          message: `resume failed for session "${sessionId}": ${String(error)}`,
          details: {},
        },
      }
    }
  }

  ctx.inject(['typert'], (typeCtx) => {
    const resolveAgent = async (sessionId: SessionId): Promise<Agent> => {
      const found = await agentFor(sessionId)
      if ('error' in found) throw new TypertLookupFailure(found.error)
      return found.agent
    }
    typeCtx.typert.lookups.configure('agent', resolveAgent)
    typeCtx.typert.lookups.configure('session', async sessionId => (await resolveAgent(sessionId)).session)
    typeCtx.typert.contexts.configureHost('agent', async sessionId => (await resolveAgent(sessionId)).ctx)
  })

  return agentFor
}
