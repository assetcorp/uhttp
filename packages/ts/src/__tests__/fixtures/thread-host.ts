import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '../../index.js'

const stateDirectory = process.env.UHTTP_FIXTURE_DIR
const numbersFrom = (names: Record<string, string>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(names).flatMap(([option, name]) => {
      const value = process.env[name]
      return value === undefined ? [] : [[option, Number(value)]]
    }),
  )

if (stateDirectory !== undefined) appendFileSync(join(stateDirectory, 'host'), `${process.pid}\n`)

const server = await serve({
  app: new URL(process.env.UHTTP_FIXTURE_APP ?? './thread-app.js', import.meta.url),
  port: 0,
  host: '127.0.0.1',
  threads: Number(process.env.UHTTP_THREADS ?? '2'),
  ...numbersFrom({
    watchdogMs: 'UHTTP_WATCHDOG_MS',
    crashLimit: 'UHTTP_CRASH_LIMIT',
    crashWindowMs: 'UHTTP_CRASH_WINDOW_MS',
    workerHeapMb: 'UHTTP_WORKER_HEAP_MB',
  }),
})

process.stdout.write(`${JSON.stringify({ port: server.port })}\n`)
process.on('message', async message => {
  if (message !== 'close') return
  await server.close()
  process.stdout.write('closed\n')
  process.disconnect?.()
})
