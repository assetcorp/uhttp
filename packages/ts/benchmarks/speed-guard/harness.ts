import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import {
  CONNECTIONS,
  LOAD_THREADS,
  LOAD_TIMEOUT_GRACE_MS,
  ROUTE_BODY,
  ROUTE_PATH,
  SERVER_START_TIMEOUT_MS,
  SERVER_STOP_TIMEOUT_MS,
} from './constants.ts'

const runFile = promisify(execFile)

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
      reject(
        new Error(
          `The script reads the port of the ${label} server from its standard output, and that server started without one.`,
        ),
      )
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
      fail(new Error(`The ${label} server took longer than ${SERVER_START_TIMEOUT_MS} ms to print its port.`))
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

async function runH2load(args: readonly string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await runFile('h2load', args, { timeout: timeoutMs })
    return stdout
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'Install h2load before you run the speed check, because the check sends its requests with h2load: brew install nghttp2 on macOS, or sudo apt-get install nghttp2-client on Ubuntu.',
      )
    }
    throw error
  }
}

function countIn(output: string, pattern: RegExp, label: string): number {
  const digits = pattern.exec(output)?.[1]
  if (digits === undefined) throw new Error(`h2load printed no count of ${label}:\n${output}`)
  return Number(digits)
}

export async function measure(server: RunningServer, durationMs: number): Promise<number> {
  const seconds = durationMs / 1_000
  const args = ['--h1', '-t', String(LOAD_THREADS), '-c', String(CONNECTIONS), '-D', String(seconds), server.url]
  const output = await runH2load(args, durationMs + LOAD_TIMEOUT_GRACE_MS)
  const failed = countIn(output, /^requests:.*?(\d+) failed/m, 'failed requests')
  const redirected = countIn(output, /^status codes:.*?(\d+) 3xx/m, 'responses with a 3xx status')
  if (failed > 0 || redirected > 0) {
    throw new Error(
      `h2load counted ${failed} failed requests and ${redirected} responses with a 3xx status on the ${server.label} server.`,
    )
  }
  const rate = countIn(output, /^finished in [^,]+, ([\d.]+) req\/s/m, 'requests a second')
  if (rate <= 0) throw new Error(`h2load measured 0 requests a second on the ${server.label} server.`)
  return rate
}

export function formatRate(requestsPerSecond: number): string {
  return `${Math.round(requestsPerSecond).toLocaleString('en-GB')} req/s`
}

export function formatShare(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

export function formatGap(ratio: number): string {
  return `${formatShare(Math.abs(ratio))} ${ratio < 0 ? 'slower' : 'faster'}`
}
