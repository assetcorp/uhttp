import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { parseArgs, promisify } from 'node:util'
import {
  BENCH_PROFILES,
  DEFAULT_CONNECTION_LEVELS,
  DEFAULT_LOAD_THREADS,
  DEFAULT_MEASURE_DURATION_MS,
  DEFAULT_WARM_UP_DURATION_MS,
  FIRST_PINNED_LOAD_CPU,
  HEADER_VARIANTS,
  PINNED_SERVER_CPU,
  PROFILE_ENV,
  ROUTE_IDS,
  SERVER_IDS,
  SMOKE_CONNECTION_LEVELS,
  SMOKE_MEASURE_DURATION_MS,
  SMOKE_WARM_UP_DURATION_MS,
  TOOL_OUTPUT_TIMEOUT_MS,
} from './constants.ts'
import type { BenchProfile, HeaderVariant, Pinning, RouteId, ServerId } from './types.ts'

const runFile = promisify(execFile)

export interface SuiteOptions {
  readonly profile: BenchProfile
  readonly servers: readonly ServerId[]
  readonly routes: readonly RouteId[]
  readonly variants: readonly HeaderVariant[]
  readonly connectionLevels: readonly number[]
  readonly measureDurationMs: number
  readonly warmUpDurationMs: number
  readonly loadThreads: number
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): readonly T[] {
  if (value === undefined) return allowed
  const chosen: T[] = []
  for (const item of value.split(',')) {
    const match = allowed.find(candidate => candidate === item.trim())
    if (match === undefined) throw new Error(`Set --${flag} to a comma-separated list of ${allowed.join(', ')}.`)
    if (!chosen.includes(match)) chosen.push(match)
  }
  return chosen
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Set --${flag} to a whole number above 0.`)
  return parsed
}

function connectionLevels(value: string | undefined, fallback: readonly number[]): readonly number[] {
  if (value === undefined) return fallback
  const levels = value.split(',').map(item => positiveInteger(item.trim(), 'connections'))
  return [...new Set(levels)].sort((left, right) => left - right)
}

function seconds(value: string | undefined, fallbackMs: number, flag: string): number {
  return value === undefined ? fallbackMs : positiveInteger(value, flag) * 1_000
}

function benchProfile(value: string | undefined): BenchProfile {
  const name = value?.trim()
  if (name === undefined || name === '') return 'published'
  const match = BENCH_PROFILES.find(profile => profile === name)
  if (match === undefined) throw new Error(`Set ${PROFILE_ENV} to ${BENCH_PROFILES.join(' or ')}, or leave it unset.`)
  return match
}

export function suiteOptions(argv: readonly string[], profileName: string | undefined): SuiteOptions {
  const profile = benchProfile(profileName)
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      servers: { type: 'string' },
      routes: { type: 'string' },
      headers: { type: 'string' },
      connections: { type: 'string' },
      duration: { type: 'string' },
      'warm-up': { type: 'string' },
      threads: { type: 'string' },
    },
  })
  const smoke = profile === 'smoke'
  const servers = pick(values.servers, SERVER_IDS, 'servers')
  const routes = pick(values.routes, ROUTE_IDS, 'routes')
  const variants = pick(values.headers, HEADER_VARIANTS, 'headers')
  const measuresEveryTarget =
    servers.length === SERVER_IDS.length &&
    routes.length === ROUTE_IDS.length &&
    variants.length === HEADER_VARIANTS.length
  if (!smoke && !measuresEveryTarget) {
    throw new Error(
      `A published run measures every server, route, and header set, so set ${PROFILE_ENV}=smoke to measure part of them.`,
    )
  }
  return {
    profile,
    servers,
    routes,
    variants,
    connectionLevels: connectionLevels(values.connections, smoke ? SMOKE_CONNECTION_LEVELS : DEFAULT_CONNECTION_LEVELS),
    measureDurationMs: seconds(
      values.duration,
      smoke ? SMOKE_MEASURE_DURATION_MS : DEFAULT_MEASURE_DURATION_MS,
      'duration',
    ),
    warmUpDurationMs: seconds(
      values['warm-up'],
      smoke ? SMOKE_WARM_UP_DURATION_MS : DEFAULT_WARM_UP_DURATION_MS,
      'warm-up',
    ),
    loadThreads: values.threads === undefined ? DEFAULT_LOAD_THREADS : positiveInteger(values.threads, 'threads'),
  }
}

async function hasTaskset(): Promise<boolean> {
  try {
    await runFile('taskset', ['--version'], { timeout: TOOL_OUTPUT_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

export async function choosePinning(loadThreads: number): Promise<Pinning> {
  const enoughCpus = cpus().length >= FIRST_PINNED_LOAD_CPU + loadThreads
  if (process.platform !== 'linux' || !enoughCpus || !(await hasTaskset())) {
    return { server_cpu: null, load_cpus: null }
  }
  const lastLoadCpu = FIRST_PINNED_LOAD_CPU + loadThreads - 1
  return { server_cpu: PINNED_SERVER_CPU, load_cpus: `${FIRST_PINNED_LOAD_CPU}-${lastLoadCpu}` }
}
