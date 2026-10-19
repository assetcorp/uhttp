import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  CPU_REPORT_TIMEOUT_MS,
  CPU_USAGE_REQUEST,
  SERVER_START_TIMEOUT_MS,
  SERVER_STOP_TIMEOUT_MS,
} from './constants.ts'
import { pinnedCommand } from './tools.ts'

export interface ServerProcess {
  readonly origin: string
  cpuSeconds(): Promise<number>
  stop(): Promise<void>
}

export interface ServerLaunch {
  readonly label: string
  readonly script: string
  readonly env: Readonly<Record<string, string>>
  readonly cpu: number | null
}

function readPort(child: ChildProcess, label: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const stdout = child.stdout
    if (stdout === null) {
      reject(new Error(`The suite reads the port of the ${label} server from its output, and it started without one.`))
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

function cpuSecondsOf(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const cpuUsage: unknown = Reflect.get(usage, 'cpuUsage')
  if (typeof cpuUsage !== 'object' || cpuUsage === null) return undefined
  const user: unknown = Reflect.get(cpuUsage, 'user')
  const system: unknown = Reflect.get(cpuUsage, 'system')
  if (typeof user !== 'number' || typeof system !== 'number') return undefined
  return (user + system) / 1_000_000
}

function requestCpuSeconds(child: ChildProcess, label: string): Promise<number> {
  return new Promise((resolveSeconds, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage)
      reject(new Error(`The ${label} server reported no CPU time within ${CPU_REPORT_TIMEOUT_MS} ms.`))
    }, CPU_REPORT_TIMEOUT_MS)
    const onMessage = (message: unknown): void => {
      const seconds = cpuSecondsOf(message)
      if (seconds === undefined) return
      clearTimeout(timer)
      child.off('message', onMessage)
      resolveSeconds(seconds)
    }
    child.on('message', onMessage)
    child.send(CPU_USAGE_REQUEST)
  })
}

export async function startServer(launch: ServerLaunch): Promise<ServerProcess> {
  const cpu = launch.cpu === null ? null : String(launch.cpu)
  const [program, args] = pinnedCommand(cpu, process.execPath, [launch.script])
  const child = spawn(program, args, {
    env: { ...process.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  })
  try {
    const port = await readPort(child, launch.label)
    return {
      origin: `http://127.0.0.1:${port}`,
      cpuSeconds: () => requestCpuSeconds(child, launch.label),
      stop: () => stopProcess(child),
    }
  } catch (error) {
    await stopProcess(child)
    throw error
  }
}
