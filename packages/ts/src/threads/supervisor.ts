import type { AppDescriptor, TemplatedApp } from 'uWebSockets.js'
import { MessageChannel, Worker } from 'node:worker_threads'
import { FATAL_EXIT_CODE, FATAL_LEAVE_WAIT_MS, WATCHDOG_PINGS_PER_TIMEOUT } from '../constants.js'
import { UhttpError } from '../errors.js'
import type { CheckedServeOptions } from '../serve/options.js'
import type { Logger } from '../types.js'
import { isWorkerMessage, type MainMessage, revivedError, type WorkerMessage, type WorkerSetup } from './messages.js'
import { CrashWindow, RestartSlot } from './restarts.js'

const WORKER_ENTRY = new URL('./worker.js', import.meta.url)

type WorkerState = 'starting' | 'serving' | 'leaving' | 'gone'

interface WorkerRecord {
  readonly id: number
  readonly worker: Worker
  readonly slot: RestartSlot
  readonly ready: PromiseWithResolvers<void>
  readonly exited: Promise<void>
  state: WorkerState
  descriptor: AppDescriptor | undefined
  lastPong: number
}

function settled(promise: Promise<void>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms).unref())
}

/**
 * The main thread starts the worker threads through this object, which adds the app of each worker
 * to the app of uWebSockets.js that accepts the connections. The object also replaces a worker that
 * crashes, and it pings each worker that serves.
 *
 * @internal
 */
export class Supervisor {
  readonly #acceptor: TemplatedApp
  readonly #options: CheckedServeOptions
  readonly #setup: WorkerSetup
  readonly #logger: Logger
  readonly #crashes: CrashWindow
  readonly #records = new Map<number, WorkerRecord>()
  readonly #live = new Set<AppDescriptor>()
  readonly #slots: RestartSlot[] = []
  readonly #startup = Promise.withResolvers<void>()
  #nextId = 1
  #started = false
  #stopping = false
  #watchdog: NodeJS.Timeout | undefined
  #beforeExit: () => Promise<void> = async () => undefined

  /**
   * Creates the supervisor of the worker threads.
   *
   * @param acceptor - The package passes the app of uWebSockets.js on the main thread.
   * @param options - The package passes the checked options of the server.
   * @param setup - The package passes the module URL and the origin bytes for every worker.
   */
  constructor(acceptor: TemplatedApp, options: CheckedServeOptions, setup: WorkerSetup) {
    this.#acceptor = acceptor
    this.#options = options
    this.#setup = setup
    this.#logger = options.logger
    this.#crashes = new CrashWindow(options.crashLimit, options.crashWindowMs)
  }

