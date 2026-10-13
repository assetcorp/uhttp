import type { AppDescriptor } from 'uWebSockets.js'
import { Worker } from 'node:worker_threads'
import type { CheckedServeOptions } from '../serve/options.js'
import { isWorkerMessage, type WorkerMessage, type WorkerSetup } from './messages.js'
import type { RestartSlot } from './restarts.js'

const WORKER_ENTRY = new URL('./worker.js', import.meta.url)

/**
 * A worker thread moves through these states, from its start to its exit.
 *
 * @internal
 */
export type WorkerState = 'starting' | 'serving' | 'leaving' | 'gone'

/**
 * The supervisor keeps these facts about each worker thread.
 *
 * @internal
 */
export interface WorkerRecord {
  /** The supervisor numbers each worker with this ID. */
  readonly id: number
  /** The worker thread of Node.js. */
  readonly worker: Worker
  /** The worker fills this place in the set of workers, which starts a replacement after a crash. */
  readonly slot: RestartSlot
  /** The promise resolves once the worker has built its app, and rejects when it fails first. */
  readonly ready: PromiseWithResolvers<void>
  /** The promise resolves once the worker has exited. */
  readonly exited: Promise<void>
  /** The worker sets the first element of this shared array to 1 once it has closed its connections. */
  readonly exitFlag: Int32Array
  /** The worker is in this state. */
  state: WorkerState
  /** The app of uWebSockets.js on the worker has this descriptor once the worker has built it. */
  descriptor: AppDescriptor | undefined
  /** The worker last answered a ping at this time from `performance.now()`. */
  lastPong: number
  /** This is `true` while the worker belongs to a reload that has yet to replace the old workers. */
  held: boolean
  /** This is `true` from the moment the worker serves, including while it finishes its connections after a reload. */
  watched: boolean
  /** This is `true` once the watchdog has found that the worker fails to answer. */
  hung: boolean
}

/**
 * The main thread passes each worker these values, apart from the ones that the supervisor adds.
 *
 * @internal
 */
export type SharedSetup = Pick<WorkerSetup, 'module' | 'origin'>

/**
 * The supervisor receives the events of each worker through these functions.
 *
 * @internal
 */
export interface WorkerEvents {
  /** The worker posted a valid message. */
  message(record: WorkerRecord, message: WorkerMessage): void
  /** The worker threw an error that no code caught. */
  error(record: WorkerRecord, error: Error): void
  /** The worker exited with this code. */
  exit(record: WorkerRecord, code: number): void
}

/**
 * Returns a promise that settles with `undefined` once another promise settles either way.
 *
 * @param promise - The package passes the promise.
 * @returns The function returns a promise that never rejects.
 * @internal
 */
export function settled(promise: Promise<void>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  )
}

/**
 * Starts a worker thread with the setup of the server, and passes each of its events on.
 *
 * @param id - The supervisor passes the ID of the worker.
 * @param slot - The supervisor passes the place that the worker fills.
 * @param held - The supervisor passes `true` for a worker of a reload.
 * @param options - The package passes the checked options of the server.
 * @param setup - The package passes the module URL and the origin bytes for every worker.
 * @param events - The supervisor passes the functions that receive the events of the worker.
 * @returns The function returns the record of the worker.
 * @internal
 */
export function startWorker(
  id: number,
  slot: RestartSlot,
  held: boolean,
  options: CheckedServeOptions,
  setup: SharedSetup,
  events: WorkerEvents,
): WorkerRecord {
  const heap = options.workerHeapMb
  const exitFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const workerData: WorkerSetup = { ...setup, tls: options.tls, exitFlag }
  const worker = new Worker(WORKER_ENTRY, {
    workerData,
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
    exitFlag,
    state: 'starting',
    descriptor: undefined,
    lastPong: performance.now(),
    held,
    watched: false,
    hung: false,
  }
  worker.on('message', (message: unknown) => {
    if (isWorkerMessage(message)) events.message(record, message)
  })
  worker.on('error', error => events.error(record, error))
  worker.on('exit', code => {
    events.exit(record, code)
    exit.resolve()
  })
  return record
}
