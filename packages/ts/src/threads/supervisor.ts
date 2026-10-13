import type { AppDescriptor, TemplatedApp } from 'uWebSockets.js'
import { MessageChannel } from 'node:worker_threads'
import { FATAL_EXIT_CODE, WATCHDOG_PINGS_PER_TIMEOUT, WORKER_EXIT_WAIT_MS } from '../constants.js'
import { UhttpError } from '../errors.js'
import { CLOSING, type LeavingMode, RETIRING } from '../native/drain.js'
import { withinGrace } from '../serve/grace.js'
import type { CheckedServeOptions } from '../serve/options.js'
import { closingError, reloadWithoutTlsError } from '../serve/server.js'
import type { Logger } from '../types.js'
import { addExitHook } from './exit-hook.js'
import { type MainMessage, revivedError, type WorkerMessage } from './messages.js'
import { type SharedSetup, settled, startWorker, type WorkerRecord } from './record.js'
import { CrashWindow, RestartSlot } from './restarts.js'

const MIXED_TLS_MESSAGE = 'A worker thread and the main thread serve different protocols, one TLS and one plain HTTP.'
const FAILED_BUILD_MESSAGE = 'A worker thread failed to build the app.'
const STUCK_WORKER_MESSAGE = 'A worker thread is alive after the close, so the main thread stops waiting for it.'

/**
 * The main thread starts the worker threads through this object, which adds the app of each worker
 * to the app of uWebSockets.js that receives the connections. The object also replaces a worker that
 * crashes and pings each worker that serves. On a reload, it replaces every worker, while on a
 * close, it drains every worker.
 *
 * @internal
 */
export class Supervisor {
  readonly #acceptor: TemplatedApp
  readonly #options: CheckedServeOptions
  readonly #setup: SharedSetup
  readonly #logger: Logger
  readonly #crashes: CrashWindow
  readonly #records = new Map<number, WorkerRecord>()
  readonly #live = new Set<AppDescriptor>()
  readonly #startup = Promise.withResolvers<void>()
  #slots: RestartSlot[] = []
  #nextId = 1
  #started = false
  #stopping = false
  #failing = false
  #stopped: Promise<void> | undefined
  #watchdog: NodeJS.Timeout | undefined
  #removeExitHook: () => void = () => undefined
  #beforeExit: () => Promise<void> = async () => undefined

