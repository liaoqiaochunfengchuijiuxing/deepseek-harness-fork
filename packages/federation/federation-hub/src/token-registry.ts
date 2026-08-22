/**
 * File-backed per-pod federation token registry. The hub resolves presented
 * tokens against this store; the `dsh federation-token` CLI mints, lists, and
 * revokes entries. Standalone by design — no Cordis — so the CLI and the hub
 * server share one implementation over one file.
 *
 * @module @deepseek-ai/dsh-federation-hub/token-registry
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { FederationTokenRole } from './types.ts'

/** One minted credential: a secret bound to one pod identity and a role. */
export interface FederationTokenEntry {
  /** Opaque secret presented by the pod; generated at issue time. */
  token: string
  /** Pod identity this token authenticates; the registering podId must match. */
  podId: string
  /** Human-readable label for listings; not used by authentication. */
  name?: string
  /** Permission level granted to the authenticated pod. */
  role: FederationTokenRole
  /** Issue time (epoch ms). */
  createdAt: number
  /** Revocation time (epoch ms); absent means active. */
  revokedAt?: number
}

/** Durable registry file shape. */
export interface FederationTokenRegistryFile {
  version: 1
  tokens: FederationTokenEntry[]
}

/** An entry with the secret reduced to an identifying prefix, for display. */
export type FederationTokenListing = Omit<FederationTokenEntry, 'token'> & { tokenPrefix: string }

/** Options for {@link issueFederationToken}. */
export interface IssueFederationTokenOptions {
  /** Pod identity the new token authenticates. */
  podId: string
  /** Human-readable label recorded with the token. */
  name?: string
  /** Permission level granted (default 'command'). */
  role?: FederationTokenRole
  /** Secret source for tests; defaults to a random 32-byte base64url value. */
  secret?: () => string
}

const TOKEN_BYTES = 32
const LISTING_PREFIX_LENGTH = 8

/** A fresh empty registry; callers mutate the result, so never a shared instance. */
function emptyRegistry(): FederationTokenRegistryFile {
  return { version: 1, tokens: [] }
}

/**
 * Default tokens-file location under the harness home.
 * @returns the resolved registry path (`$DSH_HOME/federation/tokens.json`).
 */
export function defaultFederationTokenRegistryPath(): string {
  return dshHomePath('federation', 'tokens.json')
}

/**
 * Read the registry file. A missing file is an empty registry; a corrupt file
 * fails loud so a half-written store is never silently treated as "no pods".
 * @param path - registry file location.
 * @returns the parsed registry.
 * @throws when the file exists but is not a valid registry.
 */
export async function readFederationTokenRegistry(path: string): Promise<FederationTokenRegistryFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
    throw error
  }
  return parseFederationTokenRegistry(text)
}

/**
 * Parse registry file content.
 * @param text - raw file content.
 * @returns the parsed registry.
 * @throws when the content is not a valid version-1 registry.
 */
export function parseFederationTokenRegistry(text: string): FederationTokenRegistryFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('federation token registry is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { tokens?: unknown }).tokens)) {
    throw new Error('federation token registry is not a version-1 registry file')
  }
  return parsed as FederationTokenRegistryFile
}

/**
 * Mint a token for one pod identity. Issuing again for the same podId rotates
 * the credential: the previous active entry is revoked and the new one wins.
 * @param path - registry file location.
 * @param options - pod identity, label, role, and test secret source.
 * @returns the minted entry, including the secret printed once at issue time.
 */
export async function issueFederationToken(
  path: string,
  options: IssueFederationTokenOptions,
): Promise<FederationTokenEntry> {
  const now = Date.now()
  const entry: FederationTokenEntry = {
    token: (options.secret ?? randomBase64UrlSecret)(),
    podId: options.podId,
    role: options.role ?? 'command',
    createdAt: now,
    ...options.name === undefined ? {} : { name: options.name },
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const file = await readFederationTokenRegistry(path)
    for (const existing of file.tokens) {
      if (existing.podId === options.podId && existing.revokedAt === undefined) {
        existing.revokedAt = now
      }
    }
    file.tokens.push(entry)
    await persistFederationTokenRegistry(path, file)
  })
  return entry
}

/**
 * List registry entries with secrets reduced to an identifying prefix.
 * @param path - registry file location.
 * @returns every entry — active first, revoked trailing — with a token prefix.
 */
export async function listFederationTokens(path: string): Promise<FederationTokenListing[]> {
  const file = await readFederationTokenRegistry(path)
  return file.tokens
    .slice()
    .sort((a, b) => (a.revokedAt === undefined ? 0 : 1) - (b.revokedAt === undefined ? 0 : 1)
      || b.createdAt - a.createdAt)
    .map((entry) => {
      const { token, ...rest } = entry
      return { ...rest, tokenPrefix: token.slice(0, LISTING_PREFIX_LENGTH) }
    })
}

/**
 * Revoke the active token bound to one pod identity.
 * @param path - registry file location.
 * @param podId - the pod whose token is revoked.
 * @returns whether an active entry was revoked.
 */
export async function revokeFederationToken(path: string, podId: string): Promise<boolean> {
  const now = Date.now()
  let revoked = false
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const file = await readFederationTokenRegistry(path)
    for (const entry of file.tokens) {
      if (entry.podId === podId && entry.revokedAt === undefined) {
        entry.revokedAt = now
        revoked = true
      }
    }
    if (revoked) await persistFederationTokenRegistry(path, file)
  })
  return revoked
}

/**
 * Resolve a presented secret to its active entry.
 * @param file - the registry contents.
 * @param token - the secret presented at connection time.
 * @returns the active entry, or undefined for unknown and revoked secrets.
 */
export function resolveFederationToken(
  file: FederationTokenRegistryFile,
  token: string,
): FederationTokenEntry | undefined {
  return file.tokens.find(entry => entry.token === token && entry.revokedAt === undefined)
}

/**
 * Persist the registry atomically with owner-only permissions.
 * @param path - registry file location.
 * @param file - the complete registry contents.
 */
async function persistFederationTokenRegistry(path: string, file: FederationTokenRegistryFile): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** Random URL-safe secret generator. */
function randomBase64UrlSecret(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}
