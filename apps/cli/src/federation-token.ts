/**
 * `dsh federation-token` — manage the hub's per-pod federation token
 * registry: mint a token bound to one pod identity, list entries without
 * full secrets, or revoke a pod's active credential. The secret is printed
 * exactly once, at issue time, to this process's stdout — never through a
 * session transcript, where it would be durably logged.
 *
 * Run against the hub's `$DSH_HOME` (the registry defaults to
 * `$DSH_HOME/federation/tokens.json`); in a container deployment that means
 * exec-ing inside the hub container.
 * @module @deepseek-ai/dsh/federation-token
 */

import type { FederationTokenInvocation } from './args.ts'
import type { FederationTokenRole } from '@deepseek-ai/dsh-federation-hub'
import {
  defaultFederationTokenRegistryPath,
  issueFederationToken,
  listFederationTokens,
  revokeFederationToken,
} from '@deepseek-ai/dsh-federation-hub'

/** The closed set of permission levels an issued token may carry. */
const ROLES: readonly FederationTokenRole[] = ['read', 'command', 'manage', 'takeover']

/**
 * Run one federation-token invocation.
 * @param invocation - the parsed CLI invocation.
 * @returns the process exit code.
 */
export async function runFederationToken(invocation: FederationTokenInvocation): Promise<number> {
  const registryPath = invocation.registryPath ?? defaultFederationTokenRegistryPath()
  try {
    if (invocation.action === 'issue') {
      const podId = invocation.podId as string
      const role = invocation.role === undefined ? 'command' : parseRole(invocation.role)
      const entry = await issueFederationToken(registryPath, {
        podId,
        role,
        ...invocation.name === undefined ? {} : { name: invocation.name },
      })
      process.stdout.write(
        `pod: ${entry.podId}\n`
        + `role: ${entry.role}\n`
        + `token: ${entry.token}\n`
        + `registry: ${registryPath}\n`
        + 'the token is shown once; store it now\n',
      )
      return 0
    }
    if (invocation.action === 'revoke') {
      const podId = invocation.podId as string
      const revoked = await revokeFederationToken(registryPath, podId)
      if (!revoked) {
        process.stderr.write(`no active token for pod "${podId}" in ${registryPath}\n`)
        return 1
      }
      process.stdout.write(`revoked the active token for pod "${podId}"\n`)
      return 0
    }
    const entries = await listFederationTokens(registryPath)
    if (entries.length === 0) {
      process.stdout.write(`no federation tokens in ${registryPath}\n`)
      return 0
    }
    for (const entry of entries) {
      const state = entry.revokedAt === undefined ? 'active' : 'revoked'
      const label = entry.name === undefined ? '' : `  (${entry.name})`
      process.stdout.write(
        `${entry.podId}${label}\n`
        + `  role: ${entry.role}  state: ${state}  token: ${entry.tokenPrefix}…\n`,
      )
    }
    return 0
  } catch (error: unknown) {
    process.stderr.write(`federation-token: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * Validate a role argument against the closed set.
 * @param value - the raw `--role` value.
 * @returns the parsed role.
 */
function parseRole(value: string): FederationTokenRole {
  const role = ROLES.find(candidate => candidate === value)
  if (role === undefined) {
    throw new Error(`unknown role ${JSON.stringify(value)}; expected one of ${ROLES.join(', ')}`)
  }
  return role
}