  /**
   * Creates the supervisor of the worker threads.
   *
   * @param acceptor - The package passes the app of uWebSockets.js on the main thread.
   * @param options - The package passes the checked options of the server.
   * @param setup - The package passes the module URL and the origin bytes for every worker.
   */
  constructor(acceptor: TemplatedApp, options: CheckedServeOptions, setup: SharedSetup) {
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
    this.#removeExitHook = addExitHook(() =>
      [...this.#records.values()].map(record => ({
        worker: record.worker,
        exitFlag: record.exitFlag,
        gone: record.state === 'gone',
        hung: record.hung,
      })),
    )
    const first: WorkerRecord[] = []
    for (let index = 0; index < this.#options.threads; index++) {
      const slot = new RestartSlot()
      this.#slots.push(slot)
      first.push(this.#spawn(slot, false))
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
   * Sends every worker the message to drain, and waits until each worker that is not hung exits,
   * for up to {@link WORKER_EXIT_WAIT_MS} past the grace period. The method then marks every worker
   * that is still alive as hung, so that the process can exit without that worker.
   *
   * @returns The promise settles once the workers exit or the wait ends. A second call returns the same promise.
   */
  stop(): Promise<void> {
    this.#stopped ??= this.#stopAll()
    return this.#stopped
  }

  /**
   * Starts a new set of workers with the renewed certificates. Once every new worker serves, the
   * method replaces the old workers with the new ones and lets each old worker finish its requests.
   *
   * @returns The promise resolves once the new workers serve every new connection.
   * @throws {@link UhttpError} with the code `INVALID_SERVE_OPTIONS` on a server without `tls`,
   * `INVALID_CERTIFICATE` when the package fails to load a renewed file, `SERVER_CLOSING` once the
   * server starts to close, and `APP_START_FAILED` when a new worker fails to start, in which case
   * the old workers go on serving.
   */
  async reload(): Promise<void> {
    const { tls } = this.#options
    if (tls === undefined) throw reloadWithoutTlsError()
    this.#checkOpen()
    const { checkCertificates } = await import('../serve/tls.js')
    await checkCertificates(tls)
    this.#checkOpen()
    const slots = this.#slots.map(() => new RestartSlot())
    const batch = slots.map(slot => this.#spawn(slot, true))
    try {
      await Promise.all(batch.map(record => record.ready.promise))
      this.#checkOpen()
    } catch (error) {
      for (const slot of slots) slot.stop()
      for (const record of batch) this.#retire(record, CLOSING)
      if (error instanceof UhttpError && error.code === 'SERVER_CLOSING') throw error
      const message = 'A new worker thread failed while the server reloaded.'
      throw new UhttpError('APP_START_FAILED', message, { cause: error })
    }
    for (const slot of this.#slots) slot.stop()
    for (const record of this.#records.values()) {
      if (!batch.includes(record)) this.#retire(record, RETIRING)
    }
    this.#slots = slots
    for (const record of batch) {
      record.held = false
      if (record.state === 'starting') this.#activate(record)
      else this.#replaceLater(record)
    }
  }

  #checkOpen(): void {
    if (this.#stopping) throw closingError()
  }

  #replaceLater(record: WorkerRecord): void {
    record.slot.replace(() => {
      if (!this.#stopping) this.#spawn(record.slot, false)
    })
  }

  async #stopAll(): Promise<void> {
    this.#stopping = true
    clearInterval(this.#watchdog)
    for (const slot of this.#slots) slot.stop()
    const records = [...this.#records.values()]
    for (const record of records) this.#retire(record, CLOSING)
    const exits = records.filter(record => !record.hung).map(record => record.exited)
    await withinGrace(Promise.all(exits), this.#options.gracePeriodMs + WORKER_EXIT_WAIT_MS)
    for (const record of records) {
      if (record.state === 'gone') continue
      if (!record.hung) this.#log(STUCK_WORKER_MESSAGE, { worker: record.id })
      record.hung = true
      record.worker.unref()
    }
    this.#removeExitHook()
  }

  #spawn(slot: RestartSlot, held: boolean): WorkerRecord {
    const record = startWorker(this.#nextId++, slot, held, this.#options, this.#setup, {
      message: (worker, message) => this.#receive(worker, message),
      error: (worker, error) => this.#lost(worker, error, 'A worker thread failed.'),
      exit: (worker, code) => {
        this.#lost(worker, new Error(`The worker thread exited with code ${code}.`), 'A worker thread exited.')
        worker.state = 'gone'
        this.#records.delete(worker.id)
      },
    })
    this.#records.set(record.id, record)
    return record
  }

  #post(record: WorkerRecord, message: MainMessage): void {
    if (record.state !== 'gone') record.worker.postMessage(message)
  }

  #receive(record: WorkerRecord, message: WorkerMessage): void {
    switch (message.type) {
      case 'ready':
        this.#ready(record, message.descriptor, message.secure)
        return
      case 'failed':
        this.#lost(record, revivedError(message.error), FAILED_BUILD_MESSAGE)
        return
      case 'crashed':
        this.#lost(record, revivedError(message.error), 'A worker thread crashed.')
        return
      case 'pong':
        record.lastPong = performance.now()
    }
  }

  #ready(record: WorkerRecord, descriptor: AppDescriptor, secure: boolean): void {
    if (record.state !== 'starting') return
    record.descriptor = descriptor
    if (secure !== (this.#options.tls !== undefined)) {
      this.#lost(record, new UhttpError('APP_START_FAILED', MIXED_TLS_MESSAGE), FAILED_BUILD_MESSAGE)
      this.#retire(record, CLOSING)
      return
    }
    if (this.#stopping) {
      this.#retire(record, CLOSING)
      return
    }
    if (!record.held) this.#activate(record)
    record.ready.resolve()
  }

  #activate(record: WorkerRecord): void {
    const { descriptor } = record
    if (record.state !== 'starting' || descriptor === undefined) return
    record.state = 'serving'
    record.watched = true
    record.lastPong = performance.now()
    if (!this.#live.has(descriptor)) {
      this.#live.add(descriptor)
      this.#acceptor.addChildAppDescriptor(descriptor)
    }
    this.#connectPeers(record)
    record.slot.serving()
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

  #retire(record: WorkerRecord, mode: LeavingMode): void {
    if (record.state === 'gone') return
    this.#removeDescriptor(record)
    record.state = 'leaving'
    record.ready.reject(closingError())
    this.#post(record, { type: 'drain', mode, graceMs: this.#options.gracePeriodMs })
  }

  #lost(record: WorkerRecord, error: unknown, message: string): void {
    const { state } = record
    this.#removeDescriptor(record)
    record.watched = false
    if (state === 'gone' || state === 'leaving') return
    record.state = 'leaving'
    if (!this.#started || this.#stopping) {
      record.ready.reject(error)
      if (!this.#started) this.#startup.reject(error)
      return
    }
    this.#log(message, { err: error, worker: record.id })
    if (record.held) {
      record.ready.reject(error)
      return
    }
    if (this.#crashes.record(performance.now())) {
      this.#fail(`Worker threads crashed ${this.#options.crashLimit} times within ${this.#options.crashWindowMs} ms.`)
      return
    }
    if (!this.#anyAlive()) {
      this.#fail('Every worker thread is dead.')
      return
    }
    this.#replaceLater(record)
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
      if (!record.watched || record.hung) continue
      if (now - record.lastPong > watchdogMs) {
        this.#removeDescriptor(record)
        record.state = 'leaving'
        record.hung = true
        this.#log(`A worker thread sent no reply to a ping for ${watchdogMs} ms.`, { worker: record.id })
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
    if (this.#stopping || this.#failing) return
    this.#failing = true
    clearInterval(this.#watchdog)
    this.#log(`${reason} The server exits with an error.`, { exitCode: FATAL_EXIT_CODE })
    void this.#exit()
  }

  async #exit(): Promise<void> {
    await settled(this.#beforeExit())
    await this.stop()
    process.exit(FATAL_EXIT_CODE)
  }
}
