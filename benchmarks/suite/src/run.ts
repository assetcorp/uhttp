import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { uploadBody } from './check.ts'
import {
  HEADLINE_CONNECTIONS,
  MACHINE_FILE,
  PIPELINED_REQUESTS,
  PROFILE_ENV,
  RESULTS_FILE,
  RESULTS_SCHEMA_VERSION,
  RUNS_DIRECTORY,
  SMOKE_RUNS_DIRECTORY,
  UPLOAD_BODY_BYTES,
  WRITEUP_DIRECTORY,
} from './constants.ts'
import { machineDetails, serverEntries, uhttpRevision } from './machine.ts'
import { type MeasureContext, measureTarget } from './measure.ts'
import { choosePinning, suiteOptions } from './options.ts'
import type { FailedMeasurement, Measurement, Results } from './types.ts'

const suiteDirectory = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(suiteDirectory, '../..')

function runId(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function writeup(script: string, args: readonly string[]): boolean {
  const writeupDirectory = join(repositoryRoot, WRITEUP_DIRECTORY)
  const result = spawnSync('uv', ['run', '--frozen', 'python', script, ...args], {
    cwd: writeupDirectory,
    stdio: 'inherit',
  })
  if (result.error !== undefined) {
    console.error(`The suite could not start uv, which runs ${script}: ${result.error.message}`)
    return false
  }
  return result.status === 0
}

const options = suiteOptions(process.argv.slice(2), process.env[PROFILE_ENV])
const createdAt = new Date()
const id = runId(createdAt)
const runDirectory = join(repositoryRoot, options.profile === 'smoke' ? SMOKE_RUNS_DIRECTORY : RUNS_DIRECTORY, id)
const pinning = await choosePinning(options.loadThreads)
const scratch = await mkdtemp(join(tmpdir(), 'uhttp-benchmarks-'))
const uploadFile = join(scratch, 'upload.bin')
await writeFile(uploadFile, uploadBody())

const context: MeasureContext = { options, pinning, uploadFile }
const servers = await serverEntries(suiteDirectory, options.servers)
const measurements: Measurement[] = []
const failures: FailedMeasurement[] = []

console.log(`The suite writes run ${id} to ${runDirectory}.`)
try {
  for (const route of options.routes) {
    for (const variant of options.variants) {
      for (const server of servers) {
        const outcome = await measureTarget(context, { server: server.id, serverName: server.name, variant, route })
        measurements.push(...outcome.measurements)
        failures.push(...outcome.failures)
      }
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

const results: Results = {
  schema: RESULTS_SCHEMA_VERSION,
  run_id: id,
  created_at: createdAt.toISOString(),
  ...(await uhttpRevision(repositoryRoot)),
  settings: {
    connection_levels: options.connectionLevels,
    headline_connections: HEADLINE_CONNECTIONS,
    pipelined_requests: PIPELINED_REQUESTS,
    warm_up_seconds: options.warmUpDurationMs / 1_000,
    measure_seconds: options.measureDurationMs / 1_000,
    load_threads: options.loadThreads,
    upload_body_bytes: UPLOAD_BODY_BYTES,
    load_generator: 'h2load',
    pinning,
  },
  servers,
  measurements,
  failures,
}

await mkdir(runDirectory, { recursive: true })
await writeFile(join(runDirectory, MACHINE_FILE), json(await machineDetails(pinning)))
await writeFile(join(runDirectory, RESULTS_FILE), json(results))

const drawn = writeup('draw.py', [runDirectory])
if (failures.length > 0) {
  console.error(
    `${failures.length} measurement(s) failed, so the suite left BENCHMARKS.md unchanged. Read ${RESULTS_FILE} for each error.`,
  )
  process.exitCode = 1
} else if (!drawn) {
  console.error('The comparison and the charts failed to draw, so the suite left BENCHMARKS.md unchanged.')
  process.exitCode = 1
} else if (options.profile === 'smoke') {
  console.log(`The smoke run is in ${runDirectory}, which git ignores and the generator never reads.`)
} else if (!writeup('generate.py', [])) {
  process.exitCode = 1
}
