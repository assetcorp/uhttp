import { resolve } from 'node:path'
import {
  CONNECTIONS,
  LOCAL_MEASURE_DURATION_MS,
  LOCAL_WARM_UP_DURATION_MS,
  MAX_LOCAL_SLOWDOWN_RATIO,
} from './constants.ts'
import { formatRate, formatShare, measure, startServer } from './harness.ts'

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
  `autocannon measures each server for ${seconds} s at ${CONNECTIONS} connections, after a warm-up whose figures the script discards.`,
)

const bare = await throughput('bare uWebSockets.js', 'servers/bare.ts')
console.log(`Bare uWebSockets.js served ${formatRate(bare)}.`)
const uhttp = await throughput('uhttp', 'servers/uhttp.ts')
console.log(`uhttp served ${formatRate(uhttp)}.`)

const change = uhttp / bare - 1
const comparison = `uhttp is ${formatShare(Math.abs(change))} ${change < 0 ? 'slower' : 'faster'} than bare uWebSockets.js`
const limit = `the limit of a ${formatShare(MAX_LOCAL_SLOWDOWN_RATIO)} slowdown`
if (uhttp < bare * (1 - MAX_LOCAL_SLOWDOWN_RATIO)) {
  console.error(`${comparison}, which is beyond ${limit}.`)
  process.exitCode = 1
} else {
  console.log(`${comparison}, which is inside ${limit}.`)
}
