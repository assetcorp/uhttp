import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach } from 'vitest'

const HOOK = fileURLToPath(new URL('./typescript-hook.ts', import.meta.url))
const HOST = fileURLToPath(new URL('../fixtures/thread-host.ts', import.meta.url))
const START_WAIT_MS = 20_000

export interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface Host {
  readonly port: number
  readonly child: ChildProcess
  readonly exited: Promise<Exit>
  output(): string
  close(): Promise<void>
}

const CLOSE_WAIT_MS = 5_000
const children = new Set<ChildProcess>()

function closeOrKill(child: ChildProcess): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(() => child.kill('SIGKILL'), CLOSE_WAIT_MS)
  child.once('exit', () => {
    clearTimeout(timer)
    resolve()
  })
  if (child.connected) child.send('close')
  else child.kill('SIGKILL')
  return promise
}

afterEach(async () => {
  const running = [...children].filter(child => child.exitCode === null && child.signalCode === null)
  children.clear()
  await Promise.all(running.map(closeOrKill))
})

export function stateDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'uhttp-threads-'))
}

export function startHost(env: Record<string, string>): Promise<Host> {
  const child = spawn(process.execPath, ['--import', HOOK, HOST], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.add(child)
  let output = ''
  const exit = Promise.withResolvers<Exit>()
  child.on('exit', (code, signal) => {
    children.delete(child)
    exit.resolve({ code, signal })
  })
  const { promise, resolve, reject } = Promise.withResolvers<Host>()
  const timer = setTimeout(
    () => reject(new Error(`The host printed no port within ${START_WAIT_MS} ms: ${output}`)),
    START_WAIT_MS,
  )
  const read = (chunk: Buffer): void => {
    output += chunk.toString()
    const match = /\{"port":(\d+)\}/.exec(output)
    if (match === null) return
    clearTimeout(timer)
    resolve({
      port: Number(match[1]),
      child,
      exited: exit.promise,
      output: () => output,
      async close() {
        child.send('close')
        await exit.promise
      },
    })
  }
  child.stdout?.on('data', read)
  child.stderr?.on('data', read)
  void exit.promise.then(({ code, signal }) => {
    clearTimeout(timer)
    reject(new Error(`The host exited with ${code ?? signal} before it printed a port: ${output}`))
  })
  return promise
}

export interface StartEvent {
  readonly time: number
  readonly thread: string
  readonly event: string
}

export function startEvents(directory: string): StartEvent[] {
  return readFileSync(join(directory, 'starts'), 'utf8')
    .trim()
    .split('\n')
    .map(line => {
      const [time = '0', thread = '', event = ''] = line.split(' ')
      return { time: Number(time), thread, event }
    })
}

export function reloadHost(host: Host): Promise<string> {
  host.child.send('reload')
  return waitFor(() => /reload(ed|\sfailed \S+)\n/.exec(host.output())?.[0].trim(), 15_000, 'The reload')
}

export async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  waitMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${waitMs} ms.`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
