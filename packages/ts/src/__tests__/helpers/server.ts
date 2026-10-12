import { afterEach } from 'vitest'
import { type App, type Server, serve } from '../../index.js'

const HOST = '127.0.0.1'

let running: Server[] = []

afterEach(async () => {
  const servers = running
  running = []
  await Promise.all(servers.map(server => server.close()))
})

export interface PortServer {
  readonly port: number
  close(): Promise<void>
}

export function track(server: Server): PortServer {
  running.push(server)
  const { port } = server
  if (port === undefined) throw new Error('The server listens on no port.')
  return { port, close: () => server.close() }
}

export async function start(app: App): Promise<PortServer> {
  return track(await serve({ app, port: 0, host: HOST }))
}

export function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  details: Record<string, unknown>
  message: string
}

export function memoryLogger(): { entries: LogEntry[]; logger: { info: Log; warn: Log; error: Log } } {
  const entries: LogEntry[] = []
  const record =
    (level: LogEntry['level']): Log =>
    (details, message) => {
      entries.push({ level, details: { ...details }, message })
    }
  return { entries, logger: { info: record('info'), warn: record('warn'), error: record('error') } }
}

type Log = (details: object, message: string) => void
