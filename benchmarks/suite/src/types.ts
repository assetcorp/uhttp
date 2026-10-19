import type { BENCH_PROFILES, HEADER_VARIANTS, ROUTE_IDS, SERVER_IDS } from './constants.ts'

export type BenchProfile = (typeof BENCH_PROFILES)[number]

export type ServerId = (typeof SERVER_IDS)[number]

export type RouteId = (typeof ROUTE_IDS)[number]

export type HeaderVariant = (typeof HEADER_VARIANTS)[number]

export interface Pinning {
  readonly server_cpu: number | null
  readonly load_cpus: string | null
}

export interface LoadSettings {
  readonly connection_levels: readonly number[]
  readonly headline_connections: number
  readonly pipelined_requests: number
  readonly warm_up_seconds: number
  readonly measure_seconds: number
  readonly load_threads: number
  readonly upload_body_bytes: number
  readonly load_generator: string
  readonly pinning: Pinning
}

export interface LatencySummary {
  readonly p50_ms: number
  readonly p95_ms: number
  readonly p99_ms: number
  readonly max_ms: number
  readonly mean_ms: number
}

export interface Measurement {
  readonly server: ServerId
  readonly headers: HeaderVariant
  readonly route: RouteId
  readonly connections: number
  readonly requests: number
  readonly requests_per_second: number
  readonly latency: LatencySummary
  readonly cpu_cores_busy: number
}

export interface FailedMeasurement {
  readonly server: ServerId
  readonly headers: HeaderVariant
  readonly route: RouteId
  readonly connections: number | null
  readonly error: string
}

export interface ServerEntry {
  readonly id: ServerId
  readonly name: string
  readonly packages: Readonly<Record<string, string>>
}

export interface UhttpRevision {
  readonly uhttp_commit: string | null
  readonly uhttp_uncommitted_changes: boolean
}

export interface Results extends UhttpRevision {
  readonly schema: number
  readonly run_id: string
  readonly created_at: string
  readonly settings: LoadSettings
  readonly servers: readonly ServerEntry[]
  readonly measurements: readonly Measurement[]
  readonly failures: readonly FailedMeasurement[]
}
