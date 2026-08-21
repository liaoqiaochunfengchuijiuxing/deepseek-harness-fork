/**
 * Federation session persistence: local spool first, then asynchronous upload
 * to the hub writer store. Network failure does not fail a local append.
 * @module @deepseek-ai/dsh-session-persistence-federation
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type SessionPreparation,
} from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-federation-client'

export const name = 'session-persistence-federation'
export const inject = ['sessions']

/** Plugin config for federation session persistence. */
export interface Config {
  /** Directory for local spool files. Required. */
  spoolRoot: string
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/** Loader schema for {@link FederationSessionPersistence}. */
export const Config: z<Config> = z.object({
  spoolRoot: z.string().required().description('Directory for local session spool files'),
  preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
  writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
    .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
})

type SpoolEntry = { meta: SessionHeader; events: SessionEvent[] }

/**
 * Local-first SessionPersistence that uploads committed events to the hub.
 * Resume/takeover use the same append/readFrom/prepare/revision path as other backends.
 */
export class FederationSessionPersistence extends SessionPersistence implements PersistenceBackend<never> {
  override readonly supportsRawArtifacts = false
  static inject = ['sessions']

  static Config = Config

  override readonly name = 'session-persistence-federation'

  private readonly root: string
  private readonly store = new Map<string, SpoolEntry>()
  private readonly coordinator: PersistenceCoordinator<never>
  private readonly uploadTails = new Map<string, Promise<void>>()
  private readonly ackedSeq = new Map<string, number>()
  private loading: Promise<void> | undefined
  private loaded = false
  private disposed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.root = resolve(config.spoolRoot)
    this.coordinator = new PersistenceCoordinator<never>(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
    this.ctx.effect(() => () => {
      this.disposed = true
    }, 'federation.session-persistence.dispose')
  }

  /* jscpd:ignore-start */
  locate(meta: SessionHeader): SessionLocation {
    return { kind: 'federation-spool', path: this.spoolPath(meta.id) }
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.acquireLease(id).then(() => this.coordinator.prepare(id, signal))
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{
    meta: SessionHeader
    events: SessionEvent[]
  }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }
  /* jscpd:ignore-end */

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    await this.ensureLoaded()
    signal?.throwIfAborted()
    return [...this.store.values()].map(entry => structuredClone(entry.meta))
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    await this.ensureLoaded()
    signal?.throwIfAborted()
    return [...this.store.values()].map(entry => ({
      header: structuredClone(entry.meta),
      revision: this.revisionOf(entry),
    }))
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    await this.ensureLoaded()
    signal?.throwIfAborted()
    const entry = this.store.get(String(id))
    if (entry === undefined) return undefined
    return {
      meta: structuredClone(entry.meta),
      events: structuredClone(entry.events),
      revision: this.revisionOf(entry),
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    await this.ensureLoaded()
    signal?.throwIfAborted()
    const entry = this.store.get(String(id))
    return entry === undefined ? undefined : this.revisionOf(entry)
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ensureLoaded()
    const key = String(meta.id)
    const existing = this.store.get(key)
    if (existing === undefined) {
      if (isMaterialized) throw new Error(`session "${key}" is not materialized`)
      const created = {
        meta: structuredClone(meta),
        events: structuredClone(events) as SessionEvent[],
      }
      this.store.set(key, created)
      await this.flushSpool(created)
    } else {
      existing.events.push(...structuredClone(events) as SessionEvent[])
      await this.flushSpool(existing)
    }
    this.enqueueUpload(meta.id)
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    await this.ensureLoaded()
    const entry = this.store.get(String(meta.id))
    if (entry === undefined || closers.length === 0) return
    entry.events.push(...structuredClone(closers) as SessionEvent[])
    await this.flushSpool(entry)
    this.enqueueUpload(meta.id)
  }

  /**
   * Release the hub writer lease after a local flush so another node can acquire.
   * @param id - session whose lease this node holds.
   */
  async releaseWriter(id: SessionId): Promise<void> {
    const client = this.ctx.get('federationClient')
    if (client === undefined || client.getStatus() !== 'connected') return
    const result = await client.leaseSession('session/lease-release', id)
    if (!result.ok) throw new Error(result.message)
  }

  /**
   * Refuse a log that this build cannot reconstruct.
   * @param events - candidate events.
   * @param formatVersion - writer format version.
   */
  static assertTakeoverCompatible(events: readonly SessionEvent[], formatVersion: number): void {
    if (formatVersion !== SESSION_FORMAT_VERSION) {
      throw new Error(
        `federated session uses log format v${formatVersion}, this harness reads v${SESSION_FORMAT_VERSION}`,
      )
    }
    for (const event of events) {
      if (event.ignorable === true) continue
      if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) {
        throw new Error(`federated session contains unknown required event type ${event.type} at seq ${event.seq}`)
      }
    }
  }

  private spoolPath(id: SessionId): string {
    return join(this.root, `${id}.json`)
  }

  private revisionOf(entry: SpoolEntry): SessionPersistenceRevision {
    const last = entry.events.at(-1)
    return SessionPersistenceRevision(`${entry.events.length}:${last?.seq ?? -1}`)
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    this.loading ??= this.readSpool().then(
      () => {
        this.loaded = true
      },
      (err: unknown) => {
        this.loading = undefined
        throw err
      },
    )
    return this.loading
  }

  private async readSpool(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const names = await readdir(this.root)
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const raw = await readFile(join(this.root, name), 'utf8')
      const parsed = JSON.parse(raw) as SpoolEntry
      this.store.set(String(parsed.meta.id), parsed)
    }
  }

  private async flushSpool(entry: SpoolEntry): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFile(this.spoolPath(entry.meta.id), JSON.stringify(entry), 'utf8')
  }

  private enqueueUpload(id: SessionId): void {
    const key = String(id)
    const prev = this.uploadTails.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.upload(id)).catch(() => undefined)
    this.uploadTails.set(key, next)
  }

  private async upload(id: SessionId): Promise<void> {
    if (this.disposed) return
    const client = this.ctx.get('federationClient')
    if (client === undefined || client.getStatus() !== 'connected') return
    const entry = this.store.get(String(id))
    if (entry === undefined) return
    const acked = this.ackedSeq.get(String(id)) ?? -1
    const fresh = entry.events.filter(event => event.seq > acked)
    if (fresh.length === 0) return
    const result = await client.persistSession(
      id,
      fresh,
      acked < 0 ? entry.meta : undefined,
    )
    if (result.ok) this.ackedSeq.set(String(id), result.lastSeq)
  }

  private async acquireLease(id: SessionId): Promise<void> {
    const client = this.ctx.get('federationClient')
    if (client === undefined || client.getStatus() !== 'connected') return
    const result = await client.leaseSession('session/lease-acquire', id)
    if (!result.ok) {
      throw new Error(result.message)
    }
  }
}

export default FederationSessionPersistence
