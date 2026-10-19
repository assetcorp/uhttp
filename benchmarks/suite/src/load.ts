import {
  LOAD_TIMEOUT_GRACE_MS,
  MAX_LOAD_OUTPUT_BYTES,
  MIN_H2LOAD_VERSION,
  PIPELINED_REQUESTS,
  TOOL_OUTPUT_TIMEOUT_MS,
  UPLOAD_CONTENT_TYPE,
} from './constants.ts'
import { pinnedCommand, runFile } from './tools.ts'
import type { LatencySummary } from './types.ts'

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

const MIN_H2LOAD_VERSION_TEXT = MIN_H2LOAD_VERSION.join('.')

const H2LOAD_INSTALL_HINT = `Install h2load ${MIN_H2LOAD_VERSION_TEXT} or later, which prints the median and the percentiles of the request times that the suite reads. On macOS, brew install nghttp2 installs it. Ubuntu 24.04 packages h2load 1.59.0, so on Ubuntu, build h2load from the nghttp2 release as benchmarks/cloud/remote-bootstrap.sh does.`

function isOlderThanMinimum(version: readonly number[]): boolean {
  for (const [index, minimum] of MIN_H2LOAD_VERSION.entries()) {
    const part = version[index] ?? 0
    if (part !== minimum) return part < minimum
  }
  return false
}

export async function requireH2load(): Promise<void> {
  let stdout: string
  try {
    stdout = (await runFile('h2load', ['--version'], { timeout: TOOL_OUTPUT_TIMEOUT_MS })).stdout
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error(H2LOAD_INSTALL_HINT)
    throw error
  }
  const version = /nghttp2\/(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.slice(1).map(Number)
  if (version === undefined)
    throw new Error(`h2load printed the version '${stdout.trim()}', which the suite cannot read.`)
  if (isOlderThanMinimum(version)) {
    throw new Error(`The suite found h2load ${version.join('.')}. ${H2LOAD_INSTALL_HINT}`)
  }
}

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
  const [program, programArgs] = pinnedCommand(request.loadCpus, 'h2load', h2loadArguments(request))
  try {
    const { stdout } = await runFile(program, programArgs, {
      timeout: request.durationMs + LOAD_TIMEOUT_GRACE_MS,
      maxBuffer: MAX_LOAD_OUTPUT_BYTES,
    })
    return stdout
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error(H2LOAD_INSTALL_HINT)
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
