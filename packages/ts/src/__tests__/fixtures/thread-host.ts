import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve, type TlsOptions } from '../../index.js'

const stateDirectory = process.env.UHTTP_FIXTURE_DIR
const numbersFrom = (names: Record<string, string>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(names).flatMap(([option, name]) => {
      const value = process.env[name]
      return value === undefined ? [] : [[option, Number(value)]]
    }),
  )

function tlsFrom(directory: string | undefined): TlsOptions | undefined {
  if (directory === undefined) return undefined
  const hostnames = (process.env.UHTTP_TLS_HOSTNAMES ?? '').split(',').filter(hostname => hostname !== '')
  const files = (name: string) => ({
    keyFile: join(directory, `${name}.key`),
    certFile: join(directory, `${name}.crt`),
  })
  return {
    ...files('default'),
    hostnames: Object.fromEntries(hostnames.map(hostname => [hostname, files(hostname)])),
  }
}

if (stateDirectory !== undefined) appendFileSync(join(stateDirectory, 'host'), `${process.pid}\n`)

const tls = tlsFrom(process.env.UHTTP_TLS_DIR)
const server = await serve({
  app: new URL(process.env.UHTTP_FIXTURE_APP ?? './thread-app.js', import.meta.url),
  port: 0,
  host: '127.0.0.1',
  threads: Number(process.env.UHTTP_THREADS ?? '2'),
  ...(tls === undefined ? {} : { tls }),
  ...numbersFrom({
    watchdogMs: 'UHTTP_WATCHDOG_MS',
    crashLimit: 'UHTTP_CRASH_LIMIT',
    crashWindowMs: 'UHTTP_CRASH_WINDOW_MS',
    workerHeapMb: 'UHTTP_WORKER_HEAP_MB',
    gracePeriodMs: 'UHTTP_GRACE_PERIOD_MS',
    workerStartTimeoutMs: 'UHTTP_WORKER_START_TIMEOUT_MS',
  }),
})

process.stdout.write(`${JSON.stringify({ port: server.port })}\n`)
process.on('message', async message => {
  if (message === 'exit') process.exit(0)
  if (message === 'reload') {
    try {
      await server.reload()
      process.stdout.write('reloaded\n')
    } catch (error) {
      process.stdout.write(`reload failed ${String(Reflect.get(Object(error), 'code'))}\n`)
    }
    return
  }
  if (message !== 'close') return
  await server.close()
  process.stdout.write('closed\n')
  process.disconnect?.()
})
