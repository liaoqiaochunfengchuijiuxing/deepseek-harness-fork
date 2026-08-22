/**
 * Types and configuration schema for @deepseek-ai/dsh-session-source-federation.
 *
 * @module @deepseek-ai/dsh-session-source-federation/types
 */

import Schema from '@deepseek-ai/schemastery'

/** Configuration options for the remote federation session source. */
export interface FederationSessionSourceConfig {
  /** WebSocket endpoint URL of the remote federation hub (e.g. ws://hub.internal:3080/federation/connect). */
  endpoint: string
  /** Literal authentication token. */
  token?: string
  /** Environment variable name holding the authentication token. */
  tokenEnv?: string
  /** Owning pod identity claimed at registration; required when the token is registry-bound to a pod. */
  ownerPodId?: string
  /** Environment variable name holding the owning pod identity (e.g. DSH_POD_ID). */
  ownerPodIdEnv?: string
  /** Unique session source identifier (default 'federation-hub'). */
  sourceId?: string
  /** Human-readable display name for this session source (default 'Hub Sessions'). */
  sourceName?: string
  /** Connection timeout in milliseconds (default 5000). */
  connectTimeoutMs?: number
  /** Request timeout in milliseconds (default 10000). */
  requestTimeoutMs?: number
  /** Whether to automatically reconnect on disconnect (default true). */
  autoReconnect?: boolean
  /** Delay before attempting reconnect in milliseconds (default 2000). */
  reconnectDelayMs?: number
}

/** Schema definition for FederationSessionSourceConfig. */
export const FederationSessionSourceConfig: Schema<FederationSessionSourceConfig> = Schema.object({
  endpoint: Schema.string().required().description('WebSocket endpoint URL of the remote federation hub'),
  token: Schema.string().description('Literal authentication bearer token'),
  tokenEnv: Schema.string().description('Environment variable containing authentication token'),
  ownerPodId: Schema.string().description('Owning pod identity claimed at registration; required when the token is registry-bound to a pod'),
  ownerPodIdEnv: Schema.string().description('Environment variable name holding the owning pod identity (e.g. DSH_POD_ID)'),
  sourceId: Schema.string().default('federation-hub').description('Unique session source identifier'),
  sourceName: Schema.string().default('Hub Sessions').description('Display name for this session source'),
  connectTimeoutMs: Schema.natural().default(5000).description('Connection timeout in milliseconds'),
  requestTimeoutMs: Schema.natural().default(10000).description('Request timeout in milliseconds'),
  autoReconnect: Schema.boolean().default(true).description('Whether to automatically reconnect on disconnect'),
  reconnectDelayMs: Schema.natural().default(2000).description('Delay in milliseconds before reconnecting'),
})