  /**
   * Starts every worker and waits until each one serves. When a worker fails to build its app, or
   * crashes before every other worker serves, the method stops every worker before it throws.
   *
   * @returns The promise resolves once every worker serves.
   * @throws {@link UhttpError} with the code `APP_START_FAILED` when a worker fails or crashes during
   * the start, with the error of the worker as the cause.
   */
  async start(): Promise<void> {
    void settled(this.#startup.promise)
    const first: WorkerRecord[] = []
    for (let index = 0; index < this.#options.threads; index++) {
      const slot = new RestartSlot()
      this.#slots.push(slot)
      first.push(this.#spawn(slot))
    }
    try {
      await Promise.race([Promise.all(first.map(record => record.ready.promise)), this.#startup.promise])
    } catch (error) {
      await this.stop()
      throw new UhttpError('APP_START_FAILED', 'A worker thread failed while the server started.', { cause: error })
    }
    this.#started = true
    this.#startWatchdog()
  }

  /**
   * Sets the function that the supervisor calls before the process exits with an error, such as
   * one that closes the listening socket.
   *
   * @param beforeExit - The package passes the function.
   */
  onFatal(beforeExit: () => Promise<void>): void {
    this.#beforeExit = beforeExit
  }

  /**
   * Asks every worker to leave, and waits until each one has exited.
   *
   * @returns The promise settles once every worker has exited.
   */
  async stop(): Promise<void> {
    this.#stopping = true
    clearInterval(this.#watchdog)
    for (const slot of this.#slots) slot.stop()
    const records = [...this.#records.values()]
    for (const record of records) this.#askToLeave(record)
    await Promise.all(records.map(record => record.exited))
  }

  #spawn(slot: RestartSlot): WorkerRecord {
    const id = this.#nextId++
    const heap = this.#options.workerHeapMb
    const worker = new Worker(WORKER_ENTRY, {
      workerData: this.#setup,
      resourceLimits: heap === undefined ? undefined : { maxOldGenerationSizeMb: heap },
    })
    const ready = Promise.withResolvers<void>()
    void settled(ready.promise)
    const exit = Promise.withResolvers<void>()
    const record: WorkerRecord = {
      id,
      worker,
      slot,
      ready,
      exited: exit.promise,
      state: 'starting',
      descriptor: undefined,
      lastPong: performance.now(),
    }
    this.#records.set(id, record)
    worker.on('message', (message: unknown) => {
      if (isWorkerMessage(message)) this.#receive(record, message)
    })
    worker.on('error', error => this.#lost(record, error, 'A worker thread failed.'))
    worker.on('exit', code => {
      this.#lost(record, new Error(`The worker thread exited with code ${code}.`), 'A worker thread exited.')
      record.state = 'gone'
      this.#records.delete(id)
      exit.resolve()
    })
    return record
  }

  #post(record: WorkerRecord, message: MainMessage): void {
    if (record.state !== 'gone') record.worker.postMessage(message)
  }

  #receive(record: WorkerRecord, message: WorkerMessage): void {
    switch (message.type) {
      case 'ready':
        this.#serve(record, message.descriptor)
        return
      case 'failed':
        this.#lost(record, revivedError(message.error), 'A worker thread failed to build the app.')
        return
      case 'crashed':
        this.#lost(record, revivedError(message.error), 'A worker thread crashed.')
        return
      case 'pong':
        record.lastPong = performance.now()
        return
      case 'leaving':
        this.#removeDescriptor(record)
        this.#post(record, { type: 'left' })
    }
  }

  #serve(record: WorkerRecord, descriptor: AppDescriptor): void {
    if (record.state !== 'starting') return
    if (this.#stopping) {
      record.descriptor = descriptor
      this.#askToLeave(record)
      return
    }
    record.state = 'serving'
    record.descriptor = descriptor
    record.lastPong = performance.now()
    if (!this.#live.has(descriptor)) {
      this.#live.add(descriptor)
      this.#acceptor.addChildAppDescriptor(descriptor)
    }
    this.#connectPeers(record)
    record.slot.serving()
    record.ready.resolve()
  }

  #connectPeers(record: WorkerRecord): void {
    for (const other of this.#records.values()) {
      if (other === record || other.state !== 'serving') continue
      const { port1, port2 } = new MessageChannel()
      record.worker.postMessage({ type: 'peer', id: other.id, port: port1 } satisfies MainMessage, [port1])
      other.worker.postMessage({ type: 'peer', id: record.id, port: port2 } satisfies MainMessage, [port2])
    }
  }

  #removeDescriptor(record: WorkerRecord): void {
    const { descriptor } = record
    if (descriptor === undefined) return
    record.descriptor = undefined
    if (!this.#live.delete(descriptor)) return
    this.#acceptor.removeChildAppDescriptor(descriptor)
    for (const other of this.#records.values()) {
      if (other !== record && other.state === 'serving') this.#post(other, { type: 'peer-gone', id: record.id })
    }
  }

  #askToLeave(record: WorkerRecord): void {
    if (record.state === 'gone' || record.state === 'leaving') return
    record.state = 'leaving'
    this.#post(record, { type: 'leave' })
  }

  #lost(record: WorkerRecord, error: unknown, message: string): void {
    const { state } = record
    this.#removeDescriptor(record)
    if (state === 'gone' || state === 'leaving') return
    record.state = 'leaving'
    if (!this.#started || this.#stopping) {
      record.ready.reject(error)
      this.#startup.reject(error)
      return
    }
    this.#log(message, { err: error, worker: record.id })
    if (this.#crashes.record(performance.now())) {
      this.#fail(`Worker threads crashed ${this.#options.crashLimit} times within ${this.#options.crashWindowMs} ms.`)
      return
    }
    if (!this.#anyAlive()) {
      this.#fail('Every worker thread is dead.')
      return
    }
    record.slot.replace(() => {
      if (!this.#stopping) this.#spawn(record.slot)
    })
  }

  #anyAlive(): boolean {
    for (const record of this.#records.values()) {
      if (record.state === 'starting' || record.state === 'serving') return true
    }
    return false
  }

  #startWatchdog(): void {
    const { watchdogMs } = this.#options
    if (watchdogMs === 0) return
    const interval = Math.max(1, Math.floor(watchdogMs / WATCHDOG_PINGS_PER_TIMEOUT))
    this.#watchdog = setInterval(() => this.#checkWorkers(watchdogMs), interval)
  }

  #checkWorkers(watchdogMs: number): void {
    const now = performance.now()
    for (const record of this.#records.values()) {
      if (record.state !== 'serving') continue
      if (now - record.lastPong > watchdogMs) {
        this.#removeDescriptor(record)
        record.state = 'leaving'
        this.#log(`A worker thread failed to answer for ${watchdogMs} ms.`, { worker: record.id })
        this.#fail('A worker thread hangs.')
        return
      }
      this.#post(record, { type: 'ping' })
    }
  }

  #log(message: string, details: object): void {
    try {
      this.#logger.error(details, message)
    } catch {
      return
    }
  }

  #fail(reason: string): void {
    if (this.#stopping) return
    this.#stopping = true
    clearInterval(this.#watchdog)
    this.#log(`${reason} The server exits with an error.`, { exitCode: FATAL_EXIT_CODE })
    void this.#exit()
  }

  async #exit(): Promise<void> {
    await settled(this.#beforeExit())
    await Promise.race([this.stop(), sleep(FATAL_LEAVE_WAIT_MS)])
    process.exit(FATAL_EXIT_CODE)
  }
}
