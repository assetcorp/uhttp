import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LOAD_OUTPUT_MAX_BYTES, LOAD_TIMEOUT_GRACE_MS, PIPELINED_REQUESTS, UPLOAD_CONTENT_TYPE } from './constants.ts'
import type { LatencySummary } from './types.ts'

const runFile = promisify(execFile)

export interface LoadRequest {
  readonly url: string
  readonly connections: number
  readonly threads: number
  readonly durationMs: number
  readonly uploadFile: string | null
  readonly loadCpus: string | null
}

export interface LoadOutcome {
  readonly requests: number
  readonly requestsPerSecond: number
  readonly latency: LatencySummary
}

const UNIT_TO_MS: Readonly<Record<string, number>> = { us: 0.001, ms: 1, s: 1_000 }

function countIn(output: string, pattern: RegExp, label: string): number {
  const digits = pattern.exec(output)?.[1]
  if (digits === undefined) throw new Error(`h2load printed no ${label}:\n${output}`)
  return Number(digits)
}

function milliseconds(text: string): number {
  const match = /^([\d.]+)(us|ms|s)$/.exec(text)
  const amount = match?.[1]
  const unit = match?.[2]
  const scale = unit === undefined ? undefined : UNIT_TO_MS[unit]
  if (amount === undefined || scale === undefined)
    throw new Error(`h2load printed the time '${text}', which the suite cannot read.`)
  return Number(amount) * scale
}

function latencyIn(output: string): LatencySummary {
  const line = /^request\s+:\s+(.+)$/m.exec(output)?.[1]
  if (line === undefined) throw new Error(`h2load printed no request times:\n${output}`)
  const [min, max, median, p95, p99, mean] = line.trim().split(/\s+/)
  if (
    min === undefined ||
    max === undefined ||
    median === undefined ||
    p95 === undefined ||
    p99 === undefined ||
    mean === undefined
  ) {
    throw new Error(`h2load printed the request times '${line}', which the suite cannot read.`)
  }
  return {
    p50_ms: milliseconds(median),
    p95_ms: milliseconds(p95),
    p99_ms: milliseconds(p99),
    max_ms: milliseconds(max),
    mean_ms: milliseconds(mean),
  }
}

function h2loadArguments(request: LoadRequest): string[] {
  const args = [
    '--h1',
    '-c',
    String(request.connections),
    '-m',
    String(PIPELINED_REQUESTS),
    '-t',
    String(Math.min(request.threads, request.connections)),
    '-D',
    String(request.durationMs / 1_000),
  ]
  if (request.uploadFile !== null) args.push('-d', request.uploadFile, '-H', `content-type: ${UPLOAD_CONTENT_TYPE}`)
  args.push(request.url)
  return args
}

async function runH2load(request: LoadRequest): Promise<string> {
  const args = h2loadArguments(request)
  const [program, ...programArgs] =
    request.loadCpus === null ? ['h2load', ...args] : ['taskset', '-c', request.loadCpus, 'h2load', ...args]
  try {
    const { stdout } = await runFile(program ?? 'h2load', programArgs, {
      timeout: request.durationMs + LOAD_TIMEOUT_GRACE_MS,
      maxBuffer: LOAD_OUTPUT_MAX_BYTES,
    })
    return stdout
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'Install h2load before you run the suite: brew install nghttp2 on macOS, or sudo apt-get install nghttp2-client on Ubuntu.',
      )
    }
    throw error
  }
}

export async function applyLoad(request: LoadRequest): Promise<LoadOutcome> {
  const output = await runH2load(request)
  const failed = countIn(output, /^requests:.*?(\d+) failed/m, 'count of failed requests')
  const errored = countIn(output, /^requests:.*?(\d+) errored/m, 'count of errored requests')
  const timedOut = countIn(output, /^requests:.*?(\d+) timeout/m, 'count of timed-out requests')
  const succeeded = countIn(output, /^requests:.*?(\d+) succeeded/m, 'count of succeeded requests')
  const notOk = ['3xx', '4xx', '5xx'].map(group =>
    countIn(output, new RegExp(`^status codes:.*?(\\d+) ${group}`, 'm'), `count of ${group} responses`),
  )
  const rejected = notOk.reduce((sum, count) => sum + count, 0)
  if (failed > 0 || errored > 0 || timedOut > 0 || rejected > 0) {
    throw new Error(
      `h2load counted ${failed} failed, ${errored} errored, and ${timedOut} timed-out requests, and ${rejected} responses outside 2xx.`,
    )
  }
  const requestsPerSecond = countIn(output, /^finished in [^,]+, ([\d.]+) req\/s/m, 'request rate')
  if (requestsPerSecond <= 0 || succeeded <= 0) throw new Error('h2load measured no successful requests.')
  return { requests: succeeded, requestsPerSecond, latency: latencyIn(output) }
}
