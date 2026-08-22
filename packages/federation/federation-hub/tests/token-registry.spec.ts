/**
 * Per-pod federation token registry: issue/rotate/revoke semantics, secret
 * masking in listings, persistence round-trip, and corrupt-file failure.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  issueFederationToken,
  listFederationTokens,
  parseFederationTokenRegistry,
  readFederationTokenRegistry,
  resolveFederationToken,
  revokeFederationToken,
} from '../src/token-registry.ts'

const roots: string[] = []

function registryPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fed-tokens-'))
  roots.push(root)
  return join(root, 'federation', 'tokens.json')
}

/** Registry path whose parent directory already exists (for direct writes). */
function seededRegistryPath(): string {
  const path = registryPath()
  mkdirSync(dirname(path), { recursive: true })
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('federation token registry', () => {
  it('issues an entry bound to one pod identity and persists it', async () => {
    const path = registryPath()
    const entry = await issueFederationToken(path, { podId: 'pod-1', name: 'Worker One', role: 'manage' })

    expect(entry.podId).toBe('pod-1')
    expect(entry.role).toBe('manage')
    expect(entry.name).toBe('Worker One')
    expect(entry.revokedAt).toBeUndefined()
    expect(entry.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    const file = await readFederationTokenRegistry(path)
    expect(resolveFederationToken(file, entry.token)?.podId).toBe('pod-1')
    expect(resolveFederationToken(file, entry.token)?.role).toBe('manage')
  })

  it('defaults the issued role to command', async () => {
    const entry = await issueFederationToken(registryPath(), { podId: 'pod-1' })
    expect(entry.role).toBe('command')
  })

  it('rotates on re-issue: the previous active token for the pod is revoked', async () => {
    const path = registryPath()
    const first = await issueFederationToken(path, { podId: 'pod-1' })
    const second = await issueFederationToken(path, { podId: 'pod-1' })

    expect(second.token).not.toBe(first.token)
    const file = await readFederationTokenRegistry(path)
    expect(resolveFederationToken(file, first.token)).toBeUndefined()
    expect(resolveFederationToken(file, second.token)?.podId).toBe('pod-1')
  })

  it('revokes only the named pod and keeps other pods active', async () => {
    const path = registryPath()
    const a = await issueFederationToken(path, { podId: 'pod-a' })
    const b = await issueFederationToken(path, { podId: 'pod-b' })

    expect(await revokeFederationToken(path, 'pod-a')).toBe(true)
    expect(await revokeFederationToken(path, 'pod-a')).toBe(false)

    const file = await readFederationTokenRegistry(path)
    expect(resolveFederationToken(file, a.token)).toBeUndefined()
    expect(resolveFederationToken(file, b.token)?.podId).toBe('pod-b')
  })

  it('lists entries with prefixed secrets and active-first ordering', async () => {
    const path = registryPath()
    const first = await issueFederationToken(path, { podId: 'pod-old' })
    await issueFederationToken(path, { podId: 'pod-new' })
    await revokeFederationToken(path, 'pod-old')

    const listing = await listFederationTokens(path)
    expect(listing.map(entry => entry.podId)).toEqual(['pod-new', 'pod-old'])
    for (const entry of listing) {
      expect(entry.tokenPrefix).toHaveLength(8)
      expect(JSON.stringify(listing)).not.toContain(first.token)
    }
  })

  it('treats a missing file as an empty registry and fails loud on corruption', async () => {
    const missing = registryPath()
    expect((await readFederationTokenRegistry(missing)).tokens).toEqual([])
    expect(await listFederationTokens(missing)).toEqual([])

    const corrupt = seededRegistryPath()
    writeFileSync(corrupt, '{not json', { mode: 0o600 })
    await expect(readFederationTokenRegistry(corrupt)).rejects.toThrow(/not valid JSON/)

    const wrongShape = seededRegistryPath()
    writeFileSync(wrongShape, JSON.stringify({ version: 2, tokens: [] }), { mode: 0o600 })
    await expect(readFederationTokenRegistry(wrongShape)).rejects.toThrow(/version-1 registry/)
    expect(() => parseFederationTokenRegistry(JSON.stringify({ version: 1, tokens: {} })))
      .toThrow(/version-1 registry/)
  })

  it('writes the registry owner-only', async () => {
    const path = registryPath()
    await issueFederationToken(path, { podId: 'pod-1' })
    expect((statSync(path).mode & 0o777) & 0o077).toBe(0)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { tokens: { token: string }[] }
    expect(stored.tokens[0]!.token.length).toBeGreaterThan(20)
  })
})
