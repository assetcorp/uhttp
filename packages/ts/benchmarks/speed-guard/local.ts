import { resolve } from 'node:path'
import {
  CONNECTIONS,
  LOAD_THREADS,
  LOCAL_MEASURE_DURATION_MS,
  LOCAL_WARM_UP_DURATION_MS,
  MAX_SLOWDOWN_FROM_BARE_RATIO,
} from './constants.ts'
import { formatGap, formatRate, formatShare, measure, startServer } from './harness.ts'

async function throughput(label: string, script: string): Promise<number> {
  const server = await startServer({ label, script: resolve(import.meta.dirname, script) })
  try {
    await measure(server, LOCAL_WARM_UP_DURATION_MS)
    return await measure(server, LOCAL_MEASURE_DURATION_MS)
  } finally {
    await server.stop()
  }
}

const seconds = LOCAL_MEASURE_DURATION_MS / 1_000
console.log(
  `h2load measures each server for ${seconds} s from ${LOAD_THREADS} threads over ${CONNECTIONS} connections, after a warm-up whose figures the script discards.`,
)

const bare = await throughput('uWebSockets.js', 'servers/bare.ts')
console.log(`uWebSockets.js served ${formatRate(bare)}.`)
const uhttp = await throughput('uhttp', 'servers/uhttp.ts')
console.log(`uhttp served ${formatRate(uhttp)}.`)

const comparison = `uhttp is ${formatGap(uhttp / bare - 1)} than uWebSockets.js`
const limit = formatShare(MAX_SLOWDOWN_FROM_BARE_RATIO)
if (uhttp < bare * (1 - MAX_SLOWDOWN_FROM_BARE_RATIO)) {
  console.error(`${comparison}, which is more than the ${limit} limit, so the speed check fails.`)
  process.exitCode = 1
} else {
  console.log(`${comparison}, which is within the ${limit} limit.`)
}
