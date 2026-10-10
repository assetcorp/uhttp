import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import autocannon from 'autocannon'
import {
  CONNECTIONS,
  LOAD_WORKERS,
  ROUTE_BODY,
  ROUTE_PATH,
  SERVER_START_TIMEOUT_MS,
  SERVER_STOP_TIMEOUT_MS,
} from './constants.ts'

export interface ServerSpec {
  label: string
  script: string
  env?: Record<string, string>
  cpu?: number
}

export interface RunningServer {
  label: string
  url: string
  stop(): Promise<void>
}

function readPort(child: ChildProcess, label: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const stdout = child.stdout
    if (stdout === null) {
      reject(new Error(`The ${label} server has no standard output, so the script has no way to get its port.`))
      return
    }
    const lines = createInterface({ input: stdout })
    const cleanUp = (): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      lines.close()
      stdout.resume()
    }
    const fail = (error: Error): void => {
      cleanUp()
      reject(error)
    }
    const onExit = (code: number | null): void => {
      fail(new Error(`The ${label} server exited with code ${code} before it printed its port.`))
    }
    const timer = setTimeout(() => {
      fail(new Error(`The ${label} server printed no port within ${SERVER_START_TIMEOUT_MS} ms.`))
    }, SERVER_START_TIMEOUT_MS)
    child.once('exit', onExit)
    lines.once('line', line => {
      const report: unknown = JSON.parse(line)
      const port: unknown = typeof report === 'object' && report !== null ? Reflect.get(report, 'port') : undefined
      if (typeof port !== 'number') {
        fail(new Error(`The ${label} server printed '${line}' in place of its port.`))
        return
      }
      cleanUp()
      resolvePort(port)
    })
  })
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolveStop => {
    const timer = setTimeout(() => child.kill('SIGKILL'), SERVER_STOP_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    child.kill('SIGTERM')
  })
}

export async function startServer(spec: ServerSpec): Promise<RunningServer> {
  const command = [process.execPath, spec.script]
  const pinned = spec.cpu === undefined ? command : ['taskset', '-c', String(spec.cpu), ...command]
  const [program = process.execPath, ...args] = pinned
  const child = spawn(program, args, { env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const port = await readPort(child, spec.label)
    const url = `http://127.0.0.1:${port}${ROUTE_PATH}`
    const response = await fetch(url, { signal: AbortSignal.timeout(SERVER_START_TIMEOUT_MS) })
    const body = await response.text()
    if (body !== ROUTE_BODY) {
      throw new Error(`The ${spec.label} server sent the body '${body}' in place of '${ROUTE_BODY}'.`)
    }
    return { label: spec.label, url, stop: () => stopProcess(child) }
  } catch (error) {
    await stopProcess(child)
    throw error
  }
}

export async function measure(server: RunningServer, durationMs: number): Promise<number> {
  const result = await autocannon({
    url: server.url,
    connections: CONNECTIONS,
    duration: durationMs / 1_000,
    workers: LOAD_WORKERS,
    expectBody: ROUTE_BODY,
  })
  const failures = result.errors + result.timeouts + result.non2xx + result.mismatches
  if (failures > 0 || result.requests.total === 0) {
    throw new Error(`${failures} of ${result.requests.total} requests to the ${server.label} server failed.`)
  }
  return result.requests.average
}

export function formatRate(requestsPerSecond: number): string {
  return `${Math.round(requestsPerSecond).toLocaleString('en-GB')} req/s`
}

export function formatShare(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

export function formatSignedPercent(ratio: number): string {
  return `${ratio > 0 ? '+' : ''}${formatShare(ratio)}`
}
