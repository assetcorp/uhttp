import { afterEach } from 'vitest'
import { type App, type Server, serve } from '../../index.js'

const HOST = '127.0.0.1'

let running: Server[] = []

afterEach(async () => {
  const servers = running
  running = []
  await Promise.all(servers.map(server => server.close()))
})

export async function start(app: App): Promise<Server> {
  const server = await serve({ app, port: 0, host: HOST })
  running.push(server)
  return server
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
