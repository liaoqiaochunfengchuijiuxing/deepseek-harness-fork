/**
 * Remote subagent provider plugin. Registers a named subagent provider on `ctx.subagents`
 * that delegates execution over WebSocket to a remote endpoint (such as a federation hub
 * or pod).
 *
 * @module @deepseek-ai/dsh-subagent-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SubagentCapabilities, SubagentProvider, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  validateConfiguredCwd,
} from '@deepseek-ai/dsh-subagent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  startRemoteRun,
  type RemoteRunSpec,
} from './run.ts'

export { DEFAULT_CONNECT_TIMEOUT_MS, normalizeWsEndpoint, remoteStopReason, startRemoteRun } from './run.ts'
export type { RemoteRunSpec } from './run.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'subagent-remote'

/** Service requirements for the remote subagent provider. */
export const inject = ['subagents']

/** Config: how to connect to the remote federation endpoint. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `remote`). */
  providerName?: string
  /** WebSocket endpoint of the remote host (e.g. `ws://localhost:3080/federation/subagent` or `wss://...`). */
  endpoint: string
  /** Literal authentication token; prefer {@link tokenEnv} so no secret enters configuration files. */
  token?: string
  /** Credential reference (environment variable name) for the token; e.g. `DSH_POD_TOKEN` or `FEDERATION_TOKEN`. */
  tokenEnv?: string
  /**
   * Working directory override for the remote session workspace.
   * When omitted, each child inherits its delegating parent session's cwd.
   */
  cwd?: string
  /** Bound (ms) on establishing WebSocket connection (default 5000). */
  connectTimeoutMs?: number
  /**
   * Hub-registered pod id for peer relay. When set, the start message carries
   * `targetPodId` so the hub forwards to that pod instead of picking any online pod.
   */
  targetPodId?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('remote'),
  endpoint: z.string().required(),
  token: z.string().role('secret'),
  tokenEnv: z.string().role('credential-ref'),
  cwd: z.string(),
  connectTimeoutMs: z.number().step(1).min(1).default(DEFAULT_CONNECT_TIMEOUT_MS),
  targetPodId: z.string().description('Hub-registered pod id for peer relay'),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'token' | 'tokenEnv' | 'targetPodId'>>
  & Pick<Config, 'cwd' | 'token' | 'tokenEnv' | 'targetPodId'>

/** Resolve the authentication token from config or credentials seam. */
async function resolveToken(ctx: Context, config: ResolvedConfig): Promise<string | undefined> {
  if (config.token !== undefined && config.token.length > 0) return config.token
  if (config.tokenEnv !== undefined && config.tokenEnv.length > 0) {
    const ref = credentialRef(config.tokenEnv)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return ambient.value
    }
  }
  return undefined
}

/**
 * The remote subagent provider. Advertises NO start-time capabilities:
 * an out-of-process remote child cannot honor `outputSchema`/`maxDepth`/`toolFilter`/`persona`.
 */
class RemoteSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: SubagentStartRequest) {
    const token = await resolveToken(this.ctx, this.config)
    const spec: RemoteRunSpec = {
      endpoint: this.config.endpoint,
      ...token !== undefined ? { token } : {},
      cwd: resolveChildCwd('subagent-remote', this.config.cwd, request.parent.session.header.cwd),
      connectTimeoutMs: this.config.connectTimeoutMs,
      ...this.config.targetPodId !== undefined ? { targetPodId: this.config.targetPodId } : {},
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`subagent-remote "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startRemoteRun(request, spec)
  }
}

/**
 * Register the remote subagent provider on `ctx.subagents`.
 * @param ctx - Cordis context carrying the subagent service.
 * @param config - Provider configuration options.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const connectTimeoutMs = resolved.connectTimeoutMs
  assertPositiveFinite('subagent-remote', 'connectTimeoutMs', connectTimeoutMs)
  const configuredCwd = validateConfiguredCwd('subagent-remote', resolved.cwd)
  const validated: ResolvedConfig = {
    ...resolved,
    providerName: resolved.providerName,
    connectTimeoutMs,
    ...configuredCwd !== undefined ? { cwd: configuredCwd } : {},
  }
  ctx.subagents.registerProvider(new RemoteSubagentProvider(validated.providerName, ctx, validated))
}
