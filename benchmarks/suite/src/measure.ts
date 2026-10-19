import { resolve } from 'node:path'
import { checkReplies } from './check.ts'
import { HEADER_VARIANT_ENV, HEADLINE_CONNECTIONS, ROUTE_PATHS } from './constants.ts'
import { applyLoad, type LoadRequest } from './load.ts'
import type { SuiteOptions } from './options.ts'
import { type ServerProcess, startServer } from './process.ts'
import type { FailedMeasurement, HeaderVariant, Measurement, Pinning, RouteId, ServerId } from './types.ts'

export interface MeasureTarget {
  readonly server: ServerId
  readonly serverName: string
  readonly variant: HeaderVariant
  readonly route: RouteId
}

export interface MeasureContext {
  readonly options: SuiteOptions
  readonly pinning: Pinning
  readonly uploadFile: string
}

export interface MeasureOutcome {
  readonly measurements: Measurement[]
  readonly failures: FailedMeasurement[]
}

function describe(target: MeasureTarget): string {
  const headers = target.variant === 'secure' ? 'with security headers' : 'without security headers'
  return `${target.serverName} ${headers}, ${target.route} route`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function loadRequest(
  context: MeasureContext,
  target: MeasureTarget,
  origin: string,
  connections: number,
  durationMs: number,
): LoadRequest {
  return {
    url: `${origin}${ROUTE_PATHS[target.route]}`,
    connections,
    threads: context.options.loadThreads,
    durationMs,
    uploadFile: target.route === 'upload' ? context.uploadFile : null,
    loadCpus: context.pinning.load_cpus,
  }
}

async function measureLevel(
  context: MeasureContext,
  target: MeasureTarget,
  server: ServerProcess,
  connections: number,
): Promise<Measurement> {
  const request = loadRequest(context, target, server.origin, connections, context.options.measureDurationMs)
  const cpuBefore = await server.cpuSeconds()
  const startedAt = performance.now()
  const outcome = await applyLoad(request)
  const elapsedSeconds = (performance.now() - startedAt) / 1_000
  const cpuAfter = await server.cpuSeconds()
  return {
    server: target.server,
    headers: target.variant,
    route: target.route,
    connections,
    requests: outcome.requests,
    requests_per_second: outcome.requestsPerSecond,
    latency: outcome.latency,
    cpu_cores_busy: (cpuAfter - cpuBefore) / elapsedSeconds,
  }
}

export async function measureTarget(context: MeasureContext, target: MeasureTarget): Promise<MeasureOutcome> {
  const outcome: MeasureOutcome = { measurements: [], failures: [] }
  const label = describe(target)
  let server: ServerProcess
  try {
    server = await startServer({
      label: target.serverName,
      script: resolve(import.meta.dirname, 'servers', `${target.server}.ts`),
      env: { [HEADER_VARIANT_ENV]: target.variant },
      cpu: context.pinning.server_cpu,
    })
  } catch (error) {
    console.error(`${label}: the server failed to start. ${errorText(error)}`)
    outcome.failures.push({ ...failureOf(target, null), error: errorText(error) })
    return outcome
  }
  try {
    await checkReplies(target.serverName, server.origin, target.variant)
    const warmUp = loadRequest(context, target, server.origin, HEADLINE_CONNECTIONS, context.options.warmUpDurationMs)
    await applyLoad(warmUp)
    for (const connections of context.options.connectionLevels) {
      try {
        const measurement = await measureLevel(context, target, server, connections)
        outcome.measurements.push(measurement)
        console.log(
          `${label}, ${connections} connections: ${Math.round(measurement.requests_per_second).toLocaleString('en-GB')} req/s`,
        )
      } catch (error) {
        console.error(`${label}, ${connections} connections: ${errorText(error)}`)
        outcome.failures.push({ ...failureOf(target, connections), error: errorText(error) })
      }
    }
  } catch (error) {
    console.error(`${label}: ${errorText(error)}`)
    outcome.failures.push({ ...failureOf(target, null), error: errorText(error) })
  } finally {
    await server.stop()
  }
  return outcome
}

function failureOf(target: MeasureTarget, connections: number | null): Omit<FailedMeasurement, 'error'> {
  return { server: target.server, headers: target.variant, route: target.route, connections }
}
